/**
 * 方案五·昨日重现(时间循环,路线图阶段 5,创新旗舰)。
 *
 * v1 落地范围(与 docs/05-time-loop.md 的取舍):
 *   - 时间片引擎:8 时间片/循环,move 消耗 1 片,observe/investigate/talk/act 不耗片;
 *   - 半 reset:世界态(位置/时间片/本循环事件/道具/因果切断)回滚清零,
 *     玩家档案(元知识 facts、好感度 relations、道具认知 knownItems、循环 diff)跨循环保留;
 *   - 手工剧本《北桥镇秋祭日》+ ScheduleSolver(结构/可解路径/无环)+ TruthVault 因果链封存;
 *   - 循环 diff:回滚时对比本循环与上一循环的观测/因果改变;
 *   - 完美日验证:submit_plan 逐条对照关键因果边(行动提及 + 知识门槛)给通过/失败回执;
 *   - NPC 对话走隔离子代理(spawn,工具禁言)或回退无状态 LLM 扮演 + 泄密审计(三不知约束见角色页);
 *     时间循环回滚时对话历史清空,NPC 天然"循环内失忆"。
 *   快进重放与程序化时间表生成已随 v0.15.0 落地。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { type ChatTurn } from '../core/llm.js'
import { talkAsNpc } from '../core/npc.js'
import { auditReply, sanitizedLine, type AuditEntry } from '../core/audit.js'
import { buildNpcSystem, factText, type CaseFact, type NpcScript } from './detective.js'
import { hashString } from '../core/rand.js'
import { generateLoopScript } from './loopgen.js'
import { generateLoopWorld } from './loopworld.js'
import type { SchemeEngine } from '../core/manager.js'

// ── 剧本数据(真相,封存;因果链永不进 GM 上下文) ───────────────────────────────

export interface LoopEvent {
  id: string
  slice: number
  /** 可观测的截止时间片(含);缺省仅 slice 一片。 */
  sliceTo?: number
  location: string
  name: string
  observe: string
  reveals: string[]
  /** 深查:requires(已确认事实)→ 获得道具/事实。 */
  investigate?: { target: string; requires: string[]; item?: string; facts?: string[]; text: string }
}

export interface LoopAction {
  id: string
  name: string
  /** 可执行的起始时间片(含)。 */
  sliceFrom: number
  location: string
  keywords: string[]
  requires: { facts: string[]; items: string[] }
  effect: { cutEdge?: string; item?: string; facts?: string[]; text: string }
}

export interface LoopNpc {
  id: string
  name: string
  role: string
  bio: string
  schedule: { slice: number; location: string; action: string }[]
}

export interface LoopScript {
  id: string
  title: string
  difficulty: number
  intro: string
  sliceCount: number
  sliceNames: string[]
  locations: { id: string; name: string; desc: string }[]
  npcs: LoopNpc[]
  facts: CaseFact[]
  /** 角色页(泄密审计与扮演共用;真相不进角色页)。 */
  npc: Record<string, NpcScript>
  events: LoopEvent[]
  actions: LoopAction[]
  items: { id: string; name: string; desc: string }[]
  tragedy: { slice: number; name: string; collapseDeaths: number; lockedDeaths: number; collapseText: string; lockedText: string }
  keyEdges: string[]
  edgeNotes: Record<string, string>
  /** 封存的完美一日路径(求解器与结算用,不进 GM 上下文)。 */
  winPath: string[]
  /** 因果链(封存,求解器校验无环)。 */
  causalEdges: { from: string; to: string; note: string }[]
  hints: [string, string, string]
  /** 完美一日演出文本(可选;缺省用通用模板)。 */
  winText?: string
}

// ── 手工剧本:北桥镇秋祭日 ─────────────────────────────────────────────────────

