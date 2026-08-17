/**
 * 方案四·第七扇门(密室逃脱,路线图阶段 2)。
 *
 * 确定性谜题引擎:房间状态机 + 道具图 + 谜题规则函数为唯一真相,
 * LLM 只负责叙事包装与意图解析。裁决全部为纯函数,可单测全量覆盖
 * (docs/04-escape-room.md §5.1)。
 *
 * 设计要点:
 *   - 谜底/配方/机关依赖全部封存于 truth 文件,永不进入 GM 上下文;
 *   - 所有世界变更必须经过本引擎的动作函数(examine/take/use/combine/
 *     manipulate/solve),LLM 只能"提议",引擎"决定";
 *   - 三层提示由引擎按进度给出,提示文案不含答案;
 *   - 暴力猜谜(未获得线索即解出)在结算中标注并扣"推理质量"分。
 */

import type { GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { hashString, mulberry32 } from '../core/rand.js'
import type { SchemeEngine } from '../core/manager.js'

// ── 数据模型(真相,封存) ──────────────────────────────────────────────────────

export type EscapeEffect =
  | { kind: 'setProp'; prop: string; state: string }
  | { kind: 'addItem'; item: string }
  | { kind: 'removeItem'; item: string }
  | { kind: 'setItemState'; item: string; state: string }
  | { kind: 'openDoor'; door: string }
  | { kind: 'moveRoom'; to: string }
  | { kind: 'event'; event: string }
  | { kind: 'win' }

interface Req {
  /** 玩家背包中须有该物品。 */
  item?: string
  /** 机关须处于该状态。 */
  prop?: { id: string; state: string }
  /** 玩家须身处该房间。 */
  room?: string
  /** 该谜题须已解开。 */
  puzzle?: string
}

export interface EscapeRoom {
  id: string
  name: string
  desc: string
}

export interface EscapeProp {
  id: string
  name: string
  roomId: string
  desc: string
  defaultState: string
  /** 各状态下的补充描述(examine 时按当前状态追加)。 */
  states?: Record<string, string>
  /** 挂在机关上的谜题(如西洋钟)。 */
  puzzle?: string
}

export interface EscapeDoor {
  id: string
  from: string
  to: string
  name: string
  lockedBy?: { kind: 'item'; item: string; hint: string } | { kind: 'puzzle'; puzzle: string; hint: string }
  /** 门上的谜题(如密码面板),examine 时展示谜面。 */
  puzzle?: string
}

export interface EscapeItem {
  id: string
  name: string
  desc: string
  /** 初始位置;'__nowhere' = 由配方/机关产出。 */
  roomId: string
  /** 藏在某机关里,该机关达到 hiddenState 后可见。 */
  hiddenIn?: string
  hiddenState?: string
}

export interface EscapePuzzle {
  id: string
  name: string
  prompt: string
  /** 谜底(封存)。 */
  answer: string
  /** 玩家须先获得的线索事件/物品(未满足即解出 → 记暴力猜谜)。 */
  clueEvents?: string[]
  clueItems?: string[]
  onSolve: EscapeEffect[]
  solveNarrative: string
  hints: [string, string, string]
}

export interface EscapeManip {
  id: string
  target: string
  /** 命中关键词(玩家动作原文包含其一)。 */
  keywords: string[]
  requires: Req[]
  effects: EscapeEffect[]
  narrative: string
  /** 匹配到但前置不满足时的反馈。 */
  blocked?: string
  /** 匹配到且前置满足但刻意无效果(红鲱鱼动作)。 */
  alwaysBlocked?: string
  /** 触发后记录的线索事件(用于暴力猜谜审计)。 */
  clue?: string
}

export interface EscapeRecipe {
  id: string
  a: string
  b: string
  effects: EscapeEffect[]
  narrative: string
}

export interface EscapeUse {
  id: string
  item: string
  /** 作用的机关或门。 */
  on: string
  requires: Req[]
  effects: EscapeEffect[]
  narrative: string
  blocked?: string
}

export interface EscapeScenario {
  id: string
  title: string
  difficulty: number
  intro: string
  rooms: EscapeRoom[]
  props: EscapeProp[]
  doors: EscapeDoor[]
  items: EscapeItem[]
  puzzles: EscapePuzzle[]
  manips: EscapeManip[]
  recipes: EscapeRecipe[]
  uses: EscapeUse[]
  /** 谜题推进顺序(提示服务按此选择下一未解谜题)。 */
  puzzleOrder: string[]
  /** 终局真相:完整脱出路径。 */
  walkthrough: string[]
}

// ── 游戏状态 ──────────────────────────────────────────────────────────────────

export interface EscapeState extends GameStateBase {
  scheme: 'escape'
  scenarioId: string
  roomId: string
  inventory: string[]
  propStates: Record<string, string>
  itemStates: Record<string, string>
  openDoors: string[]
  solved: string[]
  /** 已获得的线索事件 id。 */
  clues: string[]
  /** 未获得线索即解出的谜题(暴力猜谜)。 */
  bruteForce: string[]
  wrongAttempts: number
  /** 每谜题的提示购买次数(决定层级)。 */
  puzzleHints: Record<string, number>
}

// ── 场景组装(共享片段 + 难度变体) ────────────────────────────────────────────

const ROOM_ATTIC: EscapeRoom = {
  id: 'attic',
  name: '阁楼',
  desc: '一间狭长的阁楼。斜窗锁着,窗闩锈成深褐色;壁炉积着冷灰,墙角立着一面蒙尘的镜子,靠墙有一张旧书桌,旁边是一座停摆的西洋钟。唯一通往下层的门上了锁。',
}

const ROOM_STUDY: EscapeRoom = {
  id: 'study',
  name: '书房',
  desc: '一间书房,四壁都是到顶的书架,中央一张写字台,墙上挂着一幅微微歪斜的油画,门边立着一只青瓷花瓶,角落是一个带锁的陈列柜。',
}

const ROOM_CELLAR: EscapeRoom = {
  id: 'cellar',
  name: '地窖',
  desc: '黑暗潮湿的地窖,霉味扑鼻。你什么都看不清,只摸到墙上有支火把。',
}

const ROOM_VAULT: EscapeRoom = {
  id: 'vault',
  name: '密室',
  desc: '最后一间密室。正对着你的,是第七扇门——门上一块黄铜面板,刻着三个 0-9 的旋钮。',
}

const PROPS_SHARED: EscapeProp[] = [
  {
    id: 'p_fireplace',
    name: '壁炉',
    roomId: 'attic',
    desc: '壁炉积着冷灰,冷灰下有一块凸起的砖,炉膛深处反着一点微光。',
    defaultState: 'unlit',
    states: {
      unlit: '炉膛是冷的,似乎需要火。',
      lit: '炉火熊熊,头顶的烟囱盖弹开了,一束天光斜斜灌下,落在墙角的镜子上。',
    },
  },
  {
    id: 'p_mirror',
    name: '镜子',
    roomId: 'attic',
    desc: '一面蒙尘的镜子,立在墙角。',
    defaultState: 'idle',
    states: {
      idle: '镜子正对着墙,没有光。',
      rotated: '镜子被扳过一个角度,把天光折向书桌,光斑停在桌面的凹痕上——桌面弹开了。',
    },
  },
  {
    id: 'p_desk',
    name: '书桌',
    roomId: 'attic',
    desc: '一张旧书桌,桌面上有一处不起眼的凹痕。',
    defaultState: 'closed',
    states: {
      closed: '桌面纹丝不动,似乎藏着暗格。',
      open: '桌面的暗格弹开了,里面有一把冻在冰块里的铜钥匙和半张纸条。',
    },
  },
  {
    id: 'p_clock',
    name: '西洋钟',
    roomId: 'attic',
    desc: '一座西洋钟,指针停在四点半,底座上有一圈可旋动的刻盘。',
    defaultState: 'stopped',
    puzzle: 'p_clock',
    states: {
      stopped: '刻盘可以旋动,似乎等着一个数字。',
      solved: '钟底座弹开一道窄缝,里面躺着一把银钥匙。',
    },
  },
  {
    id: 'p_window',
    name: '斜窗',
    roomId: 'attic',
    desc: '一面斜窗,窗闩锈成了深褐色。',
    defaultState: 'locked',
    states: { locked: '窗闩锈死了。' },
  },
  {
    id: 'p_cabinet',
    name: '陈列柜',
    roomId: 'study',
    desc: '一个带锁的陈列柜,玻璃后头好像有纸张。',
    defaultState: 'closed',
    states: {
      closed: '柜门锁着,需要一把小巧的钥匙。',
      open: '陈列柜开了,里面有一张诗页。',
    },
  },
  {
    id: 'p_painting',
    name: '挂画',
    roomId: 'study',
    desc: '一幅油画,画的是一座老宅的大门,挂得微微歪斜。',
    defaultState: 'tilted',
    states: {
      tilted: '画有点歪,后面似乎挡着什么。',
      straightened: '画被扶正了,墙上露出一行刻痕:「第七扇门后,藏着最后一个数字 7。」',
    },
  },
  {
    id: 'p_vase',
    name: '花瓶',
    roomId: 'study',
    desc: '一只青瓷花瓶,插着几支干枯的花,瓶身沉甸甸的。',
    defaultState: 'upright',
    states: {
      upright: '花瓶稳稳立着,里面好像有东西。',
      tilted: '花瓶被放倒了,里面滚出一把黄铜钥匙。',
    },
  },
  {
    id: 'p_shelf',
    name: '书架',
    roomId: 'study',
    desc: '一架到顶的书架,书脊蒙灰,其中一本诗集微微凸出。',
    defaultState: 'idle',
    states: { idle: '你抽了抽那本诗集——是装饰,抽不出来。' },
  },
  {
    id: 'p_desk2',
    name: '写字台',
    roomId: 'study',
    desc: '一张写字台,台面摊着一本账本,最后几页被撕掉了。',
    defaultState: 'idle',
    states: { idle: '账本上只记着些无关紧要的旧账。' },
  },
  {
    id: 'p_torch',
    name: '火把',
    roomId: 'cellar',
    desc: '墙上的火把,没有点着。',
    defaultState: 'unlit',
    states: {
      unlit: '火把是冷的,可以点着。',
      lit: '火把燃起来了,照亮整个地窖——角落里有一块活板门。',
    },
  },
  {
    id: 'p_trapdoor',
    name: '活板门',
    roomId: 'cellar',
    desc: '地窖角落的一块活板门,通往更深处。',
    defaultState: 'closed',
    states: { closed: '活板门紧闭,但看起来可以从这里离开地窖。' },
  },
  {
    id: 'p_final_door',
    name: '第七扇门',
    roomId: 'vault',
    desc: '第七扇门,黄铜面板上刻着繁复的花纹,门闩从外面扣着。',
    defaultState: 'locked',
    states: {
      locked: '门闩扣着,但已经可以从这边推开了。',
      open: '门开了,外面是久违的夜风。',
    },
  },
]

const ITEMS_SHARED: EscapeItem[] = [
  {
    id: 'matches',
    name: '一盒火柴',
    roomId: 'attic',
    desc: '火柴盒里还剩大半盒火柴,擦一下就能点着。',
  },
  {
    id: 'copper_key_frozen',
    name: '冻住的铜钥匙',
    roomId: 'attic',
    hiddenIn: 'p_desk',
    hiddenState: 'open',
    desc: '一把铜钥匙被冻在一块冰块里,齿纹若隐若现。',
  },
  {
    id: 'copper_key',
    name: '铜钥匙',
    roomId: '__nowhere',
    desc: '齿纹古朴的铜钥匙,握在手里沉甸甸的。',
  },
  {
    id: 'half_note',
    name: '半张纸条',
    roomId: 'attic',
    hiddenIn: 'p_desk',
    hiddenState: 'open',
    desc: '焦黄的纸片只剩右半,残存字迹:「…当你数到第七扇,」纸背有模糊的压痕。',
  },
  {
    id: 'silver_key',
    name: '银钥匙',
    roomId: '__nowhere',
    desc: '一把小巧的银钥匙,齿纹精细。',
  },
  {
    id: 'poem_page',
    name: '诗页',
    roomId: '__nowhere',
    desc: '一张泛黄的诗页,写着:「两袖清风,三杯淡酒,七分月光。」(最后一行在硬核难度会被撕掉)',
  },
  {
    id: 'iron_key',
    name: '铁钥匙',
    roomId: '__nowhere',
    desc: '一把锈迹斑斑的铁钥匙。',
  },
  {
    id: 'brass_key',
    name: '黄铜钥匙',
    roomId: '__nowhere',
    desc: '一把亮闪闪的黄铜钥匙,齿形怪异。',
  },
]

const DOOR_STUDY: EscapeDoor = {
  id: 'd_study',
  from: 'attic',
  to: 'study',
  name: '通往书房的门',
  lockedBy: { kind: 'item', item: 'copper_key', hint: '锁孔的形状像一柄旧铜钥匙的轮廓。' },
}

const PUZZLE_CLOCK: EscapePuzzle = {
  id: 'p_clock',
  name: '西洋钟',
  prompt: '西洋钟的刻盘等待一个数字。钟面停在四点半——答案就在这间房里某样东西的"背面"。',
  answer: '430',
  clueEvents: ['clue_clock'],
  onSolve: [
    { kind: 'setProp', prop: 'p_clock', state: 'solved' },
    { kind: 'addItem', item: 'silver_key' },
  ],
  solveNarrative: '你旋动刻盘,把钟停在四点半——「咔」。钟底座弹开,里面躺着一把银钥匙。',
  hints: [
    '这间房里,有一样东西的"背面"还藏着信息。',
    '纸条背面的压痕,需要一点光才能读出来。',
    '把钟拨到纸条上的时间——四点半,刻盘上的数字就是答案。',
  ],
}

const MANIPS_SHARED: EscapeManip[] = [
  {
    id: 'm_light_fireplace',
    target: 'p_fireplace',
    keywords: ['点火', '点燃', '生火', '烧', 'light', '划'],
    requires: [{ item: 'matches' }],
    effects: [{ kind: 'setProp', prop: 'p_fireplace', state: 'lit' }],
    narrative: '你划亮一根火柴丢进炉膛,积灰下的引火物腾地燃了起来。火苗蹿起,头顶的烟囱盖"咔哒"弹开,一束天光落在墙角的镜子上。',
    blocked: '壁炉里只有冷灰,你得先有火种。',
  },
  {
    id: 'm_rotate_mirror',
    target: 'p_mirror',
    keywords: ['转', '扳', 'rotate', '挪'],
    requires: [{ prop: { id: 'p_fireplace', state: 'lit' } }],
    effects: [
      { kind: 'setProp', prop: 'p_mirror', state: 'rotated' },
      { kind: 'setProp', prop: 'p_desk', state: 'open' },
    ],
    narrative: '你扳动镜子,银面一转,把那束天光折向书桌——光斑缓缓移到桌面那处凹痕上。几秒后,桌面"嗒"地弹开一个暗格。',
    blocked: '镜子现在没有可折的光——先让这间房里亮起来。',
  },
  {
    id: 'm_backlight_note',
    target: 'half_note',
    keywords: ['凑', '照', '光', '透', '看', '读', 'backlight'],
    requires: [{ item: 'half_note' }, { prop: { id: 'p_fireplace', state: 'lit' } }, { room: 'attic' }],
    effects: [{ kind: 'event', event: 'clue_clock' }],
    narrative: '你把纸条凑近火光,背面的压痕渐渐显出一行字:「4:30」。',
    blocked: '纸条背面的压痕需要强光才能读出来——回壁炉边试试。',
  },
  {
    id: 'm_pry_window',
    target: 'p_window',
    keywords: ['撬', 'pry', '砸', '撞'],
    requires: [],
    effects: [],
    alwaysBlocked: '你用尽全力去撬,窗框嘎吱响了一声,锈死的窗闩却纹丝不动,只在掌心里蹭下几片暗红的铁屑。这扇窗打不开。',
    narrative: '',
  },
  {
    id: 'm_open_final_door',
    target: 'p_final_door',
    keywords: ['推开', '打开', 'open', '开', '推'],
    requires: [],
    effects: [{ kind: 'win' }],
    narrative: '第七扇门缓缓打开,外面是久违的夜风。你逃出来了!',
  },
]

const RECIPE_THAW: EscapeRecipe = {
  id: 'r_thaw',
  a: 'matches',
  b: 'copper_key_frozen',
  effects: [
    { kind: 'removeItem', item: 'copper_key_frozen' },
    { kind: 'addItem', item: 'copper_key' },
  ],
  narrative: '你把冰块凑到火边,冰水一点点滴落,铜钥匙终于脱了禁锢,哐当一声落进你掌心,仍带着一丝凉意。',
}

const USE_STUDY_DOOR: EscapeUse = {
  id: 'u_study_door',
  item: 'copper_key',
  on: 'd_study',
  requires: [],
  effects: [{ kind: 'openDoor', door: 'd_study' }, { kind: 'moveRoom', to: 'study' }],
  narrative: '铜钥匙插进锁孔,轻轻一旋,锁舌缩回,门"吱呀"开了一条缝,透出陈年纸墨的气味。你走进了书房。',
  blocked: '铜钥匙插不进这扇门的锁孔。',
}

/** 组装场景:按难度选择房间、谜题与红鲱鱼。 */
function assembleScenario(difficulty: number): EscapeScenario {
  const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
  const rooms = [ROOM_ATTIC, ROOM_STUDY]
  // 挂画/花瓶(硬核红鲱鱼与拆分线索)只在高难度出现;房间未包含的机关同样剔除
  const propFilter = (p: EscapeProp): boolean => {
    if (p.roomId === 'cellar' && level < 3) return false
    if (p.roomId === 'vault' && level < 2) return false
    if ((p.id === 'p_painting' || p.id === 'p_vase') && level < 3) return false
    return true
  }
  const props = PROPS_SHARED.filter(propFilter).map((p) => ({ ...p }))
  const items = ITEMS_SHARED.map((i) => ({ ...i }))
  const doors: EscapeDoor[] = [{ ...DOOR_STUDY }]
  const puzzles: EscapePuzzle[] = [PUZZLE_CLOCK]
  const manips = MANIPS_SHARED.map((m) => ({ ...m }))
  const recipes: EscapeRecipe[] = [RECIPE_THAW]
  const uses: EscapeUse[] = [USE_STUDY_DOOR]
  const walkthrough: string[] = [
    '① 拿起一盒火柴,点燃壁炉;',
    '② 转动镜子,把光束折向书桌,取得「冻住的铜钥匙」与「半张纸条」;',
    '③ 用火柴烤化冰块,得到「铜钥匙」,打开书房门;',
    '④ 把纸条凑到火光下,读出反印「4:30」;',
    '⑤ 把西洋钟拨到 430,取得「银钥匙」。',
  ]

  if (level === 1) {
    // 入门:2 房间 3 谜题,银钥匙直接开出口
    doors.push({
      id: 'd_exit',
      from: 'study',
      to: '__outside',
      name: '出口门',
      lockedBy: { kind: 'item', item: 'silver_key', hint: '锁孔小巧,与银钥匙的形状吻合。' },
    })
    uses.push({
      id: 'u_exit',
      item: 'silver_key',
      on: 'd_exit',
      requires: [],
      effects: [{ kind: 'openDoor', door: 'd_exit' }, { kind: 'win' }],
      narrative: '银钥匙轻轻一转,出口门应声而开。夜风扑面——你逃出来了!',
      blocked: '银钥匙插不进这扇门的锁孔。',
    })
    walkthrough.push('⑥ 用银钥匙打开出口门,脱出。')
  } else {
    // 标准/硬核:陈列柜 → 诗页 → 密码锁(第七扇门)
    const poem = items.find((i) => i.id === 'poem_page')
    if (poem !== undefined) poem.desc = level === 2 ? '一张泛黄的诗页,写着:「两袖清风,三杯淡酒,七分月光。」' : '一张泛黄的诗页,写着:「两袖清风,三杯淡酒,」最后一行被撕掉了。'
    uses.push({
      id: 'u_cabinet',
      item: 'silver_key',
      on: 'p_cabinet',
      requires: [],
      effects: [
        { kind: 'setProp', prop: 'p_cabinet', state: 'open' },
        { kind: 'addItem', item: 'poem_page' },
        ...(level === 3 ? [{ kind: 'addItem' as const, item: 'iron_key' }] : []),
      ],
      narrative: level === 3 ? '银钥匙转动,陈列柜开了,里面有一张诗页和一把锈迹斑斑的铁钥匙。' : '银钥匙转动,陈列柜开了,里面有一张诗页。',
      blocked: '银钥匙插不进陈列柜的锁孔。',
    })
    puzzles.push({
      id: 'p_cipher',
      name: '第七扇门密码锁',
      prompt: '黄铜面板上的三个旋钮 0-9。这组三位数字,藏在老宅的线索里。',
      answer: '237',
      clueItems: ['poem_page'],
      clueEvents: level === 3 ? ['clue_seven'] : [],
      onSolve: [
        { kind: 'setProp', prop: 'p_final_door', state: 'open' },
        { kind: 'openDoor', door: 'd_vault' },
        { kind: 'moveRoom', to: 'vault' },
      ],
      solveNarrative: '你依次拨动旋钮:2…3…7…「咔哒」。第七扇门开了,你走了进去——这是最后一道门。',
      hints: [
        '书房里有一样带字的东西,是解开密码的钥匙。',
        '诗页里的数字,按出现的顺序排。',
        level === 2 ? '清风、淡酒、月光——各有一个数字:2、3、7。' : '诗页给了两个数字,第三个数字藏在书房墙上某样东西的后面。',
      ],
    })
    doors.push({
      id: 'd_vault',
      from: 'study',
      to: 'vault',
      name: '密室门',
      lockedBy: { kind: 'puzzle', puzzle: 'p_cipher', hint: '门上是一块三位数字的密码面板。' },
      puzzle: 'p_cipher',
    })
    rooms.push(ROOM_VAULT)
    walkthrough.push('⑥ 用银钥匙打开陈列柜,取得诗页(硬核:还有铁钥匙);')
    walkthrough.push('⑦ 按诗页数字解出密码 237(硬核:第三个数字藏在挂画后面),进入密室;')
    walkthrough.push('⑧ 推开第七扇门,脱出。')
  }

  if (level === 3) {
    // 硬核:4 房间、红鲱鱼(黄铜钥匙)+ 拆开密码线索 + 地窖支线;第七扇门需先解出密码
    const finalDoor = manips.find((m) => m.id === 'm_open_final_door')
    if (finalDoor !== undefined) {
      finalDoor.requires = [{ puzzle: 'p_cipher' }]
      finalDoor.blocked = '你用力推门,门闩纹丝不动——某个机关还锁着它。密码还没解开。'
    }
    rooms.splice(2, 0, ROOM_CELLAR)
    manips.push(
      {
        id: 'm_vase',
        target: 'p_vase',
        keywords: ['倒', '推倒', 'tilt', '翻'],
        requires: [],
        effects: [
          { kind: 'setProp', prop: 'p_vase', state: 'tilted' },
          { kind: 'addItem', item: 'brass_key' },
        ],
        narrative: '花瓶倒了,里面滚出一把黄铜钥匙。',
      },
      {
        id: 'm_painting',
        target: 'p_painting',
        keywords: ['扶正', '摆正', '移开', '推', 'straighten'],
        requires: [],
        effects: [
          { kind: 'setProp', prop: 'p_painting', state: 'straightened' },
          { kind: 'event', event: 'clue_seven' },
        ],
        narrative: '你扶正挂画,墙上露出一行刻痕:「第七扇门后,藏着最后一个数字 7。」',
      },
      {
        id: 'm_light_torch',
        target: 'p_torch',
        keywords: ['点', 'light', '烧'],
        requires: [{ item: 'matches' }],
        effects: [{ kind: 'setProp', prop: 'p_torch', state: 'lit' }],
        narrative: '你点亮火把,地窖亮了起来——角落里有一块活板门。',
        blocked: '火把需要火种。',
      },
      {
        id: 'm_open_trapdoor',
        target: 'p_trapdoor',
        keywords: ['打开', '掀', 'open', '开'],
        requires: [{ prop: { id: 'p_torch', state: 'lit' } }],
        effects: [{ kind: 'moveRoom', to: 'vault' }],
        narrative: '你掀开活板门,顺着石阶走了下去,来到最后一间密室。',
        blocked: '地窖里一片漆黑,你摸不到活板门的位置。',
      },
    )
    doors.push({
      id: 'd_cellar',
      from: 'study',
      to: 'cellar',
      name: '密道暗门',
      lockedBy: { kind: 'item', item: 'iron_key', hint: '书架后的暗门,锁孔锈迹斑斑,需要一把铁钥匙。' },
    })
    uses.push({
      id: 'u_cellar',
      item: 'iron_key',
      on: 'd_cellar',
      requires: [],
      effects: [{ kind: 'openDoor', door: 'd_cellar' }, { kind: 'moveRoom', to: 'cellar' }],
      narrative: '铁钥匙插进暗门,门后是一条向下的石阶,霉味扑鼻。你走进了地窖。',
      blocked: '铁钥匙插不进这扇门的锁孔。',
    })
    walkthrough.push('(硬核支线)书房花瓶里的黄铜钥匙是障眼法,插不进任何锁;')
    walkthrough.push('(硬核支线)铁钥匙打开书架后的密道暗门,进入地窖;点亮火把,掀开活板门抵达密室;')
    walkthrough.push('(硬核)第七扇门必须先解出密码 237(诗页的 2、3 + 挂画后的 7)才能推开。')
  }

  return {
    id: `seven-door-d${level}`,
    title: '第七扇门',
    difficulty: level,
    intro:
      '你在一间阁楼里醒来,后脑隐隐作痛,记不起自己是怎么来的。身后的门已被封死,唯一的出路在前方。这座老宅的传说里,数到第七扇门,就能离开。',
    rooms,
    props,
    doors,
    items,
    puzzles,
    manips,
    recipes,
    uses,
    puzzleOrder: puzzles.map((p) => p.id),
    walkthrough,
  }
}

// ── 程序化题库(M3):叙事换皮 + 可解性求解器 ─────────────────────────────────

export interface EscapeSkin {
  id: string
  title: string
  place: string
  intro: string
  /** 默认显示名 → 皮肤显示名(最长优先替换,自动覆盖所有叙事文本)。 */
  names: Record<string, string>
  /** 质量修正:逐字段覆盖(键如 room:attic / prop:p_fireplace / prop:p_fireplace:lit / item:matches)。 */
  descOverrides?: Record<string, string>
}

const SKINS: EscapeSkin[] = [
  {
    id: 'manor',
    title: '第七扇门',
    place: '老宅',
    intro: '你在一间阁楼里醒来,后脑隐隐作痛,记不起自己是怎么来的。身后的门已被封死,唯一的出路在前方。这座老宅的传说里,数到第七扇门,就能离开。',
    names: {},
  },
  {
    id: 'submarine',
    title: '第七扇门·深潜',
    place: '潜艇',
    intro: '你在一艘失联潜艇的船员舱里醒来,警报灯的红光一明一灭。舱门全部锁死,氧气告急。传说这艘艇的第七道舱门,通向海面。',
    names: {
      '冻住的铜钥匙': '冻住的舱门钥匙',
      '黄铜钥匙': '黄铜钥匙',
      铜钥匙: '舱门钥匙',
      '一盒火柴': '打火机',
      火柴: '打火机',
      '半张纸条': '半张日志',
      纸条: '日志',
      诗页: '航海日志',
      阁楼: '船员舱',
      书房: '指挥舱',
      地窖: '轮机舱',
      密室: '逃生舱',
      壁炉: '取暖器',
      镜子: '反光镜',
      书桌: '储物柜',
      西洋钟: '航海钟',
      斜窗: '舷窗',
      陈列柜: '文件柜',
      挂画: '海图挂轴',
      花瓶: '水密筒',
      书架: '工具架',
      写字台: '海图桌',
      火把: '应急灯',
      活板门: '检修口',
      第七扇门: '第七道舱门',
      老宅: '潜艇',
    },
    descOverrides: {
      'room:attic': '狭长的船员舱。舷窗封死,舱壁凝着水珠;取暖器蒙着盐霜,墙角立着一面反光镜,储物柜上放着停摆的航海钟。通往指挥舱的舱门锁着。',
      'room:study': '指挥舱,仪表盘蒙着灰,墙上的海图微微歪斜,门边立着一只水密筒,角落是一个带锁的文件柜。',
      'room:cellar': '黑暗潮湿的轮机舱,霉味扑鼻。你什么都看不清,只摸到墙上有盏应急灯。',
      'room:vault': '最后一间逃生舱。正对着你的,是第七道舱门——门上一块黄铜面板,刻着三个 0-9 的旋钮。',
      'prop:p_fireplace': '取暖器蒙着盐霜,后面的格栅松了一块,缝隙里反着一点微光。',
      'prop:p_fireplace:lit': '取暖器烧得通红,头顶的换气阀弹开了,一束光斜斜灌下,落在墙角的反光镜上。',
      'prop:p_desk': '一只旧储物柜,柜门上有一处不起眼的凹痕。',
      'prop:p_clock': '一座航海钟,指针停在四点半,底座上有一圈可旋动的刻盘。',
      'prop:p_window': '一面舷窗,泄压阀锈成了深褐色。',
      'item:matches': '打火机还剩半管燃料,按一下就能点着。',
      'item:copper_key_frozen': '一把舱门钥匙被冻在一块冰里,齿纹若隐若现。',
      'door:d_study': '通往指挥舱的舱门',
      'door:d_vault': '通往逃生舱的舱门',
    },
  },
  {
    id: 'starship',
    title: '第七扇门·远航',
    place: '飞船',
    intro: '你在远航飞船的休眠舱里醒来,舷窗外是陌生的星海。气闸全部锁死,氧气指数缓缓下降。传说这艘船的第七道气闸门,通向救生艇。',
    names: {
      '冻住的铜钥匙': '冻住的舱门卡',
      铜钥匙: '舱门卡',
      '一盒火柴': '点火器',
      火柴: '点火器',
      '半张纸条': '半张日志',
      纸条: '日志',
      诗页: '航行日志',
      阁楼: '休眠舱',
      书房: '舰桥',
      地窖: '引擎舱',
      密室: '气闸舱',
      壁炉: '加热单元',
      镜子: '聚光镜',
      书桌: '收纳柜',
      西洋钟: '星历钟',
      斜窗: '观察窗',
      陈列柜: '资料柜',
      挂画: '星图',
      花瓶: '气密罐',
      书架: '货架',
      写字台: '控制台',
      火把: '应急照明',
      活板门: '检修盖板',
      第七扇门: '第七道气闸门',
      老宅: '飞船',
    },
    descOverrides: {
      'room:attic': '狭长的休眠舱。观察窗封死,舱壁凝着霜;加热单元积着灰,墙角立着一面聚光镜,收纳柜旁是停摆的星历钟。通往舰桥的舱门锁着。',
      'room:study': '舰桥,控制台蒙着灰,墙上的星图微微歪斜,门边立着一只气密罐,角落是一个带锁的资料柜。',
      'room:cellar': '黑暗的引擎舱,能量管线嗡嗡作响。你什么都看不清,只摸到墙上有应急照明。',
      'room:vault': '最后一间气闸舱。正对着你的,是第七道气闸门——门上一块面板,刻着三个 0-9 的旋钮。',
      'prop:p_fireplace': '加热单元积着灰,后面的格栅松了一块,缝隙里反着一点微光。',
      'prop:p_fireplace:lit': '加热单元嗡鸣起来,头顶的通风阀弹开了,一束光斜斜灌下,落在墙角的聚光镜上。',
      'prop:p_desk': '一只旧收纳柜,柜门上有一处不起眼的凹痕。',
      'prop:p_clock': '一座星历钟,指针停在四点半,底座上有一圈可旋动的刻盘。',
      'prop:p_window': '一面观察窗,泄压阀锈成了深褐色。',
      'item:matches': '点火器还剩半格能量,按一下就能点火。',
      'item:copper_key_frozen': '一张舱门卡被冻在一块冰里,卡号若隐若现。',
      'door:d_study': '通往舰桥的舱门',
      'door:d_vault': '通往气闸舱的舱门',
    },
  },
]

/** 皮肤替换:对全部用户可见文本做最长优先的显示名替换,再套逐字段修正。 */
function applySkin(scenario: EscapeScenario, skin: EscapeSkin): EscapeScenario {
  const pairs = Object.entries(skin.names).sort((a, b) => b[0].length - a[0].length)
  const repl = (text: string): string => {
    let out = text
    for (const [from, to] of pairs) out = out.split(from).join(to)
    return out
  }
  const rooms = scenario.rooms.map((r) => ({ ...r, name: repl(r.name), desc: skin.descOverrides?.[`room:${r.id}`] ?? repl(r.desc) }))
  const props = scenario.props.map((p) => {
    const p2 = { ...p, name: repl(p.name), desc: skin.descOverrides?.[`prop:${p.id}`] ?? repl(p.desc), states: p.states !== undefined ? { ...p.states } : undefined }
    if (p2.states !== undefined) {
      for (const [k, v] of Object.entries(p2.states)) p2.states[k] = skin.descOverrides?.[`prop:${p.id}:${k}`] ?? repl(v)
    }
    return p2
  })
  const items = scenario.items.map((i) => ({ ...i, name: repl(i.name), desc: skin.descOverrides?.[`item:${i.id}`] ?? repl(i.desc) }))
  const doors = scenario.doors.map((d) => ({
    ...d,
    name: skin.descOverrides?.[`door:${d.id}`] ?? repl(d.name),
    lockedBy: d.lockedBy !== undefined ? { ...d.lockedBy, hint: repl(d.lockedBy.hint) } : undefined,
  }))
  const puzzles = scenario.puzzles.map((p) => ({ ...p, prompt: repl(p.prompt), solveNarrative: repl(p.solveNarrative), hints: p.hints.map(repl) as [string, string, string] }))
  const manips = scenario.manips.map((m) => ({
    ...m,
    narrative: repl(m.narrative),
    blocked: m.blocked !== undefined ? repl(m.blocked) : undefined,
    alwaysBlocked: m.alwaysBlocked !== undefined ? repl(m.alwaysBlocked) : undefined,
  }))
  const recipes = scenario.recipes.map((r) => ({ ...r, narrative: repl(r.narrative) }))
  const uses = scenario.uses.map((u) => ({ ...u, narrative: repl(u.narrative), blocked: u.blocked !== undefined ? repl(u.blocked) : undefined }))
  return {
    ...scenario,
    id: `${scenario.id}-${skin.id}`,
    title: skin.title,
    intro: skin.intro,
    rooms,
    props,
    items,
    doors,
    puzzles,
    manips,
    recipes,
    uses,
    walkthrough: scenario.walkthrough.map(repl),
  }
}

/** 程序化生成:经典机制 + 皮肤换皮(种子确定性)。 */
export function generateEscapeScenario(difficulty: number, seed: number): EscapeScenario {
  const base = assembleScenario(difficulty)
  // 生成变体只用换皮皮肤(潜艇/飞船);经典古宅留在池首
  const skin = SKINS[1 + (Math.abs(seed) % (SKINS.length - 1))]
  return applySkin(base, skin)
}

/** 可解性求解器:用引擎纯函数从初始状态重放金路径,逐条断言成功。 */
export function solveEscapeScenario(scenario: EscapeScenario): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const dupIn = (ids: string[]): string[] => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  const dup = [
    ...dupIn(scenario.props.map((p) => p.id)),
    ...dupIn(scenario.items.map((i) => i.id)),
    ...dupIn(scenario.doors.map((d) => d.id)),
    ...dupIn(scenario.puzzles.map((p) => p.id)),
  ]
  if (dup.length > 0) errors.push(`重复 id:${dup.join(',')}`)
  const state: EscapeState = {
    scheme: 'escape',
    difficulty: scenario.difficulty,
    startedAt: 0,
    updatedAt: 0,
    phase: 'playing',
    turns: 0,
    hintsUsed: 0,
    score: null,
    scenarioId: scenario.id,
    roomId: scenario.rooms[0]?.id ?? 'attic',
    inventory: [],
    propStates: {},
    itemStates: {},
    openDoors: [],
    solved: [],
    clues: [],
    bruteForce: [],
    wrongAttempts: 0,
    puzzleHints: {},
  }
  for (const prop of scenario.props) state.propStates[prop.id] = prop.defaultState
  const nameOf = <T extends { id: string; name: string }>(list: T[], id: string): string => list.find((x) => x.id === id)?.name ?? id
  const step = (label: string, fn: () => ActionResult): void => {
    const r = fn()
    if (r.result !== 'success') errors.push(`金路径步骤失败:${label} → ${r.result}`)
  }
  const matches = nameOf(scenario.items, 'matches')
  const frozen = nameOf(scenario.items, 'copper_key_frozen')
  const copper = nameOf(scenario.items, 'copper_key')
  const note = nameOf(scenario.items, 'half_note')
  const silver = nameOf(scenario.items, 'silver_key')
  const fire = nameOf(scenario.props, 'p_fireplace')
  const mirror = nameOf(scenario.props, 'p_mirror')
  const cabinet = nameOf(scenario.props, 'p_cabinet')
  const finalDoor = nameOf(scenario.props, 'p_final_door')
  const studyDoor = nameOf(scenario.doors, 'd_study')
  step('取火种', () => take(scenario, state, matches))
  step('点火', () => manipulate(scenario, state, fire, '点火'))
  step('转镜', () => manipulate(scenario, state, mirror, '转动'))
  step('取冻钥匙', () => take(scenario, state, frozen))
  step('取纸条', () => take(scenario, state, note))
  step('烤化', () => combine(scenario, state, matches, frozen))
  step('反印', () => manipulate(scenario, state, note, '凑到火光下'))
  step('解钟', () => solve(scenario, state, '西洋钟', '4:30'))
  step('开书房门', () => useItem(scenario, state, copper, studyDoor))
  if (scenario.difficulty === 1) {
    step('开出口', () => useItem(scenario, state, silver, nameOf(scenario.doors, 'd_exit')))
  } else {
    step('开陈列柜', () => useItem(scenario, state, silver, cabinet))
    if (scenario.difficulty === 3) {
      step('扶画', () => manipulate(scenario, state, nameOf(scenario.props, 'p_painting'), '扶正'))
      step('倒花瓶', () => manipulate(scenario, state, nameOf(scenario.props, 'p_vase'), '推倒'))
      step('开暗门', () => useItem(scenario, state, nameOf(scenario.items, 'iron_key'), nameOf(scenario.doors, 'd_cellar')))
      step('点应急灯', () => manipulate(scenario, state, nameOf(scenario.props, 'p_torch'), '点火'))
      step('掀检修口', () => manipulate(scenario, state, nameOf(scenario.props, 'p_trapdoor'), '打开'))
    }
    step('解密码', () => solve(scenario, state, '第七扇门密码锁', '237'))
    if (scenario.difficulty >= 2) step('推第七扇门', () => manipulate(scenario, state, finalDoor, '推开'))
  }
  if (state.phase !== 'solved') errors.push('金路径重放后未达成脱出')
  return { ok: errors.length === 0, errors }
}