export const NORTH_BRIDGE: LoopScript = {
  id: 'north-bridge',
  title: '北桥镇秋祭日',
  difficulty: 2,
  intro:
    '北桥镇的秋祭日,细雨。你是镇上暂住的过客。清晨的镇公所大厅里,镇长正匆匆走出办公室。今日你会度过寻常的一天——直到夜晚,旧钟楼轰然倒塌。',
  sliceCount: 8,
  sliceNames: ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'],
  locations: [
    { id: 'hall', name: '镇公所大厅', desc: '镇公所大厅,镇长办公室的门半掩着。' },
    { id: 'market', name: '集市广场', desc: '秋祭日的集市,摊贩云集,人群熙攘。' },
    { id: 'lib', name: '旧图书馆', desc: '门可罗雀的旧图书馆,角落里积着灰。' },
    { id: 'tower', name: '旧钟楼', desc: '雨中的旧钟楼格外沉默,塔底有一扇上锁的小门。' },
  ],
  npcs: [
    {
      id: 'n_mayor',
      name: '沈培元',
      role: '镇长',
      bio: '北桥镇镇长,十年前主持钟楼翻修,如今春风得意,筹备庆典。',
      schedule: [
        { slice: 0, location: 'hall', action: '办公室批文' },
        { slice: 1, location: 'hall', action: '办公室批文' },
        { slice: 2, location: 'hall', action: '把一把铜钥匙交给邮差' },
        { slice: 3, location: 'market', action: '巡街剪彩' },
        { slice: 4, location: 'hall', action: '在办公室烧账本' },
        { slice: 5, location: 'hall', action: '整理文件' },
        { slice: 6, location: 'tower', action: '把邮差锁进塔底' },
        { slice: 7, location: 'market', action: '发表庆典演讲' },
      ],
    },
    {
      id: 'n_mailman',
      name: '老周',
      role: '邮差',
      bio: '老实巴交的邮差,十年前的旧账知情者,如今对此讳莫如深。',
      schedule: [
        { slice: 0, location: 'market', action: '送信' },
        { slice: 1, location: 'market', action: '送信' },
        { slice: 2, location: 'hall', action: '从镇长手里接过一把铜钥匙' },
        { slice: 3, location: 'market', action: '在集市歇脚打盹' },
        { slice: 4, location: 'market', action: '送信' },
        { slice: 5, location: 'market', action: '收工,在茶摊喝酒' },
        { slice: 6, location: 'tower', action: '被镇长以"检查小门"为名锁进塔底' },
        { slice: 7, location: 'tower', action: '(被困塔底)' },
      ],
    },
    {
      id: 'n_reporter',
      name: '林薇',
      role: '记者',
      bio: '城里来的年轻记者,四处寻找大新闻,对镇长的说辞将信将疑。',
      schedule: [
        { slice: 0, location: 'market', action: '采访摊贩' },
        { slice: 1, location: 'market', action: '采访摊贩' },
        { slice: 2, location: 'market', action: '整理采访笔记' },
        { slice: 3, location: 'market', action: '拍摄剪彩' },
        { slice: 4, location: 'market', action: '采访路人' },
        { slice: 5, location: 'market', action: '在茶摊喝咖啡' },
        { slice: 6, location: 'market', action: '寻找大新闻素材' },
        { slice: 7, location: 'market', action: '报道庆典' },
      ],
    },
  ],
  facts: [
    { id: 'f_tower_lock', type: 'mechanism' as CaseFact['type'], text: '钟楼塔底有一扇上锁的小门,门旁刻着"庆典钟声,百病不侵",需要一把铜钥匙。' },
    { id: 'f_photo', type: 'identity' as CaseFact['type'], text: '十年前的合影与账本残页证明:钟楼翻修时,铆钉就是断裂的,工程款被挪用。', auditKeywords: ['合影', '十年前', '工程款', '挪用', '残页'] },
    { id: 'f_key_handoff', type: 'timeline' as CaseFact['type'], text: '14:00,镇长把塔底的铜钥匙交给了邮差。' },
    { id: 'f_mailman_knows', type: 'identity' as CaseFact['type'], text: '邮差是意外的知情人:十年前他亲眼见过账本上被撕掉的那一页。', auditKeywords: ['那一页', '少了一页', '账本', '亲眼', '撕掉'] },
    { id: 'f_ledger_burn', type: 'timeline' as CaseFact['type'], text: '16:00,镇长在办公室烧掉了账本。' },
    { id: 'f_page_missing', type: 'mechanism' as CaseFact['type'], text: '账本残页显示:钟楼的铆钉十年前就是断裂的,工程款被镇长挪用了。', auditKeywords: ['账本残页', '铆钉', '断裂', '断的', '挪用', '工程款'] },
    { id: 'f_rivet', type: 'mechanism' as CaseFact['type'], text: '断裂的铆钉会在庆典钟声中共振——拆下它,共振就会消失。', auditKeywords: ['共振', '铆钉', '拆', '钟声'] },
    { id: 'f_mailman_locked', type: 'timeline' as CaseFact['type'], text: '18:00,镇长把邮差锁进了塔底,打算让废墟永远封住真相。' },
  ],
  npc: {
    n_mayor: {
      persona: '官腔十足,笑容满面;被问及十年前旧事时眼神一冷。',
      knowledge: ['f_ledger_burn', 'f_mailman_locked', 'f_key_handoff'],
      mustNotAdmit: ['f_page_missing', 'f_photo', 'f_rivet'],
      liePolicy: '矢口否认钟楼有任何问题,把钥匙交接说成"例行公事";绝口不提账本与十年前的工程。',
    },
    n_mailman: {
      persona: '老实巴交,说话吞吞吐吐;被照片戳中时脸色骤变。',
      knowledge: ['f_key_handoff', 'f_mailman_knows'],
      mustNotAdmit: ['f_mailman_knows'],
      liePolicy: '对十年前的事装糊涂;被合影戳穿后才压低声音说出账本少页的事。',
    },
    n_reporter: {
      persona: '机敏利落,职业嗅觉敏锐;听到"证据"二字就两眼放光。',
      knowledge: [],
      mustNotAdmit: [],
      liePolicy: '基本如实;对没有证据的传闻不置可否,但愿意接收爆料。',
    },
  },
  events: [
    {
      id: 'e_tower_door',
      slice: 0,
      sliceTo: 6,
      location: 'tower',
      name: '塔底小门',
      observe: '你在塔底发现一扇上锁的小门,门旁刻着一行字:"庆典钟声,百病不侵。"',
      reveals: ['f_tower_lock'],
      investigate: {
        target: '小门',
        requires: ['f_tower_lock'],
        text: '门锁得很死,需要一把铜钥匙才能打开。',
      },
    },
    {
      id: 'e_photo',
      slice: 0,
      sliceTo: 1,
      location: 'lib',
      name: '档案箱',
      observe: '图书馆角落有一个落灰的档案箱,标签写着"钟楼翻修工程(十年前)"。',
      reveals: [],
      investigate: {
        target: '档案箱',
        requires: [],
        item: 'PHOTO_01',
        facts: ['f_photo'],
        text: '你从档案箱里翻出一张十年前的合影,和半页账目残页夹在一起——铆钉断裂、工程款挪用,白纸黑字。',
      },
    },
    {
      id: 'e_handoff',
      slice: 2,
      location: 'hall',
      name: '钥匙交接',
      observe: '14:00,镇长把一把铜钥匙塞进邮差手里,压低声音:"塔底的小门,去检查一下,别声张。"',
      reveals: ['f_key_handoff'],
    },
    {
      id: 'e_mailman_bag',
      slice: 3,
      location: 'market',
      name: '邮差的挎包',
      observe: '邮差在集市摊边歇脚打盹,挎包就放在脚边。',
      reveals: [],
      investigate: {
        target: '挎包',
        requires: ['f_key_handoff'],
        item: 'KEY_TOWER',
        facts: [],
        text: '你趁邮差打盹,从挎包里摸出了那把铜钥匙。',
      },
    },
    {
      id: 'e_ledger_burn',
      slice: 4,
      location: 'hall',
      name: '烧账本',
      observe: '16:00,镇长在办公室里把一本账本丢进炭盆,火苗蹿起。',
      reveals: ['f_ledger_burn'],
      investigate: {
        target: '炭盆',
        requires: ['f_ledger_burn'],
        item: 'PAGE_77',
        facts: ['f_page_missing', 'f_rivet'],
        text: '炭盆里还剩半页没烧尽:钟楼的铆钉十年前就是断裂的,工程款被挪用了。断裂的铆钉会在庆典钟声中共振——拆下它,共振就会消失。',
      },
    },
    {
      id: 'e_mailman_locked',
      slice: 6,
      location: 'tower',
      name: '邮差被锁',
      observe: '18:00,镇长把邮差推进塔底,从外面挂上了锁——他要让废墟永远封住真相。',
      reveals: ['f_mailman_locked'],
    },
    {
      id: 'e_reporter',
      slice: 6,
      location: 'market',
      name: '寻找素材的记者',
      observe: '记者林薇在集市四处张望,像在寻找大新闻的素材。',
      reveals: [],
    },
  ],
  actions: [
    {
      id: 'a_confront',
      name: '向邮差出示合影',
      sliceFrom: 3,
      location: 'market',
      keywords: ['合影', '照片', 'photo', '出示', '质问'],
      requires: { facts: [], items: ['PHOTO_01'] },
      effect: {
        facts: ['f_mailman_knows'],
        text: '你把合影递过去,邮差脸色骤变:"这、这张照片你是从哪得来的?"他压低声音,"我原以为……没人记得十年前那档子事。镇长当年盖钟楼,账本少了一页,就是这一页。"',
      },
    },
    {
      id: 'a_rivet',
      name: '拆下断裂铆钉',
      sliceFrom: 4,
      location: 'tower',
      keywords: ['拆', '铆钉', '撬', '取下'],
      requires: { facts: ['f_tower_lock'], items: ['KEY_TOWER'] },
      effect: {
        cutEdge: 'edge_resonance',
        text: '你用铜钥匙打开塔底小门,爬上检修梯,拆下了那枚断裂的铆钉——今晚的钟声,不会再共振了。',
      },
    },
    {
      id: 'a_expose',
      name: '把账本残页交给记者',
      sliceFrom: 6,
      location: 'market',
      keywords: ['残页', '账本', '记者', '曝光', '交给'],
      requires: { facts: ['f_ledger_burn'], items: ['PAGE_77'] },
      effect: {
        cutEdge: 'edge_silence',
        text: '记者看到残页后脸色凝重,立刻拨通了卫兵的电话:"十年前钟楼工程的证据,我拿到了。"真相将被公开,塔底的邮差也会获救。',
      },
    },
  ],
  items: [
    { id: 'PHOTO_01', name: '十年前的合影与残页', desc: '镇长与钟楼工程人员的合影,夹着半页账目残页。' },
    { id: 'KEY_TOWER', name: '铜钥匙', desc: '塔底小门的铜钥匙。' },
    { id: 'PAGE_77', name: '账本残页', desc: '没烧尽的那半页账本,记录着断裂的铆钉与被挪用的工程款。' },
  ],
  tragedy: {
    slice: 7,
    name: '旧钟楼倒塌',
    collapseDeaths: 6,
    lockedDeaths: 2,
    collapseText: '19:00,庆典的钟声本该响起,却传来一声巨响——旧钟楼轰然倒塌,卷起尘土与尖叫。',
    lockedText: '废墟之下,还有被锁在塔底的邮差——再没有人知道他曾见过什么。',
  },
  keyEdges: ['edge_resonance', 'edge_silence'],
  edgeNotes: {
    edge_resonance: '断裂铆钉 + 庆典钟声共振 → 钟楼倒塌',
    edge_silence: '镇长灭口 + 无人知情 → 邮差被困塔底遇难',
  },
  winPath: [
    '① 12:00 旧图书馆:翻查档案箱 → 合影与残页(PHOTO_01);',
    '② 14:00 镇公所:目睹镇长把铜钥匙交给邮差;',
    '③ 15:00 集市:摸走邮差挎包里的铜钥匙,出示合影逼他说出旧账;',
    '④ 16:00 镇公所:目睹镇长烧账本,抢出残页(PAGE_77);',
    '⑤ 17:00 旧钟楼:用铜钥匙开塔底小门,拆下断裂铆钉(切断共振);',
    '⑥ 18:00 集市:把残页交给记者(切断灭口,真相公开);',
    '⑦ 19:00:钟声响起,没有共振,没有倒塌;卫兵赶到,邮差获救——完美一日。',
  ],
  causalEdges: [
    { from: 'e_photo', to: 'e_handoff', note: '工程黑幕 → 镇长急于藏匿钥匙' },
    { from: 'e_handoff', to: 'e_mailman_bag', note: '钥匙落到邮差手里' },
    { from: 'e_ledger_burn', to: 'e_mailman_locked', note: '镇长灭口' },
    { from: 'e_mailman_locked', to: 'edge_silence', note: '无人知情 → 邮差遇难' },
    { from: 'e_photo', to: 'edge_resonance', note: '断裂铆钉 → 共振隐患' },
    { from: 'edge_resonance', to: 'tragedy', note: '钟声共振 → 倒塌' },
    { from: 'edge_silence', to: 'tragedy', note: '邮差被困 → 遇难' },
  ],
  hints: [
    '把每个时间点"谁在哪儿、做了什么"记下来——尤其注意 14:00 的镇公所。',
    '有些东西要"先知道,才拿得到":比如邮差脚边的挎包。',
    '要改写结局,必须同时做到两件事:让钟声不再共振,让真相不再沉默。',
  ],
  winText: '【19:00 · 完美一日】庆典的钟声响起——没有共振,没有倒塌。卫兵赶到,塔底的邮差获救;记者手里的残页,让十年前的真相再无法被埋进废墟。这一天,终于可以走到尽头了。',
}

// ── 手工剧本二:客栈大火 ─────────────────────────────────────────────────────