const SCENARIOS = new Map<number, EscapeScenario[]>()

/** 题库池:经典古宅 + 通过求解器的换皮变体(每难度 6 个)。 */
function escapePool(difficulty: number): EscapeScenario[] {
  const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
  let pool = SCENARIOS.get(level)
  if (pool === undefined) {
    pool = [assembleScenario(level)]
    for (let seed = 1; pool.length < 3 && seed < 120; seed += 1) {
      const scenario = generateEscapeScenario(level, seed)
      if (solveEscapeScenario(scenario).ok && !pool.some((x) => x.id === scenario.id)) pool.push(scenario)
    }
    SCENARIOS.set(level, pool)
  }
  return pool
}

export function scenarioFor(difficulty: number, seed = 0): EscapeScenario {
  const pool = escapePool(difficulty)
  return pool[Math.abs(seed) % pool.length]
}

// ── 匹配辅助 ──────────────────────────────────────────────────────────────────

function matchByKey<T extends { id: string; name: string }>(list: T[], key: string): T[] {
  const norm = key.trim().toLowerCase()
  if (norm === '') return []
  return list.filter((t) => t.id === norm || t.name.toLowerCase().includes(norm) || norm.includes(t.name.toLowerCase()))
}

function visibleItem(scenario: EscapeScenario, state: EscapeState, item: EscapeItem): boolean {
  if (state.inventory.includes(item.id)) return false
  if (item.hiddenIn !== undefined) {
    return state.propStates[item.hiddenIn] === item.hiddenState
  }
  return item.roomId === state.roomId
}

function propsInRoom(scenario: EscapeScenario, state: EscapeState): EscapeProp[] {
  return scenario.props.filter((p) => p.roomId === state.roomId)
}

function doorsFrom(scenario: EscapeScenario, state: EscapeState): EscapeDoor[] {
  return scenario.doors.filter((d) => d.from === state.roomId)
}

function roomName(scenario: EscapeScenario, roomId: string): string {
  if (roomId === '__outside') return '外面'
  return scenario.rooms.find((r) => r.id === roomId)?.name ?? roomId
}

// ── 裁决(纯函数) ────────────────────────────────────────────────────────────

export interface ActionResult {
  result: 'success' | 'blocked' | 'no_effect' | 'wrong' | 'already' | 'error'
  text: string
  won?: boolean
}

function applyEffect(state: EscapeState, effect: EscapeEffect): void {
  switch (effect.kind) {
    case 'setProp':
      state.propStates[effect.prop] = effect.state
      break
    case 'addItem':
      if (!state.inventory.includes(effect.item)) state.inventory.push(effect.item)
      break
    case 'removeItem':
      state.inventory = state.inventory.filter((i) => i !== effect.item)
      break
    case 'setItemState':
      state.itemStates[effect.item] = effect.state
      break
    case 'openDoor':
      if (!state.openDoors.includes(effect.door)) state.openDoors.push(effect.door)
      break
    case 'moveRoom':
      state.roomId = effect.to
      break
    case 'event':
      if (!state.clues.includes(effect.event)) state.clues.push(effect.event)
      break
    case 'win':
      if (state.phase === 'playing') state.phase = 'solved'
      break
  }
}