export const INN_FIRE: LoopScript = {
  id: 'inn-fire',
  title: '客栈大火',
  difficulty: 2,
  intro: '你投宿在雾水镇的「来福客栈」。入夜,一场大火将吞没客栈,八条人命将葬身火海——而你记得明天。',
  sliceCount: 8,
  sliceNames: ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'],
  locations: [
    { id: 'inn', name: '客栈大厅', desc: '来福客栈的大厅,油灯昏黄,楼上住满了旅客。' },
    { id: 'kitchen', name: '后厨', desc: '油腻的后厨,灶台旁堆着稻草和柴火。' },
    { id: 'stable', name: '马厩', desc: '客栈后的马厩,工具箱挂在柱子上。' },
    { id: 'street', name: '街市', desc: '雾水镇的街市,巡捕每晚都会巡街经过。' },
  ],
  npcs: [
    {
      id: 'n_owner',
      name: '钱掌柜',
      role: '客栈老板',
      bio: '来福客栈的老板,近来愁眉不展,据说欠了一屁股债。',
      schedule: [
        { slice: 0, location: 'inn', action: '擦桌子' },
        { slice: 1, location: 'inn', action: '柜台记账' },
        { slice: 2, location: 'kitchen', action: '在灶台边烧账本' },
        { slice: 3, location: 'inn', action: '把后门锁上' },
        { slice: 4, location: 'inn', action: '迎客' },
        { slice: 5, location: 'inn', action: '给油灯添油' },
        { slice: 6, location: 'inn', action: '招呼旅客开饭' },
        { slice: 7, location: 'inn', action: '(大火中)' },
      ],
    },
    {
      id: 'n_groom',
      name: '老马',
      role: '马夫',
      bio: '客栈马夫,老实巴交,看见过不该看的事却不敢说。',
      schedule: [
        { slice: 0, location: 'stable', action: '喂马' },
        { slice: 1, location: 'stable', action: '刷马' },
        { slice: 2, location: 'stable', action: '打盹' },
        { slice: 3, location: 'stable', action: '喂马' },
        { slice: 4, location: 'stable', action: '修车' },
        { slice: 5, location: 'stable', action: '打盹' },
        { slice: 6, location: 'stable', action: '收工' },
        { slice: 7, location: 'stable', action: '(困在马厩)' },
      ],
    },
    {
      id: 'n_patrol',
      name: '班头',
      role: '巡捕班头',
      bio: '巡街的班头,眼里揉不得沙子。',
      schedule: [
        { slice: 0, location: 'street', action: '巡街' },
        { slice: 1, location: 'street', action: '巡街' },
        { slice: 2, location: 'street', action: '巡街' },
        { slice: 3, location: 'street', action: '巡街' },
        { slice: 4, location: 'street', action: '巡街' },
        { slice: 5, location: 'street', action: '巡街' },
        { slice: 6, location: 'street', action: '巡街' },
        { slice: 7, location: 'street', action: '巡街' },
      ],
    },
  ],
  facts: [
    { id: 'f_lamp_leak', type: 'mechanism' as CaseFact['type'], text: '大厅的油灯漏油,灯芯歪斜——夜里风一起就会翻倒。', auditKeywords: ['漏油', '油灯', '翻倒'] },
    { id: 'f_straw', type: 'mechanism' as CaseFact['type'], text: '灯油浸湿了墙角的稻草堆,一点火星就会燎原。' },
    { id: 'f_insurance', type: 'motive' as CaseFact['type'], text: '钱掌柜欠下巨债,给客栈买了巨额火险——账本残页记着亏空与保险单。', auditKeywords: ['纵火', '骗保', '火险', '保险', '亏空'] },
    { id: 'f_door_locked', type: 'timeline' as CaseFact['type'], text: '15:00,钱掌柜把后门锁死了,旅客唯一的逃生路被堵上。', auditKeywords: ['锁后门', '后门锁', '锁了门'] },
    { id: 'f_patrol', type: 'timeline' as CaseFact['type'], text: '巡捕班头每天 17:00 巡街经过客栈门前。' },
  ],
  npc: {
    n_owner: {
      persona: '满脸堆笑,眼神却躲闪;被问起账目就岔开话题。',
      knowledge: ['f_insurance', 'f_door_locked'],
      mustNotAdmit: ['f_insurance', 'f_door_locked'],
      liePolicy: '矢口否认纵火,把后门的事说成"防贼"。',
    },
    n_groom: {
      persona: '老实巴交,说话吞吞吐吐。',
      knowledge: ['f_door_locked', 'f_lamp_leak'],
      mustNotAdmit: ['f_door_locked'],
      liePolicy: '被问起后门就支支吾吾,说"没瞧见"。',
    },
    n_patrol: {
      persona: '公事公办,嗓门洪亮。',
      knowledge: ['f_patrol'],
      mustNotAdmit: [],
      liePolicy: '基本如实,只认证据。',
    },
  },
  events: [
    {
      id: 'e_lamp',
      slice: 0,
      sliceTo: 2,
      location: 'inn',
      name: '漏油的油灯',
      observe: '大厅的油灯漏着油,灯芯歪斜,墙角的稻草堆被灯油浸湿了一角。',
      reveals: ['f_lamp_leak'],
      investigate: { target: '油灯', requires: ['f_lamp_leak'], facts: ['f_straw'], text: '油灯确实漏油,夜里一起风就会翻倒,溅到稻草堆上。' },
    },
    {
      id: 'e_tools',
      slice: 1,
      sliceTo: 3,
      location: 'stable',
      name: '马厩工具箱',
      observe: '马厩的柱子上挂着一只工具箱。',
      reveals: [],
      investigate: { target: '工具箱', requires: [], item: 'PINCERS', text: '工具箱里有一把铁钳,可以夹紧油灯的灯芯座。' },
    },
    {
      id: 'e_ledger',
      slice: 2,
      location: 'kitchen',
      name: '烧账本',
      observe: '14:00,钱掌柜在后厨把一本账本丢进灶火里。',
      reveals: ['f_insurance'],
      investigate: { target: '灶台', requires: ['f_insurance'], item: 'PAGE_01', text: '你从灶火边抢出半页没烧尽的账本:客栈亏空累累,却买了一份巨额火险。' },
    },
    {
      id: 'e_door',
      slice: 3,
      location: 'inn',
      name: '锁后门',
      observe: '15:00,钱掌柜把后门锁死,钥匙揣进怀里。',
      reveals: ['f_door_locked'],
    },
    {
      id: 'e_patrol',
      slice: 5,
      sliceTo: 6,
      location: 'street',
      name: '巡街的班头',
      observe: '巡捕班头按刀巡街,经过客栈门前。',
      reveals: ['f_patrol'],
    },
  ],
  actions: [
    {
      id: 'a_fix_lamp',
      name: '用铁钳修好油灯',
      sliceFrom: 3,
      location: 'inn',
      keywords: ['修', '油灯', '夹', '钳'],
      requires: { facts: ['f_lamp_leak'], items: ['PINCERS'] },
      effect: { cutEdge: 'edge_fire', text: '你用铁钳夹紧灯芯座,油灯稳稳当当——今夜的大风,吹不翻它了。' },
    },
    {
      id: 'a_report',
      name: '把账本残页交给巡捕',
      sliceFrom: 5,
      location: 'street',
      keywords: ['残页', '账本', '巡捕', '班头', '报官', '交'],
      requires: { facts: ['f_insurance'], items: ['PAGE_01'] },
      effect: { cutEdge: 'edge_lock', text: '班头看了残页,脸色一沉:"火险?亏空?来人,把客栈围了!"后门被破开,旅客全数疏散。' },
    },
  ],
  items: [
    { id: 'PINCERS', name: '铁钳', desc: '一把铁钳。' },
    { id: 'PAGE_01', name: '账本残页', desc: '没烧尽的半页账本,记着亏空与火险。' },
  ],
  tragedy: {
    slice: 7,
    name: '客栈大火',
    collapseDeaths: 6,
    lockedDeaths: 2,
    collapseText: '19:00,一阵大风掀翻了漏油的油灯,火苗蹿上浸油的稻草堆——客栈瞬间成了一支火炬,楼上的旅客再没能下来。',
    lockedText: '后门紧锁,两个人影拍打着门板,渐渐没了声息。',
  },
  keyEdges: ['edge_fire', 'edge_lock'],
  edgeNotes: { edge_fire: '漏油灯 + 大风 + 稻草堆 → 大火', edge_lock: '后门锁死 + 无人报警 → 困死两人' },
  winPath: [
    '① 12:00 客栈大厅:观察漏油的油灯;',
    '② 13:00 马厩:从工具箱取铁钳;',
    '③ 14:00 后厨:目睹钱掌柜烧账本,抢出残页(PAGE_01);',
    '④ 15:00 客栈大厅:目睹后门被锁;',
    '⑤ 15:00 客栈大厅:用铁钳修好油灯(切断大火);',
    '⑥ 17:00 街市:把账本残页交给巡捕(切断困人,破门疏散);',
    '⑦ 19:00:风起了,灯没翻,火没烧;巡捕破开后门——无人遇难,完美一日。',
  ],
  causalEdges: [
    { from: 'e_lamp', to: 'edge_fire', note: '漏油灯 → 火患' },
    { from: 'e_ledger', to: 'edge_lock', note: '骗保动机 → 锁门灭口' },
    { from: 'edge_fire', to: 'tragedy', note: '大火 → 旅客遇难' },
    { from: 'edge_lock', to: 'tragedy', note: '后门锁死 → 困死两人' },
  ],
  hints: ['先把客栈里"不对劲的东西"记下来——尤其那盏灯。', '有些证据会被毁掉:去后厨的灶火边看看。', '要改写结局,既要灭了火源,也要让后门不再是死路。'],
  winText: '【19:00 · 完美一日】风起了,油灯没翻,火没烧起来;巡捕看了残页,带人破开后门,客栈全员疏散。这一夜,无人遇难。',
}