function meetsReq(state: EscapeState, req: Req): boolean {
  if (req.item !== undefined && !state.inventory.includes(req.item)) return false
  if (req.prop !== undefined && state.propStates[req.prop.id] !== req.prop.state) return false
  if (req.room !== undefined && state.roomId !== req.room) return false
  if (req.puzzle !== undefined && !state.solved.includes(req.puzzle)) return false
  return true
}

function snapshot(scenario: EscapeScenario, state: EscapeState): string {
  const room = scenario.rooms.find((r) => r.id === state.roomId)
  const lines: string[] = []
  lines.push(`【状态快照】位置:${room?.name ?? state.roomId}`)
  lines.push(`背包:${state.inventory.length > 0 ? state.inventory.map((id) => scenario.items.find((i) => i.id === id)?.name ?? id).join('、') : '(空)'}`)
  lines.push(`已解谜题:${state.solved.length > 0 ? state.solved.join('、') : '(无)'}`)
  return lines.join('\n')
}

/** /look:当前房间完整描述 + 可交互项 + 门。 */
export function lookText(scenario: EscapeScenario, state: EscapeState): string {
  const room = scenario.rooms.find((r) => r.id === state.roomId)
  const lines: string[] = [`【${room?.name ?? state.roomId}】${room?.desc ?? ''}`]
  for (const prop of propsInRoom(scenario, state)) {
    const stateNote = prop.states?.[state.propStates[prop.id] ?? prop.defaultState]
    lines.push(`- ${prop.name}:${stateNote ?? ''}`)
  }
  for (const item of scenario.items) {
    if (visibleItem(scenario, state, item)) lines.push(`- 地上/桌上有:${item.name}(${item.desc})`)
  }
  for (const door of doorsFrom(scenario, state)) {
    const open = state.openDoors.includes(door.id)
    const lock = open ? '' : door.lockedBy !== undefined ? `(锁着,${'hint' in door.lockedBy ? door.lockedBy.hint : ''})` : ''
    lines.push(`- 门:${door.name}${open ? '(已开,通往' + roomName(scenario, door.to) + ')' : lock}`)
  }
  return lines.join('\n')
}

/** examine:机关 / 物品 / 门 / 房间。 */
export function examine(scenario: EscapeScenario, state: EscapeState, target: string): ActionResult {
  const props = matchByKey(propsInRoom(scenario, state), target)
  if (props.length === 1) {
    const prop = props[0]
    const current = state.propStates[prop.id] ?? prop.defaultState
    const note = prop.states?.[current] ?? ''
    let text = `${prop.name}:${prop.desc}${note !== '' ? `\n${note}` : ''}`
    if (prop.puzzle !== undefined) {
      const puzzle = scenario.puzzles.find((p) => p.id === prop.puzzle)
      if (puzzle !== undefined && !state.solved.includes(puzzle.id)) {
        text += `\n【谜题·${puzzle.name}】${puzzle.prompt}\n(得出答案后,用 escape_solve 提交)`
      }
    }
    return { result: 'success', text: `${text}\n\n主持人守则:只转述以上描述,不得增删细节。` }
  }
  if (props.length > 1) {
    return { result: 'error', text: `「${target}」有歧义,可能是:${props.map((p) => p.name).join('、')}。请让玩家说具体一点。` }
  }
  const items = matchByKey(scenario.items, target).filter((i) => visibleItem(scenario, state, i) || state.inventory.includes(i.id))
  if (items.length === 1) {
    return { result: 'success', text: `${items[0].name}:${items[0].desc}\n\n主持人守则:只转述以上描述。` }
  }
  if (items.length > 1) {
    return { result: 'error', text: `「${target}」有歧义,可能是:${items.map((i) => i.name).join('、')}。` }
  }
  const doors = matchByKey(doorsFrom(scenario, state), target)
  if (doors.length === 1) {
    const door = doors[0]
    const open = state.openDoors.includes(door.id)
    if (open) return { result: 'success', text: `${door.name}开着,通往${roomName(scenario, door.to)}。` }
    const hint = door.lockedBy !== undefined ? door.lockedBy.hint : ''
    let text = `${door.name}锁着。${hint}`
    if (door.puzzle !== undefined) {
      const puzzle = scenario.puzzles.find((p) => p.id === door.puzzle)
      if (puzzle !== undefined && !state.solved.includes(puzzle.id)) {
        text += `\n【谜题·${puzzle.name}】${puzzle.prompt}\n(得出答案后,用 escape_solve 提交)`
      }
    }
    return { result: 'success', text: `${text}\n\n主持人守则:如实转述,不要暗示开法或答案。` }
  }
  if (doors.length > 1) {
    return { result: 'error', text: `「${target}」有歧义,可能是:${doors.map((d) => d.name).join('、')}。` }
  }
  return { result: 'no_effect', text: `这里没有「${target}」。可以用 /look 看看周围有什么。\n主持人守则:如实转告玩家,并建议用 /look 观察房间。` }
}