// ── 手工剧本三:宴会中毒 ─────────────────────────────────────────────────────

export const BANQUET_POISON: LoopScript = {
  id: 'banquet-poison',
  title: '宴会中毒',
  difficulty: 2,
  intro: '你是受邀赴宴的宾客。今晚,顾府的接风宴上,一锅汤将夺走八条人命——而你记得明天。',
  sliceCount: 8,
  sliceNames: ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'],
  locations: [
    { id: 'hall', name: '宴会厅', desc: '张灯结彩的宴会厅,长桌已经摆开,宾客陆续落座。' },
    { id: 'kitchen', name: '厨房', desc: '忙得脚不沾地的厨房,大锅里的汤咕嘟咕嘟。' },
    { id: 'apothecary', name: '药铺', desc: '镇上的药铺,柜台后的老板打着算盘。' },
    { id: 'garden', name: '花园', desc: '顾府的后花园,假山后能藏下一个人。' },
  ],
  npcs: [
    {
      id: 'n_butler',
      name: '顾福',
      role: '管家',
      bio: '顾府管家,侍奉顾家二十年,最近被发现在账目上做手脚。',
      schedule: [
        { slice: 0, location: 'hall', action: '布置宴会' },
        { slice: 1, location: 'kitchen', action: '查看汤锅' },
        { slice: 2, location: 'garden', action: '与神秘人会面' },
        { slice: 3, location: 'kitchen', action: '查看汤锅' },
        { slice: 4, location: 'kitchen', action: '往汤锅里加"佐料"' },
        { slice: 5, location: 'hall', action: '招待宾客' },
        { slice: 6, location: 'hall', action: '宣布开宴' },
        { slice: 7, location: 'hall', action: '(毒发)' },
      ],
    },
    {
      id: 'n_cook',
      name: '厨娘',
      role: '厨娘',
      bio: '顾府的厨娘,今晚的汤就是她熬的。',
      schedule: [
        { slice: 0, location: 'kitchen', action: '熬汤' },
        { slice: 1, location: 'kitchen', action: '熬汤' },
        { slice: 2, location: 'kitchen', action: '备菜' },
        { slice: 3, location: 'kitchen', action: '备菜' },
        { slice: 4, location: 'kitchen', action: '备菜' },
        { slice: 5, location: 'kitchen', action: '上菜' },
        { slice: 6, location: 'kitchen', action: '收拾' },
        { slice: 7, location: 'kitchen', action: '(毒发)' },
      ],
    },
    {
      id: 'n_herbalist',
      name: '药铺老板',
      role: '药铺老板',
      bio: '镇上药铺的老板,记性极好。',
      schedule: [
        { slice: 0, location: 'apothecary', action: '看店' },
        { slice: 1, location: 'apothecary', action: '看店' },
        { slice: 2, location: 'apothecary', action: '看店' },
        { slice: 3, location: 'apothecary', action: '看店' },
        { slice: 4, location: 'apothecary', action: '看店' },
        { slice: 5, location: 'apothecary', action: '看店' },
        { slice: 6, location: 'apothecary', action: '看店' },
        { slice: 7, location: 'apothecary', action: '看店' },
      ],
    },
  ],
  facts: [
    { id: 'f_purchase', type: 'motive' as CaseFact['type'], text: '昨天有人从药铺买走了砒霜,买主遮着脸——但老板记得那对管家制服的袖口。', auditKeywords: ['砒霜', '买主', '袖口', '管家'] },
    { id: 'f_shadow', type: 'timeline' as CaseFact['type'], text: '14:00,厨娘看见一个穿管家制服的人影进了厨房。', auditKeywords: ['人影', '管家制服', '进了厨房'] },
    { id: 'f_vial', type: 'mechanism' as CaseFact['type'], text: '碗柜深处藏着一只砒霜药瓶,还剩小半瓶。', auditKeywords: ['砒霜', '药瓶', '毒药', '小半瓶'] },
    { id: 'f_soup', type: 'timeline' as CaseFact['type'], text: '16:00,管家往汤锅里倒进了什么。', auditKeywords: ['下毒', '倒进', '汤锅', '加料'] },
    { id: 'f_banquet', type: 'timeline' as CaseFact['type'], text: '18:00 开宴,汤会分给每一位宾客。' },
  ],
  npc: {
    n_butler: {
      persona: '彬彬有礼,眼底却藏着冷意。',
      knowledge: ['f_vial', 'f_soup', 'f_purchase'],
      mustNotAdmit: ['f_vial', 'f_soup', 'f_purchase'],
      liePolicy: '矢口否认下毒,把汤说成"祖传秘方"。',
    },
    n_cook: {
      persona: '爽利,嗓门大,护食。',
      knowledge: ['f_shadow'],
      mustNotAdmit: ['f_shadow'],
      liePolicy: '怕惹祸上身,先否认见过人影,被追问才改口。',
    },
    n_herbalist: {
      persona: '慢条斯理,记性极好。',
      knowledge: ['f_purchase'],
      mustNotAdmit: [],
      liePolicy: '如实相告,但不指认。',
    },
  },
  events: [
    {
      id: 'e_purchase',
      slice: 0,
      sliceTo: 2,
      location: 'apothecary',
      name: '购药记录',
      observe: '药铺老板翻着账本:"昨天有个人买了砒霜,遮着脸——不过那袖口,像是哪家的管家制服。"',
      reveals: ['f_purchase'],
    },
    {
      id: 'e_shadow',
      slice: 2,
      location: 'kitchen',
      name: '厨房里的人影',
      observe: '14:00,厨娘压低声音:她看见一个穿管家制服的人影进了厨房。',
      reveals: ['f_shadow'],
    },
    {
      id: 'e_vial',
      slice: 3,
      sliceTo: 3,
      location: 'kitchen',
      name: '碗柜深处',
      observe: '碗柜深处有东西反着光。',
      reveals: [],
      investigate: { target: '碗柜', requires: ['f_shadow'], item: 'VIAL', facts: ['f_vial'], text: '你在碗柜深处摸出一只砒霜药瓶,还剩小半瓶。' },
    },
    {
      id: 'e_soup',
      slice: 4,
      location: 'kitchen',
      name: '下毒',
      observe: '16:00,你躲在灶台后看见:管家往汤锅里倒进了什么。',
      reveals: ['f_soup'],
    },
    {
      id: 'e_banquet',
      slice: 6,
      location: 'hall',
      name: '开宴在即',
      observe: '18:00 开宴,汤会分给每一位宾客。',
      reveals: ['f_banquet'],
    },
  ],
  actions: [
    {
      id: 'a_dump_soup',
      name: '倒掉毒汤',
      sliceFrom: 5,
      location: 'kitchen',
      keywords: ['倒掉', '换掉', '打翻', '泼', '汤锅'],
      requires: { facts: ['f_soup'], items: [] },
      effect: { cutEdge: 'edge_poison', text: '你一把掀翻汤锅,毒汤泼了一地。"汤坏了,重新熬!"——厨娘骂骂咧咧,却也只好照办。' },
    },
    {
      id: 'a_expose',
      name: '当众出示毒药瓶',
      sliceFrom: 6,
      location: 'hall',
      keywords: ['药瓶', '示众', '揭穿', '砒霜', '当众', '出示'],
      requires: { facts: ['f_vial'], items: ['VIAL'] },
      effect: { cutEdge: 'edge_evidence', text: '你把砒霜药瓶拍在桌上,宾客哗然。管家面如死灰——证据在众目睽睽之下,再也销毁不了了。' },
    },
  ],
  items: [{ id: 'VIAL', name: '砒霜药瓶', desc: '还剩小半瓶的砒霜。' }],
  tragedy: {
    slice: 7,
    name: '毒宴',
    collapseDeaths: 6,
    lockedDeaths: 2,
    collapseText: '19:00,汤端上桌,宾客们举碗——随即一个个捂住喉咙倒下。',
    lockedText: '混乱中,管家把毒药瓶丢进灶火,证据灰飞烟灭;后厨的两个杂役也因"试味"送了命。',
  },
  keyEdges: ['edge_poison', 'edge_evidence'],
  edgeNotes: { edge_poison: '毒汤上桌 → 宾客中毒', edge_evidence: '证据销毁 + 无人指认 → 真凶逍遥,杂役枉死' },
  winPath: [
    '① 12:00 药铺:问出砒霜买家;',
    '② 14:00 厨房:听厨娘说人影;',
    '③ 15:00 厨房:从碗柜搜出砒霜药瓶(VIAL);',
    '④ 16:00 厨房:目睹管家下毒;',
    '⑤ 17:00 厨房:倒掉毒汤(切断中毒);',
    '⑥ 18:00 宴会厅:当众出示药瓶(切断销毁证据);',
    '⑦ 19:00:新汤上桌,宾主尽欢;管家被众人摁住——无人中毒,完美一日。',
  ],
  causalEdges: [
    { from: 'e_purchase', to: 'edge_poison', note: '购毒 → 下毒' },
    { from: 'e_soup', to: 'edge_poison', note: '毒汤 → 中毒' },
    { from: 'e_vial', to: 'edge_evidence', note: '药瓶 → 唯一物证' },
    { from: 'edge_poison', to: 'tragedy', note: '中毒 → 遇难' },
    { from: 'edge_evidence', to: 'tragedy', note: '灭证 → 枉死' },
  ],
  hints: ['先查"毒从哪来":药铺的账本会说话。', '厨房里有两样东西值得翻一翻。', '要改写结局:汤不能上桌,证据也不能消失。'],
  winText: '【19:00 · 完美一日】新汤端上桌,宾主尽欢;你手里的药瓶让管家无从抵赖,众人一拥而上将他摁住。这一夜,无人中毒。',
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

export interface LoopDiff {
  fromLoop: number
  toLoop: number
  changed: string[]
  cause: string
}

export interface LoopState extends GameStateBase {
  scheme: 'loop'
  scriptId: string
  loopNo: number
  slice: number
  location: string
  /** 持久:元知识清单。 */
  facts: string[]
  /** 持久:好感度。 */
  relations: Record<string, number>
  /** 持久:道具认知(曾获得过的物品)。 */
  knownItems: string[]
  /** 本循环:背包。 */
  items: string[]
  /** 本循环:已观测事件。 */
  observed: string[]
  /** 本循环:已切断因果边。 */
  cutEdges: string[]
  /** 上一循环的观测与切断快照(用于 diff)。 */
  lastObserved: string[]
  lastCutEdges: string[]
  lastDeaths: number | null
  loopDiffs: LoopDiff[]
  loopsMax: number
  /** 本循环对话历史(扮演与审计用)。 */
  conversations: Record<string, ChatTurn[]>
  auditLog?: AuditEntry[]
  planVerdict: string | null
}

const LOCATION_IDS: Record<string, string> = { hall: '镇公所大厅', market: '集市广场', lib: '旧图书馆', tower: '旧钟楼' }

function locationName(script: LoopScript, id: string): string {
  return script.locations.find((l) => l.id === id)?.name ?? id
}

function npcAt(script: LoopScript, npcId: string, slice: number): { location: string; action: string } | null {
  const npc = script.npcs.find((n) => n.id === npcId)
  const slot = npc?.schedule.find((s) => s.slice === slice)
  return slot !== undefined ? { location: slot.location, action: slot.action } : null
}

// ── 求解器(ScheduleSolver) ────────────────────────────────────────────────────

export interface LoopSolveReport {
  ok: boolean
  errors: string[]
  /** 求解器找到的可排程计划(时间片升序;测试/回放用)。 */
  plan?: { slice: number; location: string; label: string }[]
}

export function solveLoop(script: LoopScript): LoopSolveReport {
  const errors: string[] = []
  const factIds = new Set(script.facts.map((f) => f.id))
  const eventIds = new Set(script.events.map((e) => e.id))
  const locationIds = new Set(script.locations.map((l) => l.id))
  const npcIds = new Set(script.npcs.map((n) => n.id))

  // 结构:引用可解析
  for (const e of script.events) {
    if (e.slice < 0 || e.slice >= script.sliceCount) errors.push(`事件 ${e.id} 时间片越界`)
    if (!locationIds.has(e.location)) errors.push(`事件 ${e.id} 地点未知`)
    for (const f of e.reveals) if (!factIds.has(f)) errors.push(`事件 ${e.id} 引用了未知事实 ${f}`)
    if (e.investigate !== undefined) {
      for (const f of e.investigate.requires) if (!factIds.has(f)) errors.push(`事件 ${e.id} 深查引用了未知事实 ${f}`)
      for (const f of e.investigate.facts ?? []) if (!factIds.has(f)) errors.push(`事件 ${e.id} 深查产出了未定义事实 ${f}`)
    }
  }
  for (const a of script.actions) {
    if (!locationIds.has(a.location)) errors.push(`行动 ${a.id} 地点未知`)
    for (const f of a.requires.facts) if (!factIds.has(f)) errors.push(`行动 ${a.id} 引用了未知事实 ${f}`)
    for (const f of a.effect.facts ?? []) if (!factIds.has(f)) errors.push(`行动 ${a.id} 产出了未定义事实 ${f}`)
    if (a.effect.cutEdge !== undefined && !script.keyEdges.includes(a.effect.cutEdge)) errors.push(`行动 ${a.id} 切断了未知因果边`)
  }
  for (const n of script.npcs) {
    for (const s of n.schedule) {
      if (s.slice < 0 || s.slice >= script.sliceCount) errors.push(`NPC ${n.id} 时间表越界`)
      if (!locationIds.has(s.location)) errors.push(`NPC ${n.id} 时间表地点未知`)
    }
  }
  if (!script.keyEdges.every((k) => k in script.edgeNotes)) errors.push('关键因果边缺少说明')
  for (const e of script.causalEdges) {
    const nodeIds = new Set([...eventIds, ...script.keyEdges, 'tragedy'])
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) errors.push(`因果边 ${e.from}→${e.to} 端点未知`)
  }

  // 关键边可切断:每条关键边都有行动可达(知识门槛可满足,时间地点可排)
  for (const edge of script.keyEdges) {
    const action = script.actions.find((a) => a.effect.cutEdge === edge)
    if (action === undefined) {
      errors.push(`关键边 ${edge} 没有任何行动可以切断`)
      continue
    }
    for (const fact of action.requires.facts) {
      const obtainable = script.events.some((e) => (e.reveals.includes(fact) || (e.investigate?.facts ?? []).includes(fact)) && e.slice <= action.sliceFrom)
      const viaAction = script.actions.some((a) => (a.effect.facts ?? []).includes(fact) && a.sliceFrom <= action.sliceFrom)
      if (!obtainable && !viaAction) errors.push(`行动 ${action.id} 需要的知识 ${fact} 在其时间片前无法获得`)
    }
    for (const item of action.requires.items) {
      const obtainable = script.events.some((e) => e.investigate?.item === item && e.slice <= action.sliceFrom)
      if (!obtainable) errors.push(`行动 ${action.id} 需要的道具 ${item} 在其时间片前无法获得`)
    }
  }

  // 可解路径:所需观测/行动在时间片-地点上可排程(窗口 DFS:同一片不能同时在两地)
  interface Demand {
    sliceFrom: number
    sliceTo: number
    location: string
    label: string
  }
  const demands: Demand[] = []
  let plan: { slice: number; location: string; label: string }[] | undefined
  const factSeen = new Set<string>()
  const addFactDemand = (fact: string, maxSlice: number): void => {
    if (factSeen.has(fact)) return
    factSeen.add(fact)
    const ev = script.events.find((e) => (e.reveals.includes(fact) || (e.investigate?.facts ?? []).includes(fact)) && e.slice <= maxSlice)
    if (ev === undefined) return
    demands.push({ sliceFrom: ev.slice, sliceTo: ev.sliceTo ?? ev.slice, location: ev.location, label: `知识:${fact}` })
    // 深查前置知识也必须在同一循环内可达(链式)
    for (const req of ev.investigate?.requires ?? []) addFactDemand(req, ev.slice)
  }
  const addItemDemand = (item: string, maxSlice: number): void => {
    const ev = script.events.find((e) => e.investigate?.item === item && e.slice <= maxSlice)
    if (ev === undefined) return
    demands.push({ sliceFrom: ev.slice, sliceTo: ev.sliceTo ?? ev.slice, location: ev.location, label: `道具:${item}` })
    for (const req of ev.investigate?.requires ?? []) addFactDemand(req, ev.slice)
  }
  for (const edge of script.keyEdges) {
    const action = script.actions.find((a) => a.effect.cutEdge === edge)
    if (action !== undefined) {
      demands.push({ sliceFrom: action.sliceFrom, sliceTo: script.sliceCount - 1, location: action.location, label: action.id })
      for (const fact of action.requires.facts) addFactDemand(fact, action.sliceFrom)
      for (const item of action.requires.items) addItemDemand(item, action.sliceFrom)
    }
  }
  {
    const assigned = new Map<number, string>()
    const placed = new Array<number>(demands.length).fill(-1)
    const conflictFree = (idx: number): boolean => {
      if (idx >= demands.length) return true
      const d = demands[idx]
      for (let slice = d.sliceFrom; slice <= d.sliceTo; slice++) {
        const at = assigned.get(slice)
        if (at !== undefined && at !== d.location) continue
        const prev = assigned.get(slice)
        assigned.set(slice, d.location)
        placed[idx] = slice
        if (conflictFree(idx + 1)) return true
        placed[idx] = -1
        if (prev === undefined) assigned.delete(slice)
        else assigned.set(slice, prev)
      }
      return false
    }
    if (!conflictFree(0)) {
      const conflicts = [...new Set(demands.map((d) => `${d.label}@${d.sliceFrom}-${d.sliceTo}(${d.location})`))].join(';')
      errors.push(`关键步骤在同一循环内无法排程:${conflicts}`)
    } else {
      plan = demands
        .map((d, i) => ({ slice: placed[i], location: d.location, label: d.label }))
        .sort((a, b) => a.slice - b.slice)
    }
  }

  // 因果链无环(拓扑)
  {
    const nodes = new Set<string>([...eventIds, ...script.keyEdges, 'tragedy'])
    const out = new Map<string, string[]>()
    for (const n of nodes) out.set(n, [])
    for (const e of script.causalEdges) out.get(e.from)?.push(e.to)
    const state2 = new Map<string, number>()
    for (const n of nodes) state2.set(n, 0)
    const visit = (n: string, path: string[]): boolean => {
      state2.set(n, 1)
      for (const m of out.get(n) ?? []) {
        if (state2.get(m) === 1) {
          errors.push(`因果链存在环:${path.join('→')}→${m}`)
          return false
        }
        if (state2.get(m) === 0 && !visit(m, [...path, m])) return false
      }
      state2.set(n, 2)
      return true
    }
    for (const n of nodes) if (state2.get(n) === 0) visit(n, [n])
  }

  return { ok: errors.length === 0, errors, plan }
}