/** take:拾取当前房间可见物品。 */
export function take(scenario: EscapeScenario, state: EscapeState, itemKey: string): ActionResult {
  const candidates = matchByKey(scenario.items, itemKey).filter((i) => visibleItem(scenario, state, i))
  if (candidates.length === 0) {
    const owned = matchByKey(scenario.items, itemKey).filter((i) => state.inventory.includes(i.id))
    if (owned.length > 0) return { result: 'no_effect', text: '你已经有这件东西了。' }
    return { result: 'no_effect', text: `你拿不到「${itemKey}」——它不在这里。` }
  }
  if (candidates.length > 1) {
    return { result: 'error', text: `「${itemKey}」有歧义,可能是:${candidates.map((i) => i.name).join('、')}。` }
  }
  const item = candidates[0]
  state.inventory.push(item.id)
  state.turns += 1
  return { result: 'success', text: `你拿起了${item.name}。${item.desc}\n\n主持人守则:确认物品已进入玩家背包(/bag 可查)。` }
}

/** use:把物品用在机关/门上。 */
export function useItem(scenario: EscapeScenario, state: EscapeState, itemKey: string, onKey: string): ActionResult {
  const itemCandidates = matchByKey(scenario.items, itemKey).filter((i) => state.inventory.includes(i.id))
  if (itemCandidates.length === 0) {
    return { result: 'no_effect', text: `你的背包里没有「${itemKey}」。/bag 可查背包。` }
  }
  if (itemCandidates.length > 1) {
    return { result: 'error', text: `「${itemKey}」有歧义,可能是:${itemCandidates.map((i) => i.name).join('、')}。` }
  }
  const item = itemCandidates[0]
  const targets: { id: string; name: string }[] = [
    ...propsInRoom(scenario, state).map((p) => ({ id: p.id, name: p.name })),
    ...doorsFrom(scenario, state).map((d) => ({ id: d.id, name: d.name })),
  ]
  const targetCandidates = matchByKey(targets, onKey)
  if (targetCandidates.length === 0) {
    return { result: 'no_effect', text: `这里没有「${onKey}」可以作用。` }
  }
  if (targetCandidates.length > 1) {
    return { result: 'error', text: `「${onKey}」有歧义,可能是:${targetCandidates.map((t) => t.name).join('、')}。` }
  }
  const target = targetCandidates[0]
  const match = scenario.uses.find((u) => u.item === item.id && u.on === target.id)
  if (match === undefined) {
    state.turns += 1
    return { result: 'no_effect', text: `${item.name}用在${target.name}上——没有任何反应,似乎不匹配。\n主持人守则:如实告诉玩家"不匹配",不要暗示正确用法。` }
  }
  if (!match.requires.every((r) => meetsReq(state, r))) {
    state.turns += 1
    return { result: 'blocked', text: match.blocked ?? '还差一步,现在这么做没用。' }
  }
  for (const effect of match.effects) applyEffect(state, effect)
  state.turns += 1
  const won = state.phase === 'solved'
  return { result: 'success', won, text: `${match.narrative}${won ? '\n\n' + settleText(scenario, state) : ''}` }
}