// ── 裁决(纯函数) ──────────────────────────────────────────────────────────────

export interface LoopResult {
  text: string
  won?: boolean
  looped?: boolean
}

function recordFacts(state: LoopState, factIds: string[]): string[] {
  const added: string[] = []
  for (const id of factIds) {
    if (!state.facts.includes(id)) {
      state.facts.push(id)
      added.push(id)
    }
  }
  return added
}

function grantItem(state: LoopState, itemId: string): boolean {
  if (state.items.includes(itemId)) return false
  state.items.push(itemId)
  if (!state.knownItems.includes(itemId)) state.knownItems.push(itemId)
  return true
}

/** 时间片推进:move 消耗 1 片;到达悲剧时间片则结算。 */
export function move(script: LoopScript, state: LoopState, to: string): LoopResult {
  const target = script.locations.find((l) => l.id === to || l.name === to || l.name.includes(to) || to.includes(l.name))
  if (target === undefined) {
    return { text: `没有「${to}」这个地方。可选:${script.locations.map((l) => l.name).join('、')}。` }
  }
  if (state.slice + 1 >= script.sliceCount) {
    return { text: '今天已经走到尽头了。' }
  }
  state.slice += 1
  state.location = target.id
  state.turns += 1
  if (state.slice >= script.tragedy.slice) {
    return resolveTragedy(script, state)
  }
  const auto = autoObserve(script, state)
  const here = npcsHere(script, state)
  const lines = [`现在是 ${script.sliceNames[state.slice]},你来到${locationName(script, target.id)}。`]
  lines.push(auto.text)
  if (here.length > 0) lines.push(`在场的人:${here.join('、')}`)
  return { text: lines.filter((l) => l !== '').join('\n') }
}

function npcsHere(script: LoopScript, state: LoopState): string[] {
  return script.npcs.filter((n) => npcAt(script, n.id, state.slice)?.location === state.location).map((n) => `${n.name}(${npcAt(script, n.id, state.slice)?.action})`)
}

function autoObserve(script: LoopScript, state: LoopState): LoopResult {
  const fresh = script.events.filter((e) => e.slice <= state.slice && state.slice <= (e.sliceTo ?? e.slice) && e.location === state.location && !state.observed.includes(e.id))
  if (fresh.length === 0) return { text: '' }
  for (const e of fresh) state.observed.push(e.id)
  const added = recordFacts(state, fresh.flatMap((e) => e.reveals))
  const lines = fresh.map((e) => `【目击 · ${e.name}】${e.observe}`)
  if (added.length > 0) lines.push(`(元知识 +${added.length}:${added.map((id) => factText(script, id)).join(';')})`)
  return { text: lines.join('\n') }
}

/** observe:看当前时间片/地点的可见投影。 */
export function observe(script: LoopScript, state: LoopState): LoopResult {
  const auto = autoObserve(script, state)
  const here = npcsHere(script, state)
  const lines: string[] = [`【${script.sliceNames[state.slice]} · ${locationName(script, state.location)}】`]
  lines.push(script.locations.find((l) => l.id === state.location)?.desc ?? '')
  if (auto.text !== '') lines.push(auto.text)
  lines.push(here.length > 0 ? `在场的人:${here.join('、')}` : '附近没有别人。')
  lines.push(`已记录元知识 ${state.facts.length} 条(/facts 可查)。`)
  return { text: lines.join('\n') }
}

/** investigate:深查当前时间片/地点的机关或物件。 */
export function investigate(script: LoopScript, state: LoopState, target: string): LoopResult {
  const norm = target.trim().toLowerCase()
  const candidates = script.events.filter((e) => e.slice <= state.slice && state.slice <= (e.sliceTo ?? e.slice) && e.location === state.location && e.investigate !== undefined && (e.investigate.target.includes(norm) || norm.includes(e.investigate.target.toLowerCase())))
  if (candidates.length === 0) {
    return { text: `这里没有可以深查的「${target}」。` }
  }
  if (candidates.length > 1) {
    return { text: `「${target}」有歧义,可能是:${candidates.map((e) => e.investigate?.target).join('、')}。` }
  }
  const event = candidates[0]
  const inv = event.investigate
  if (inv === undefined) return { text: '这里没什么可深查的。' }
  const missing = inv.requires.filter((f) => !state.facts.includes(f))
  if (missing.length > 0) {
    return { text: '你翻找了一番,却什么也没找到——你似乎还缺一点"先知道什么"的线索。' }
  }
  const lines: string[] = [inv.text]
  if (inv.item !== undefined && grantItem(state, inv.item)) {
    const item = script.items.find((i) => i.id === inv.item)
    lines.push(`(获得道具:${item?.name ?? inv.item})`)
  }
  const added = recordFacts(state, inv.facts ?? [])
  if (added.length > 0) lines.push(`(元知识 +${added.length}:${added.map((id) => factText(script, id)).join(';')})`)
  state.turns += 1
  return { text: lines.join('\n') }
}

/** act:执行因果行动(可能切断关键边)。 */
export function act(script: LoopScript, state: LoopState, actionText: string): LoopResult {
  const norm = actionText.trim().toLowerCase()
  const candidates = script.actions.filter((a) => state.slice >= a.sliceFrom && state.location === a.location && a.keywords.some((k) => norm.includes(k.toLowerCase())))
  if (candidates.length === 0) {
    state.turns += 1
    return { text: '你试着做了点什么,但似乎没有效果——时间、地点,或者方式不对。' }
  }
  const ready = candidates.find((a) => a.requires.facts.every((f) => state.facts.includes(f)) && a.requires.items.every((i) => state.items.includes(i)))
  if (ready === undefined) {
    const a = candidates[0]
    const missingFacts = a.requires.facts.filter((f) => !state.facts.includes(f))
    const missingItems = a.requires.items.filter((i) => !state.items.includes(i))
    const parts: string[] = []
    if (missingFacts.length > 0) parts.push(`还缺线索:${missingFacts.map((f) => factText(script, f)).join(';')}`)
    if (missingItems.length > 0) parts.push(`还缺道具:${missingItems.map((i) => script.items.find((it) => it.id === i)?.name ?? i).join(';')}`)
    state.turns += 1
    return { text: `这个行动还差条件——${parts.join(';')}。` }
  }
  const lines: string[] = [ready.effect.text]
  if (ready.effect.cutEdge !== undefined && !state.cutEdges.includes(ready.effect.cutEdge)) {
    state.cutEdges.push(ready.effect.cutEdge)
    lines.push(`(因果改变:已切断「${script.edgeNotes[ready.effect.cutEdge]}」)`)
  }
  if (ready.effect.item !== undefined) grantItem(state, ready.effect.item)
  const added = recordFacts(state, ready.effect.facts ?? [])
  if (added.length > 0) lines.push(`(元知识 +${added.length}:${added.map((id) => factText(script, id)).join(';')})`)
  state.turns += 1
  return { text: lines.join('\n') }
}

/** talk:NPC 须在当前时间片/地点;插件侧 LLM 扮演 + 泄密审计。 */
export async function talk(
  ctx: Context,
  sessionId: string,
  route: AgentRoute,
  script: LoopScript,
  state: LoopState,
  npcId: string,
  text: string,
  signal?: AbortSignal,
): Promise<LoopResult> {
  const npc = script.npcs.find((n) => n.id === npcId || n.name === npcId)
  if (npc === undefined) {
    return { text: `没有这个人。在场可选:${script.npcs.map((n) => n.name).join('、')}。` }
  }
  const slot = npcAt(script, npc.id, state.slice)
  if (slot === null || slot.location !== state.location) {
    return { text: `${npc.name}不在这里(他在${slot !== null ? locationName(script, slot.location) : '别处'})。` }
  }
  let reply: string
  try {
    const out = await talkAsNpc(ctx, {
      sessionId,
      route,
      label: `npc:loop:${npc.id}`,
      system: buildNpcSystem(
        { title: script.title, suspects: script.npcs.map((n) => ({ id: n.id, name: n.name, role: n.role, bio: n.bio })), facts: script.facts, npc: script.npc },
        npc.id,
      ),
      user: `玩家说:${text}\n(当前时间:${script.sliceNames[state.slice]},你在${locationName(script, slot.location)}${slot.action})`,
      history: (state.conversations[npc.id] ?? []).slice(-6),
      maxTokens: 300,
      signal,
    })
    reply = out.text
  } catch {
    reply = `${npc.name}没有回答,只是摆了摆手。`
  }
  const verdict = auditReply(script, npc.id, reply)
  const flagged = verdict.flagged
  if (flagged) {
    state.auditLog = [...(state.auditLog ?? []), { npcId: npc.id, at: Date.now(), kind: verdict.slipped.length > 0 ? 'slip' : 'leak', factIds: [...verdict.outOfScope, ...verdict.slipped], snippet: reply }]
    reply = sanitizedLine(npc.name)
  }
  state.conversations[npc.id] = [
    ...(state.conversations[npc.id] ?? []),
    { role: 'user' as const, text },
    { role: 'assistant' as const, text: reply },
  ].slice(-8)
  state.relations[npc.id] = Math.min(100, (state.relations[npc.id] ?? 0) + 2)
  state.turns += 1
  return { text: flagged ? reply : `「${npc.name}」:${reply}` }
}