/** combine:组合两件背包物品。 */
export function combine(scenario: EscapeScenario, state: EscapeState, aKey: string, bKey: string): ActionResult {
  const aCandidates = matchByKey(scenario.items, aKey).filter((i) => state.inventory.includes(i.id))
  const bCandidates = matchByKey(scenario.items, bKey).filter((i) => state.inventory.includes(i.id))
  if (aCandidates.length === 0 || bCandidates.length === 0) {
    return { result: 'no_effect', text: '要组合的东西不在你的背包里。' }
  }
  if (aCandidates.length > 1 || bCandidates.length > 1) {
    return { result: 'error', text: '组合对象有歧义,请让玩家说具体一点。' }
  }
  const a = aCandidates[0]
  const b = bCandidates[0]
  const recipe = scenario.recipes.find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id))
  if (recipe === undefined) {
    state.turns += 1
    return { result: 'no_effect', text: `${a.name}和${b.name}放在一起,什么也没发生。\n主持人守则:如实转告,不要暗示正确组合。` }
  }
  for (const effect of recipe.effects) applyEffect(state, effect)
  state.turns += 1
  return { result: 'success', text: recipe.narrative }
}

/** manipulate:操作机关(点火/转动/推倒…),跑状态机。 */
export function manipulate(scenario: EscapeScenario, state: EscapeState, targetKey: string, action: string): ActionResult {
  const actionNorm = action.trim().toLowerCase()
  const targets: { id: string; name: string }[] = [
    ...matchByKey(propsInRoom(scenario, state), targetKey).map((p) => ({ id: p.id, name: p.name })),
    ...matchByKey(scenario.items, targetKey)
      .filter((i) => state.inventory.includes(i.id))
      .map((i) => ({ id: i.id, name: i.name })),
  ]
  if (targets.length === 0) {
    return { result: 'no_effect', text: `这里没有「${targetKey}」。` }
  }
  if (targets.length > 1) {
    return { result: 'error', text: `「${targetKey}」有歧义,可能是:${targets.map((t) => t.name).join('、')}。` }
  }
  const target = targets[0]
  const matched = scenario.manips.filter((m) => m.target === target.id && (actionNorm === '' || m.keywords.some((k) => actionNorm.includes(k.toLowerCase()))))
  if (matched.length === 0) {
    state.turns += 1
    return { result: 'no_effect', text: `你对${target.name}做了点什么,但什么也没发生。\n主持人守则:如实转告,提示玩家换个动作或换个目标。` }
  }
  const ready = matched.find((m) => m.requires.every((r) => meetsReq(state, r)))
  const pick2 = ready ?? matched[0]
  if (!pick2.requires.every((r) => meetsReq(state, r))) {
    state.turns += 1
    return { result: 'blocked', text: pick2.blocked ?? '还差一步:先想想缺了什么。' }
  }
  if (pick2.alwaysBlocked !== undefined) {
    state.turns += 1
    return { result: 'no_effect', text: pick2.alwaysBlocked }
  }
  for (const effect of pick2.effects) applyEffect(state, effect)
  if (pick2.clue !== undefined && !state.clues.includes(pick2.clue)) state.clues.push(pick2.clue)
  state.turns += 1
  const won = state.phase === 'solved'
  return { result: 'success', won, text: `${pick2.narrative}${won ? '\n\n' + settleText(scenario, state) : ''}` }
}

/** solve:提交谜底。 */
export function solve(scenario: EscapeScenario, state: EscapeState, puzzleKey: string, answer: string): ActionResult {
  const candidates = matchByKey(scenario.puzzles, puzzleKey)
  if (candidates.length === 0) {
    return { result: 'error', text: `没有「${puzzleKey}」这个谜题。` }
  }
  if (candidates.length > 1) {
    return { result: 'error', text: `「${puzzleKey}」有歧义:${candidates.map((p) => p.name).join('、')}。` }
  }
  const puzzle = candidates[0]
  if (state.solved.includes(puzzle.id)) {
    return { result: 'already', text: '这个谜题已经解开了。' }
  }
  const norm = (s: string) => s.replace(/[^\d]/g, '')
  const submitted = norm(answer)
  if (submitted === '' || submitted !== norm(puzzle.answer)) {
    state.wrongAttempts += 1
    state.turns += 1
    return { result: 'wrong', text: `答案不对(已记一次错误尝试)。\n主持人守则:如实转告"不对",让玩家再想想或 /hint 买提示。` }
  }
  const hadEvents = (puzzle.clueEvents ?? []).every((e) => state.clues.includes(e))
  const hadItems = (puzzle.clueItems ?? []).every((i) => state.inventory.includes(i))
  if (!hadEvents || !hadItems) state.bruteForce.push(puzzle.id)
  state.solved.push(puzzle.id)
  for (const effect of puzzle.onSolve) applyEffect(state, effect)
  state.turns += 1
  const won = state.phase === 'solved'
  return { result: 'success', won, text: `${puzzle.solveNarrative}${won ? '\n\n' + settleText(scenario, state) : ''}` }
}

// ── 计分 ──────────────────────────────────────────────────────────────────────