// ── 悲剧结算与回滚 ────────────────────────────────────────────────────────────

export function resolveTragedy(script: LoopScript, state: LoopState): LoopResult {
  const [edgeA, edgeB] = script.keyEdges
  const collapse = !state.cutEdges.includes(edgeA)
  const locked = !state.cutEdges.includes(edgeB)
  const deaths = (collapse ? script.tragedy.collapseDeaths : 0) + (locked ? script.tragedy.lockedDeaths : 0)
  if (deaths === 0) {
    state.phase = 'solved'
    const winText =
      script.winText ??
      `【19:00 · 完美一日】你改写了因果——${script.keyEdges.map((k) => script.edgeNotes[k]).join(';')}全部被切断,${script.tragedy.name}没有发生。这一天,终于可以走到尽头了。`
    return {
      won: true,
      text: `${winText}\n\n${settleText(script, state)}`,
    }
  }
  const lines: string[] = [`【19:00 · ${script.tragedy.name}】`]
  if (collapse) lines.push(script.tragedy.collapseText)
  if (locked) lines.push(script.tragedy.lockedText)
  lines.push(`遇难 ${deaths} 人。今日结束。`)
  const rollback = rollbackLoop(script, state, deaths)
  lines.push('', rollback)
  return { text: lines.join('\n'), looped: true }
}

function rollbackLoop(script: LoopScript, state: LoopState, deaths: number): string {
  const prevObserved = state.lastObserved
  const prevCut = state.lastCutEdges
  const changedEvents = state.observed.filter((id) => !prevObserved.includes(id))
  const newCuts = state.cutEdges.filter((id) => !prevCut.includes(id))
  const changed: string[] = [
    ...changedEvents.map((id) => `新目击:${script.events.find((e) => e.id === id)?.name ?? id}`),
    ...newCuts.map((id) => `因果改变:${script.edgeNotes[id] ?? id}`),
    ...(state.lastDeaths !== null && state.lastDeaths !== deaths ? [`遇难人数 ${state.lastDeaths} → ${deaths}`] : []),
  ]
  if (changed.length > 0) {
    state.loopDiffs.push({ fromLoop: state.loopNo, toLoop: state.loopNo + 1, changed, cause: '本循环的行动与观测' })
  }
  state.lastObserved = [...state.observed]
  state.lastCutEdges = [...state.cutEdges]
  state.lastDeaths = deaths
  // 世界回滚:易失层清零,持久层保留
  state.loopNo += 1
  state.slice = 0
  state.location = script.locations[0]?.id ?? 'hall'
  state.items = []
  state.observed = []
  state.cutEdges = []
  state.conversations = {}
  const lines = [
    '【世界回滚】你睁眼,又是同一天,同一场雨。NPC 都不记得昨天;但你记得。',
    `【新发现摘要】本循环新增元知识 ${state.facts.length} 条,循环 diff ${changed.length > 0 ? `:${changed.join(';')}` : ':无'}。`,
    `【循环 ${state.loopNo}/${state.loopsMax}】从 ${script.sliceNames[0] ?? '12:00'} 开始。${state.loopNo > state.loopsMax ? '(循环预算已超,但你仍可继续——效率分会更低)' : ''}`,
  ]
  return lines.join('\n')
}

// ── 快进重放(已知动作批量重放,浓缩摘要) ──────────────────────────────────────

/**
 * 快进:按玩家标记的已知计划重放动作(时间标记 + 地点 + 深查/因果行动),
 * 引擎按"先知道,才拿得到"照常裁决;知识门槛不足的步骤跳过并标注。
 * 到达 19:00 时正常结算悲剧/完美一日。
 */
export function fastForward(script: LoopScript, state: LoopState, plan: string): LoopResult {
  const clauses = plan
    .split(/[。;；\n→,，、]/)
    .map((c) => c.trim())
    .filter((c) => c !== '')
  if (clauses.length === 0) return { text: '计划是空的。' }
  const lines = ['【快进重放】']
  let pendingTime: number | null = null
  for (const clause of clauses) {
    const timeMatch = /(\d{1,2}):00/.exec(clause)
    let recognized = false
    if (timeMatch !== null) {
      const slice = Number(timeMatch[1]) - 12
      if (slice < 0 || slice >= script.sliceCount) {
        lines.push(`• 忽略无效时间 ${timeMatch[0]}`)
        continue
      }
      pendingTime = slice
      recognized = true
    }
    // 短名匹配:clause 中出现地点名的 ≥2 个双字滑窗即视为该地点(容忍「图书馆/旧图书馆」)
    const loc = script.locations.find((l) => {
      if (clause.includes(l.name)) return true
      let hits = 0
      for (let i = 0; i < l.name.length - 1; i++) {
        if (clause.includes(l.name.slice(i, i + 2))) hits += 1
      }
      return hits >= 1
    })
    if (loc !== undefined) {
      if (pendingTime !== null) {
        if (pendingTime < state.slice) {
          lines.push(`• 跳过时间倒流(${script.sliceNames[pendingTime]})`)
          pendingTime = null
          continue
        }
        state.slice = pendingTime
        pendingTime = null
      } else {
        state.slice += 1
      }
      state.location = loc.id
      if (state.slice >= script.tragedy.slice) {
        const r = resolveTragedy(script, state)
        lines.push(r.text)
        return { text: lines.join('\n'), won: r.won, looped: r.looped }
      }
      const auto = autoObserve(script, state)
      lines.push(`→ ${script.sliceNames[state.slice]} 抵达${loc.name}${auto.text.includes('目击') ? '(目击事件已收录)' : ''}`)
      recognized = true
    }
    const inv = script.events.find(
      (e) => e.investigate !== undefined && clause.includes(e.investigate.target) && e.slice <= state.slice && state.slice <= (e.sliceTo ?? e.slice) && e.location === state.location,
    )
    if (inv?.investigate !== undefined) {
      const r = investigate(script, state, inv.investigate.target)
      lines.push(`• ${r.text.split('\n')[0]}`)
      recognized = true
    }
    const actMatch = script.actions.find((a) => a.keywords.some((k) => clause.includes(k)) && state.slice >= a.sliceFrom && state.location === a.location)
    if (actMatch !== undefined) {
      const r = act(script, state, clause)
      lines.push(`• ${r.text.split('\n')[0]}`)
      recognized = true
    }
    if (!recognized) {
      lines.push(`• 忽略未识别步骤:「${clause.slice(0, 24)}」`)
    }
  }
  state.turns += 1
  lines.push(`快进结束:当前 ${script.sliceNames[state.slice]},${locationName(script, state.location)};已切断因果:${state.cutEdges.length > 0 ? state.cutEdges.map((k) => script.edgeNotes[k]).join(';') : '(无)'}`)
  return { text: lines.join('\n') }
}

// ── 完美日验证(CausalVerifier) ────────────────────────────────────────────────

export interface PlanVerdict {
  pass: boolean
  items: { edge: string; ok: boolean; reason: string }[]
}

/** 验证玩家提交的完美一日方案:逐条对照关键因果边(行动提及 + 知识门槛)。 */
export function verifyPlan(script: LoopScript, state: LoopState, plan: string): PlanVerdict {
  const norm = plan.trim().toLowerCase()
  const items = script.keyEdges.map((edge) => {
    const action = script.actions.find((a) => a.effect.cutEdge === edge)
    if (action === undefined) return { edge, ok: false, reason: '剧本错误:该因果边无对应行动' }
    const mentioned = action.keywords.some((k) => norm.includes(k.toLowerCase())) || norm.includes(action.name.toLowerCase())
    if (!mentioned) return { edge, ok: false, reason: `方案里没有提到「${action.name}」` }
    const missingFacts = action.requires.facts.filter((f) => !state.facts.includes(f))
    if (missingFacts.length > 0) return { edge, ok: false, reason: `你还没有掌握前提线索:${missingFacts.map((f) => factText(script, f)).join(';')}` }
    const missingItems = action.requires.items.filter((i) => !state.knownItems.includes(i))
    if (missingItems.length > 0) return { edge, ok: false, reason: `你还不认识所需道具:${missingItems.map((i) => script.items.find((it) => it.id === i)?.name ?? i).join(';')}` }
    return { edge, ok: true, reason: `因果可行:已切断「${script.edgeNotes[edge]}」` }
  })
  return { pass: items.every((i) => i.ok), items }
}