function computeScore(scenario: EscapeScenario, state: EscapeState): ScoreBar[] {
  const escaped = state.phase === 'solved'
  const reasoning = Math.max(0, 100 - state.bruteForce.length * 20 - state.wrongAttempts * 5 - state.hintsUsed * 10)
  const bruteNote = state.bruteForce.length > 0 ? ` · ${state.bruteForce.length} 个谜题未获得线索即解出(暴力猜谜)` : ''
  return [
    {
      label: '结论正确性',
      value: escaped ? 100 : 0,
      note: escaped ? '成功脱出' : '未脱出',
    },
    {
      label: '推理质量',
      value: reasoning,
      note: `${state.wrongAttempts} 次错误尝试 · ${state.hintsUsed} 次提示${bruteNote}`,
    },
    {
      label: '效率',
      value: Math.max(0, 100 - state.turns * 2 - state.hintsUsed * 10),
      note: `${state.turns} 次动作 · ${state.hintsUsed} 次提示`,
    },
  ]
}

function settleText(scenario: EscapeScenario, state: EscapeState): string {
  const bars = computeScore(scenario, state)
  const lines = bars.map((b) => `- ${b.label}:${b.value}(${b.note})`)
  return `【密室逃脱 · 结算】${scenario.title}${state.phase === 'solved' ? ' ✅ 已脱出' : ''}
${lines.join('\n')}
已解谜题:${state.solved.length}/${scenario.puzzles.length} · 动作 ${state.turns} 次 · 提示 ${state.hintsUsed} 次

主持人守则:恭喜玩家并公布三栏得分。完整谜底与脱出路径可在 /game quit 查看。`
}

function scoreText(scenario: EscapeScenario, state: EscapeState): string {
  const bars = computeScore(scenario, state)
  return `【密室逃脱 · 当前进度】已解谜题 ${state.solved.length}/${scenario.puzzles.length} · 动作 ${state.turns} 次 · 提示 ${state.hintsUsed} 次

${bars.map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

卡住时输入 /hint 买提示,/look 看房间,/bag 看背包。`
}

// ── 简报 ──────────────────────────────────────────────────────────────────────

function buildBrief(scenario: EscapeScenario, state: EscapeState): string {
  return `【游戏开始:密室逃脱 · ${scenario.title}】(难度 ${scenario.difficulty}/3)

现在你是密室主持人。玩家用自然语言与密室交互("撬开窗户""用火柴点壁炉""把钟拨到四点半")。请遵守以下铁律:

1. 你【不知道谜底与机关解法】。谜底、配方、机关依赖只存在于游戏引擎中,不要猜测、不要脑补、更不要直接告诉玩家答案。
2. 玩家每个动作,你必须调用对应工具交给引擎裁决,引擎返回什么你才能叙述什么:
   - 观察物品/机关/门 → \`escape_examine\`(target 为名称);
   - 拾取 → \`escape_take\`;把物品用于目标 → \`escape_use\`(item + on);
   - 组合两件物品 → \`escape_combine\`;操作机关 → \`escape_manipulate\`(target + action,action 用动词如"点火/转动/推倒");
   - 提交谜底 → \`escape_solve\`(puzzle 为谜题名,answer 为答案)。
3. 严禁自行宣布"门开了""捡到了东西"——一切世界变化只能来自引擎返回结果。
4. 引擎返回"无效果/不匹配"时,把它渲染成物理上说得通的反馈(如"锁舌卡死了"),但不得虚构新事实。
5. 玩家可以用 /look 看房间、/bag 看背包、/map 看地图、/hint 买提示、/game score 查进度。

${scenario.intro}

【当前所在】${lookText(scenario, state)}

用两三句主持人的开场白描述玩家醒来、发现身处阁楼,并等待第一个动作。`
}

function resumeBrief(scenario: EscapeScenario, state: EscapeState): string {
  return `【继续游戏:密室逃脱 · ${scenario.title}】你仍是主持人,不知道谜底。已解谜题 ${state.solved.length}/${scenario.puzzles.length},动作 ${state.turns} 次。请提醒玩家"我们继续",并让玩家用 /look 查看当前房间;玩家动作一律经 escape_examine / escape_take / escape_use / escape_combine / escape_manipulate / escape_solve 工具执行。`
}

// ── 面板(/look /bag /map) ────────────────────────────────────────────────────

export type EscapePanel = 'look' | 'bag' | 'map'

export function panelText(scenario: EscapeScenario, state: EscapeState, panel: EscapePanel): string {
  switch (panel) {
    case 'look':
      return lookText(scenario, state)
    case 'bag': {
      const lines = state.inventory.map((id) => {
        const item = scenario.items.find((i) => i.id === id)
        return item !== undefined ? `- ${item.name}:${item.desc}` : `- ${id}`
      })
      return `【背包】${lines.length > 0 ? `\n${lines.join('\n')}` : '(空)'}`
    }
    case 'map': {
      const lines: string[] = []
      for (const room of scenario.rooms) {
        const here = room.id === state.roomId ? ' ← 你在这里' : ''
        lines.push(`- ${room.name}${here}`)
      }
      for (const door of scenario.doors) {
        const open = state.openDoors.includes(door.id)
        lines.push(`  门:${door.name}${open ? ' · 已开' : ' · 锁着'}`)
      }
      return `【地图】\n${lines.join('\n')}`
    }
  }
}

// ── 引擎入口 ──────────────────────────────────────────────────────────────────

export const escapeEngine: SchemeEngine = {
  id: 'escape',
  label: '密室逃脱',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const scenario = scenarioFor(difficulty, hashString(sessionId))
    const now = Date.now()
    const propStates: Record<string, string> = {}
    for (const prop of scenario.props) propStates[prop.id] = prop.defaultState
    const state: EscapeState = {
      scheme: 'escape',
      difficulty: scenario.difficulty,
      startedAt: now,
      updatedAt: now,
      phase: 'playing' as GamePhase,
      turns: 0,
      hintsUsed: 0,
      score: null,
      scenarioId: scenario.id,
      roomId: scenario.rooms[0]?.id ?? 'attic',
      inventory: [],
      propStates,
      itemStates: {},
      openDoors: [],
      solved: [],
      clues: [],
      bruteForce: [],
      wrongAttempts: 0,
      puzzleHints: {},
    }
    void sessionId
    void hashString
    return { state, truth: scenario, brief: buildBrief(scenario, state) }
  },
  resumeBrief(state, truth) {
    const scenario = (truth as EscapeScenario | undefined) ?? scenarioFor(state.difficulty, 0)
    return resumeBrief(scenario, state as EscapeState)
  },
  scoreText(state, truth) {
    const scenario = (truth as EscapeScenario | undefined) ?? scenarioFor(state.difficulty, 0)
    return scoreText(scenario, state as EscapeState)
  },
  settleText(state, truth) {
    const scenario = truth as EscapeScenario
    const s = state as EscapeState
    const bars = computeScore(scenario, s)
    const answers = scenario.puzzles.map((p) => `- ${p.name}:谜底 ${p.answer}`).join('\n')
    return `【密室逃脱 · 结算】${scenario.title}${s.phase === 'solved' ? ' ✅ 已脱出' : ''}
${bars.map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

【谜底与脱出路径】
${scenario.walkthrough.join('\n')}
${answers}

本局动作:${s.turns} 次 · 提示:${s.hintsUsed} 次 · 错误尝试:${s.wrongAttempts} 次${s.bruteForce.length > 0 ? ` · 暴力猜谜:${s.bruteForce.join('、')}` : ''}`
  },
  hint(state, truth) {
    const scenario = truth as EscapeScenario
    const s = state as EscapeState
    const next = scenario.puzzleOrder.find((id) => !s.solved.includes(id))
    if (next === undefined) return { text: '所有谜题都已解开——去看看第七扇门。' }
    const puzzle = scenario.puzzles.find((p) => p.id === next)
    if (puzzle === undefined) return { text: '暂时没有可用的提示。' }
    const tier = Math.min(s.puzzleHints[next] ?? 0, puzzle.hints.length - 1)
    s.puzzleHints[next] = tier + 1
    return { text: `【提示 ${tier + 1}/${puzzle.hints.length} · ${puzzle.name}】${puzzle.hints[tier]}` }
  },
}

/** 工具层入口:按当前状态调用裁决函数。 */
export function scenarioAndState(truth: unknown, state: EscapeState): EscapeScenario {
  return truth as EscapeScenario
}