// ── 计分与文案 ────────────────────────────────────────────────────────────────

function computeScore(script: LoopScript, state: LoopState): ScoreBar[] {
  const won = state.phase === 'solved'
  return [
    { label: '结论正确性', value: won ? 100 : 0, note: won ? '完美一日达成' : '悲剧尚未改写' },
    { label: '推理质量', value: Math.min(100, state.facts.length * 10), note: `已确认元知识 ${state.facts.length} 条` },
    { label: '效率', value: Math.max(0, 100 - (state.loopNo - 1) * 20 - state.hintsUsed * 15), note: `第 ${state.loopNo} 循环 · ${state.hintsUsed} 次提示` },
  ]
}

function settleText(script: LoopScript, state: LoopState): string {
  const bars = computeScore(script, state)
  return `【时间循环 · 结算】${script.title}
${bars.map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

【悲剧真相】${script.tragedy.name}:${script.keyEdges.map((k) => script.edgeNotes[k]).join(';')}。

【完美一日路径】(${state.phase === 'solved' ? '已达成' : '终局揭晓'})
${script.winPath.join('\n')}`
}

/** 结算文本(工具层复用)。 */
export const loopSettleText = settleText

function scoreText(script: LoopScript, state: LoopState): string {
  return `【时间循环 · 当前进度】循环 ${state.loopNo}/${state.loopsMax} · ${script.sliceNames[state.slice]} · 元知识 ${state.facts.length} 条 · 行动 ${state.turns} 次

${computeScore(script, state).map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

已切断因果:${state.cutEdges.length > 0 ? state.cutEdges.map((k) => script.edgeNotes[k]).join(';') : '(无)'}`
}

function buildBrief(script: LoopScript, state: LoopState): string {
  return `【游戏开始:时间循环 · ${script.title}】(难度 ${script.difficulty}/3,${script.sliceCount} 个时间片/循环,上限 ${state.loopsMax} 循环)

现在你是本局的主持人。玩家被困在重复的同一日:白天收集信息,19:00 悲剧必然降临,然后世界回滚——只有玩家的元知识保留。请遵守以下铁律:

1. 你【不知道悲剧的因果链与完美解法】。真相只存在于游戏引擎中,不要猜测、不要剧透、不要替玩家总结因果。
2. 玩家每个动作都必须经工具裁决,引擎返回什么你才能叙述什么:
   - \`loop_move\`(to:地点)移动并消耗 1 个时间片;达到 19:00 时引擎自动结算悲剧/完美日;
   - \`loop_observe\` 观察当前时间片与地点(目击事件会自动收录元知识);
   - \`loop_investigate\`(target)深查机关/物件(可能需要"先知道什么");
   - \`loop_talk\`(npc + text)与在场 NPC 对话;NPC 不记得别的循环,也不知道自己的命运;
   - \`loop_act\`(action)执行因果行动(如 拆铆钉/把残页交给记者);
   - \`loop_submit_plan\`(plan)提交完美一日方案,引擎逐条验证因果可行性(终局动作)。
3. 你只描述玩家所在时间片所见:不得描写"别处正发生什么",不得用"似曾相识"暗示解路径。
4. 玩家可以用 /facts 看元知识、/relations 看好感度、/schedule 看已观测时间表、/loops 看循环 diff、/hint 买提示、/game score 查进度、/game quit 结束看真相。

${script.intro}

【当前】循环 ${state.loopNo}/${state.loopsMax},${script.sliceNames[0] ?? '12:00'},${locationName(script, script.locations[0]?.id ?? 'hall')}。

用两三句主持人的开场白描述此刻的场景,并等待玩家第一个动作。`
}

function resumeBrief(script: LoopScript, state: LoopState): string {
  return `【继续游戏:时间循环 · ${script.title}】循环 ${state.loopNo}/${state.loopsMax},${script.sliceNames[state.slice]},你在${locationName(script, state.location)}。已确认元知识 ${state.facts.length} 条。你仍是主持人:不知道因果真相;玩家动作一律经 loop_move / loop_observe / loop_investigate / loop_talk / loop_act / loop_submit_plan 工具执行。请提醒玩家"我们继续"。`
}

// ── 面板(/facts /relations /schedule /loops) ──────────────────────────────────

export type LoopPanel = 'facts' | 'relations' | 'schedule' | 'loops'

export function panelText(script: LoopScript, state: LoopState, panel: LoopPanel): string {
  switch (panel) {
    case 'facts': {
      const lines = state.facts.map((id) => `- [${script.facts.find((f) => f.id === id)?.type ?? '?'}] ${factText(script, id)}`)
      return `【元知识清单】${state.facts.length} 条(跨循环保留)\n${lines.join('\n') || '(暂无——去观察与深查吧)'}`
    }
    case 'relations': {
      const lines = script.npcs.map((n) => `- ${n.name}:好感度 ${state.relations[n.id] ?? 0}`)
      return `【好感度】(跨循环保留)\n${lines.join('\n')}`
    }
    case 'schedule': {
      const lines = state.observed.map((id) => {
        const e = script.events.find((ev) => ev.id === id)
        return e !== undefined ? `- ${script.sliceNames[e.slice]} ${locationName(script, e.location)}:${e.name}` : `- ${id}`
      })
      return `【已观测时间表】\n${lines.join('\n') || '(暂无——时间表只显示你亲眼确认过的部分)'}`
    }
    case 'loops': {
      const lines = state.loopDiffs.map((d) => `- 循环 ${d.fromLoop}→${d.toLoop}:${d.changed.join(';')}`)
      return `【循环记录】当前第 ${state.loopNo} 循环 / 上限 ${state.loopsMax}\n${lines.join('\n') || '(暂无循环 diff)'}`
    }
  }
}

// ── 引擎入口 ──────────────────────────────────────────────────────────────────

/** 手工剧本库(M2:3 本);全部必须过 ScheduleSolver 硬门禁。 */
export const LOOP_SCRIPTS: LoopScript[] = [NORTH_BRIDGE, INN_FIRE, BANQUET_POISON]

for (const script of LOOP_SCRIPTS) {
  const report = solveLoop(script)
  if (!report.ok) {
    throw new Error(`dsh-xgame:时间循环剧本《${script.title}》未通过求解器:${report.errors.join(';')}`)
  }
}

/** 生成变体池(皮肤换名 + 新因果拓扑,全部过求解器硬门禁)。 */
const GENERATED_LOOP_POOL = new Map<number, LoopScript[]>()

function generatedLoopPool(): LoopScript[] {
  let pool = GENERATED_LOOP_POOL.get(2)
  if (pool === undefined) {
    pool = []
    for (let seed = 1; pool.length < 4 && seed < 60; seed += 1) {
      const script = generateLoopScript(seed)
      if (solveLoop(script).ok && !pool.some((x) => x.id === script.id)) pool.push(script)
    }
    for (let seed = 1; pool.length < 12 && seed < 80; seed += 1) {
      const world = generateLoopWorld(seed)
      if (solveLoop(world).ok && !pool.some((x) => x.id === world.id)) pool.push(world)
    }
    GENERATED_LOOP_POOL.set(2, pool)
  }
  return pool
}

export function pickLoopScript(seed: number): LoopScript {
  const pool = [...LOOP_SCRIPTS, ...generatedLoopPool()]
  return pool[Math.abs(seed) % pool.length]
}

/** 构造初始状态(引擎与测试共用)。 */
export function makeLoopState(script: LoopScript, difficulty: number): LoopState {
  const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
  const loopsMax = level === 1 ? 8 : level === 2 ? 6 : 4
  const now = Date.now()
  return {
    scheme: 'loop',
    difficulty: level,
    startedAt: now,
    updatedAt: now,
    phase: 'playing' as GamePhase,
    turns: 0,
    hintsUsed: 0,
    score: null,
    scriptId: script.id,
    loopNo: 1,
    slice: 0,
    location: script.locations[0]?.id ?? 'hall',
    facts: [],
    relations: {},
    knownItems: [],
    items: [],
    observed: [],
    cutEdges: [],
    lastObserved: [],
    lastCutEdges: [],
    lastDeaths: null,
    loopDiffs: [],
    loopsMax,
    conversations: {},
    auditLog: [],
    planVerdict: null,
  }
}

export const loopEngine: SchemeEngine = {
  id: 'loop',
  label: '时间循环',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const script = pickLoopScript(hashString(sessionId))
    const state = makeLoopState(script, difficulty)
    return { state, truth: script, brief: buildBrief(script, state) }
  },
  resumeBrief(state, truth) {
    const script = (truth as LoopScript | undefined) ?? NORTH_BRIDGE
    return resumeBrief(script, state as LoopState)
  },
  scoreText(state, truth) {
    const script = (truth as LoopScript | undefined) ?? NORTH_BRIDGE
    return scoreText(script, state as LoopState)
  },
  settleText(state, truth) {
    return settleText(truth as LoopScript, state as LoopState)
  },
  hint(state, truth) {
    const script = truth as LoopScript
    const s = state as LoopState
    const idx = Math.min(s.hintsUsed, script.hints.length - 1)
    return { text: `【提示 ${idx + 1}/${script.hints.length}】${script.hints[idx]}` }
  },
}
