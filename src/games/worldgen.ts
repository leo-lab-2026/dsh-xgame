/**
 * 程序化世界生成(方案二 M2,docs/02-solo-trpg.md §9)。
 *
 * v1 落地:固定结构骨架(枢纽 → 线索地 → 钥匙地 → 匪巢)+ 主题皮肤与命名换皮,
 * 生成后必须通过 `solveWorld` —— 用引擎纯函数从初始状态重放黄金路径
 * (移动/勘查/战斗/交还失物/开门/打 Boss)逐条断言,不可解的世界一律拒绝。
 * 任意种子可复现;golden case 回归见 smoke 测试。
 */

import type { TrpgScript } from './trpg.js'
import { attack, examine, makeTrpgState, move, rest, useItem } from './trpg.js'

interface Theme {
  id: string
  title: string
  intro: string
  place: string
  regionNames: { hub: string; clue: string; key: string; boss: string }
  regionDescs: { hub: string; clue: string; key: string; boss: string }
  npcs: {
    innkeeper: { name: string; role: string; bio: string; persona: string }
    helper: { name: string; role: string; bio: string; persona: string }
    villain: { name: string; role: string; bio: string; persona: string }
  }
  enemies: {
    grunt: { name: string }
    keyEnemy: { name: string }
    boss: { name: string }
  }
  items: { token: { name: string; desc: string; giveText: string }; key: { name: string; desc: string } }
  landmarks: {
    wreck: { name: string; desc: string; examineText: string }
    goods: { name: string; desc: string; examineText: string }
  }
  fact: { text: string; keywords: string[] }
  hints: [string, string, string]
}

const THEMES: Theme[] = [
  {
    id: 'desert',
    title: '荒漠驿站',
    intro: '黄沙漫漫,你在「骆驼刺」驿站落脚。往东的驼队,已经三天没有消息了。',
    place: '荒漠',
    regionNames: { hub: '驿站绿洲', clue: '荒丘', key: '废堡', boss: '匪巢' },
    regionDescs: {
      hub: '绿洲边的驿站,驼铃声声,店里的水烟咕噜作响。',
      clue: '风化的荒丘,驼队的车辙歪歪扭扭延伸进沙里,又突然消失。',
      key: '半塌的夯土废堡,火堆旁坐着几个黑影。',
      boss: '崖壁下的匪巢,篝火通明,一个独眼汉子在烤羊。',
    },
    npcs: {
      innkeeper: { name: '马三', role: '驿站老板', bio: '骆驼刺驿站的老板,消息灵通,爱打听。', persona: '市侩而热心,说话爱卖关子。' },
      helper: { name: '阿依莎', role: '向导', bio: '驿站的向导,她的罗盘被胡狼叼去了荒丘。', persona: '爽利直接;提到罗盘就叹气。' },
      villain: { name: '沙狐', role: '匪首', bio: '匪巢头目,独眼,据说劫了多支驼队。', persona: '凶悍多疑,喜欢把玩弯刀。' },
    },
    enemies: { grunt: { name: '荒丘胡狼' }, keyEnemy: { name: '沙匪' }, boss: { name: '匪首沙狐' } },
    items: {
      token: { name: '罗盘', desc: '阿依莎被胡狼叼走的罗盘。', giveText: '阿依莎接过罗盘,眼睛一亮:"好小子!这是谢礼。"她塞给你 20 枚金币。' },
      key: { name: '铁钥匙', desc: '匪巢入口的铁门钥匙。' },
    },
    landmarks: {
      wreck: { name: '驼队残骸', desc: '翻倒的驼车,货物被洗劫一空。车辕上有利刃劈砍的痕迹。', examineText: '你仔细查看:货箱上烙着「沙狐」的印记,沙地上还有几枚独眼头目特有的钉靴印。驼队是被沙狐劫走的。' },
      goods: { name: '驼队货物', desc: '堆在角落的货箱,烙着商队的印记。', examineText: '失踪驼队的货物全在这里。沙狐就是幕后主使。' },
    },
    fact: { text: '驼队就是沙狐带人劫的,货物藏在匪巢。', keywords: ['劫', '驼队', '货物', '我干的', '抢'] },
    hints: ['荒丘里有驼队的痕迹——先去那里看看。', '胡狼叼走了向导的罗盘;沙匪身上似乎有把铁钥匙。', '匪巢需要铁钥匙;沙狐不好惹,先备好药水。'],
  },
  {
    id: 'harbor',
    title: '海港疑云',
    intro: '海雾弥漫的渔村码头,你在「咸鱼」酒馆落脚。出海的货船,已经三天没有靠岸了。',
    place: '海港',
    regionNames: { hub: '渔村码头', clue: '暗礁滩', key: '旧货仓', boss: '鬼船' },
    regionDescs: {
      hub: '雾中的渔村码头,渔船起伏,酒馆的灯笼昏黄。',
      clue: '浪花拍打暗礁,半截货船搁浅在礁石间,船身歪斜。',
      key: '码头边的旧货仓,货箱后传来压低的人声。',
      boss: '泊在深水区的鬼船,甲板上的火把一明一灭,一个刀疤汉子立在船头。',
    },
    npcs: {
      innkeeper: { name: '老渔头', role: '酒馆老板', bio: '咸鱼酒馆的老板,海上的事没有他不知道的。', persona: '粗嗓门,爱吹牛,消息灵通。' },
      helper: { name: '阿螺', role: '渔女', bio: '渔村的渔女,她的渔网被海兽拖去了暗礁滩。', persona: '爽利泼辣;提到渔网就咬牙。' },
      villain: { name: '海枭', role: '鬼船船长', bio: '鬼船的头目,刀疤脸,劫掠过往商船。', persona: '阴沉凶悍,腰间别着水手刀。' },
    },
    enemies: { grunt: { name: '礁滩海兽' }, keyEnemy: { name: '水匪' }, boss: { name: '船长海枭' } },
    items: {
      token: { name: '渔网', desc: '阿螺被海兽拖走的渔网。', giveText: '阿螺接过渔网,眼睛一亮:"好小子!这是谢礼。"她塞给你 20 枚金币。' },
      key: { name: '铜钥匙', desc: '鬼船舱门的铜钥匙。' },
    },
    landmarks: {
      wreck: { name: '货船残骸', desc: '搁浅的货船,货舱被洗劫一空。船舷上有利刃劈砍的痕迹。', examineText: '你仔细查看:货箱上烙着「海枭」的印记,舷边还有几枚刀疤头目特有的船钉靴印。货船是被海枭劫走的。' },
      goods: { name: '货船货物', desc: '堆在底舱的货箱,烙着商号的印记。', examineText: '失踪货船的货物全在这里。海枭就是幕后主使。' },
    },
    fact: { text: '货船就是海枭带人劫的,货物藏在鬼船底舱。', keywords: ['劫', '货船', '货物', '我干的', '抢'] },
    hints: ['暗礁滩有货船的痕迹——先去那里看看。', '海兽拖走了渔女的渔网;水匪身上似乎有把铜钥匙。', '鬼船需要铜钥匙;海枭不好惹,先备好药水。'],
  },
]

/** 程序化组装:主题 + 固定结构骨架(与手工招牌《霜松林地》同构)。 */
export function generateWorld(seed: number, _difficulty: number): TrpgScript {
  const theme = THEMES[Math.abs(seed) % THEMES.length]
  const hub = 'hub'
  const clue = 'clue'
  const key = 'key'
  const boss = 'boss'
  return {
    id: `world-${theme.id}-${Math.abs(seed) % 1000}`,
    title: theme.title,
    intro: theme.intro,
    startRegion: hub,
    regions: [
      {
        id: hub,
        name: theme.regionNames.hub,
        desc: theme.regionDescs.hub,
        adjacent: [clue, key],
        danger: 0,
        encounters: [],
        landmarks: [
          { id: 'lm_inn', name: `${theme.regionNames.hub}酒馆`, desc: `酒馆里,${theme.npcs.innkeeper.name}擦着杯子,几个渔夫在喝酒。` },
          { id: 'lm_helper', name: `${theme.npcs.helper.role}铺`, desc: `${theme.npcs.helper.name}正在整理行装,眉头紧锁。` },
        ],
      },
      {
        id: clue,
        name: theme.regionNames.clue,
        desc: theme.regionDescs.clue,
        adjacent: [hub],
        danger: 1,
        encounters: [{ id: 'grunt', weight: 60 }],
        landmarks: [
          {
            id: 'lm_wreck',
            name: theme.landmarks.wreck.name,
            desc: theme.landmarks.wreck.desc,
            examine: { requires: [], text: theme.landmarks.wreck.examineText, questObjective: 'obj_find' },
          },
        ],
      },
      {
        id: key,
        name: theme.regionNames.key,
        desc: theme.regionDescs.key,
        adjacent: [hub, boss],
        danger: 2,
        encounters: [{ id: 'key_enemy', weight: 50 }, { id: 'key_enemy', weight: 25 }],
        landmarks: [{ id: 'lm_gate', name: '入口', desc: `通往${theme.regionNames.boss}的路,门锁着。` }],
      },
      {
        id: boss,
        name: theme.regionNames.boss,
        desc: theme.regionDescs.boss,
        adjacent: [key],
        danger: 3,
        encounters: [{ id: 'boss', weight: 100 }],
        requires: { item: 'key' },
        landmarks: [
          {
            id: 'lm_goods',
            name: theme.landmarks.goods.name,
            desc: theme.landmarks.goods.desc,
            examine: { requires: [], text: theme.landmarks.goods.examineText, questObjective: 'obj_truth' },
          },
        ],
      },
    ],
    npcs: [
      { id: 'n_innkeeper', name: theme.npcs.innkeeper.name, role: theme.npcs.innkeeper.role, bio: theme.npcs.innkeeper.bio, regionId: hub, persona: theme.npcs.innkeeper.persona, knowledge: [], mustNotAdmit: [], liePolicy: '基本如实;不知道的事就摊手。' },
      { id: 'n_helper', name: theme.npcs.helper.name, role: theme.npcs.helper.role, bio: theme.npcs.helper.bio, regionId: hub, persona: theme.npcs.helper.persona, knowledge: [], mustNotAdmit: [], liePolicy: '基本如实。' },
      { id: 'n_villain', name: theme.npcs.villain.name, role: theme.npcs.villain.role, bio: theme.npcs.villain.bio, regionId: boss, persona: theme.npcs.villain.persona, knowledge: ['f_villain'], mustNotAdmit: ['f_villain'], liePolicy: `矢口否认劫过货,把黑锅推给"流寇"。` },
    ],
    facts: [{ id: 'f_villain', type: 'motive', text: theme.fact.text, auditKeywords: theme.fact.keywords }],
    enemies: [
      { id: 'grunt', name: theme.enemies.grunt.name, hp: 9, ac: 12, atk: 3, dmg: [1, 4, 1], drop: { gold: 0, item: 'token', xp: 30 } },
      { id: 'key_enemy', name: theme.enemies.keyEnemy.name, hp: 11, ac: 13, atk: 3, dmg: [1, 6, 1], drop: { gold: 8, item: 'key', xp: 40 } },
      { id: 'boss', name: theme.enemies.boss.name, hp: 26, ac: 15, atk: 5, dmg: [1, 8, 2], drop: { gold: 50, xp: 120, questObjective: 'obj_justice' } },
    ],
    items: [
      { id: 'shortsword', name: '短剑', desc: '一柄普通的短剑。', qty: 1 },
      { id: 'potion', name: '治疗药水', desc: '红色的小瓶,喝下可恢复 12 点生命。', qty: 2, use: { heal: 12, text: '你仰头喝下药水,暖意流过四肢。' } },
      { id: 'rope', name: '麻绳', desc: '20 尺麻绳。', qty: 1 },
      { id: 'token', name: theme.items.token.name, desc: theme.items.token.desc, qty: 1, use: { giveTo: 'n_helper', text: theme.items.token.giveText } },
      { id: 'key', name: theme.items.key.name, desc: theme.items.key.desc, qty: 1, use: { opens: boss, text: `${theme.items.key.name}一转,门开了。` } },
    ],
    quests: [
      {
        id: 'q_main',
        type: 'main',
        title: '失踪的商队',
        objectives: [
          { id: 'obj_find', desc: `在${theme.regionNames.clue}找到失踪商队的下落` },
          { id: 'obj_truth', desc: '查清劫走商队的幕后主使' },
          { id: 'obj_justice', desc: `夺回货物,让${theme.npcs.villain.name}伏法` },
        ],
        reward: { gold: 80, xp: 200 },
      },
      {
        id: 'q_side',
        type: 'side',
        title: `${theme.npcs.helper.role}的${theme.items.token.name}`,
        objectives: [{ id: 'obj_mold', desc: `从${theme.enemies.grunt.name}口夺回${theme.items.token.name},还给${theme.npcs.helper.name}` }],
        reward: { gold: 20, xp: 50 },
      },
    ],
    hints: theme.hints,
  }
}

/** 可解性求解器:结构校验 + 引擎黄金路径重放(战斗用种子确定性模拟)。 */
export function solveWorld(world: TrpgScript): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const regionIds = new Set(world.regions.map((r) => r.id))
  const itemIds = new Set(world.items.map((i) => i.id))
  const npcIds = new Set(world.npcs.map((n) => n.id))
  const objectiveIds = new Set(world.quests.flatMap((q) => q.objectives.map((o) => o.id)))

  // 结构:区域/物品/引用可解析
  if (world.regions.length !== 4) errors.push('应有 4 个区域')
  for (const r of world.regions) {
    for (const adj of r.adjacent) if (!regionIds.has(adj)) errors.push(`区域 ${r.id} 相邻未知 ${adj}`)
    if (r.requires?.item !== undefined && !itemIds.has(r.requires.item)) errors.push(`区域 ${r.id} 需要未知道具 ${r.requires.item}`)
    for (const lm of r.landmarks) {
      if (lm.examine?.questObjective !== undefined && !objectiveIds.has(lm.examine.questObjective)) errors.push(`地标 ${lm.id} 引用了未知目标`)
    }
  }
  for (const n of world.npcs) if (!regionIds.has(n.regionId)) errors.push(`NPC ${n.id} 区域未知`)
  for (const e of world.enemies) {
    if (e.drop?.item !== undefined && !itemIds.has(e.drop.item)) errors.push(`敌人 ${e.id} 掉落未知道具`)
    if (e.drop?.questObjective !== undefined && !objectiveIds.has(e.drop.questObjective)) errors.push(`敌人 ${e.id} 掉落引用了未知目标`)
  }
  const token = world.items.find((i) => i.id === 'token')
  if (token?.use?.giveTo !== undefined && !npcIds.has(token.use.giveTo)) errors.push('失物交还对象未知')

  // ── 黄金路径重放(全部数据驱动,手工与生成世界同构;最多 3 次 rng 尝试) ──
  const tokenItem = world.items.find((i) => i.use?.giveTo !== undefined)
  const keyItem = world.items.find((i) => i.use?.opens !== undefined)
  const bossRegion = world.regions.find((r) => r.requires?.item !== undefined)
  const clueRegion = world.regions.find((r) => r.landmarks.some((lm) => lm.examine?.questObjective === 'obj_find'))
  const goodsLandmark = world.regions.flatMap((r) => r.landmarks).find((lm) => lm.examine?.questObjective === 'obj_truth')
  const gruntEnemy = world.enemies.find((e) => e.drop?.item !== undefined && e.drop.item === tokenItem?.id)
  const keyEnemy = world.enemies.find((e) => e.drop?.item !== undefined && e.drop.item === keyItem?.id)
  const bossEnemy = world.enemies.find((e) => e.drop?.questObjective === 'obj_justice')
  const gruntRegion = world.regions.find((r) => r.encounters.some((e) => e.id === gruntEnemy?.id))
  const keyRegion = world.regions.find((r) => r.encounters.some((e) => e.id === keyEnemy?.id))
  if (tokenItem === undefined) errors.push('缺少失物道具(giveTo)')
  if (keyItem === undefined || bossRegion === undefined) errors.push('缺少钥匙/终局区域')
  if (clueRegion === undefined || goodsLandmark === undefined) errors.push('缺少线索/赃物地标')
  if (gruntEnemy === undefined || keyEnemy === undefined || bossEnemy === undefined) errors.push('敌人配置不完整')
  if (errors.length > 0) return { ok: false, errors }
  if (bossRegion === undefined || goodsLandmark === undefined || clueRegion === undefined || gruntEnemy === undefined || keyEnemy === undefined || bossEnemy === undefined || tokenItem === undefined || keyItem === undefined) {
    return { ok: false, errors }
  }

  const runReplay = (attempt: number): string[] => {
  const replayErrors: string[] = []
  const state = makeTrpgState(world, 2, attempt * 1000 + 1)
  const sessionId = `solve-${world.id}-${attempt}`
  const fightUntilDone = (): boolean => {
    let guard = 0
    while (state.combat !== null && guard < 120) {
      if (state.character.hp.current < 12 && state.inventory.some((i) => i.id === 'potion' && i.qty > 0)) useItem(world, state, '治疗药水')
      const target = state.combat.find((u) => !u.dead)
      if (target === undefined) break
      const r = attack(world, state, sessionId, target.id)
      if (r.defeat) return false
      guard += 1
    }
    return state.combat === null
  }
  const moveUntilEncounter = (regionId: string, maxMoves: number): boolean => {
    for (let i = 0; i < maxMoves; i++) {
      move(world, state, sessionId, regionId, 2)
      if (state.combat !== null) return true
    }
    return state.combat !== null
  }

  // 1. 线索地:勘查残骸 → obj_find;遭遇杂兵 → 失物
  move(world, state, sessionId, clueRegion.id, 2)
  if (state.combat === null && !moveUntilEncounter(clueRegion.id, 5)) replayErrors.push('线索地无法遭遇杂兵')
  if (state.combat !== null && !fightUntilDone()) replayErrors.push('被杂兵打晕(世界不可解)')
  examine(world, state, clueRegion.landmarks.find((lm) => lm.examine?.questObjective === 'obj_find')?.name ?? '残骸')
  if (!state.questDone.includes('obj_find')) replayErrors.push('勘查残骸未推进 obj_find')
  // 2. 回枢纽交失物 → 支线目标
  move(world, state, sessionId, world.startRegion, 2)
  if (state.inventory.some((i) => i.id === tokenItem.id)) {
    useItem(world, state, tokenItem.id)
    if (!state.questDone.includes('obj_mold')) replayErrors.push('交还失物未推进支线目标')
  } else {
    replayErrors.push('杂兵未掉落失物')
  }
  // 3. 钥匙地:遭遇守钥敌 → 钥匙
  if (keyRegion !== undefined) {
    move(world, state, sessionId, keyRegion.id, 2)
    if (state.combat === null && !moveUntilEncounter(keyRegion.id, 5)) replayErrors.push('钥匙地无法遭遇守钥敌')
    if (state.combat !== null && !fightUntilDone()) replayErrors.push('被守钥敌打晕(世界不可解)')
    if (!state.inventory.some((i) => i.id === keyItem.id)) replayErrors.push('守钥敌未掉落钥匙')
  }
  // 4. 终局区域:开门 → 勘查赃物 → obj_truth;打 Boss → obj_justice
  const enter = move(world, state, sessionId, bossRegion.id, 2)
  if (enter.text.includes('进不去')) replayErrors.push('有钥匙却进不去终局区域')
  if (state.regionId === bossRegion.id) {
    examine(world, state, goodsLandmark.name)
    if (!state.questDone.includes('obj_truth')) replayErrors.push('勘查赃物未推进 obj_truth')
  }
  if (state.combat === null && !moveUntilEncounter(bossRegion.id, 5)) replayErrors.push('终局区域无法遭遇 Boss')
  // Boss 前休整(引擎 rest 上限 3 次)
  for (let i = 0; i < 3; i++) rest(world, state)
  if (state.combat !== null && !fightUntilDone()) replayErrors.push('被 Boss 打晕(世界不可解)')
  if (!state.questDone.includes('obj_justice')) replayErrors.push('Boss 战未推进 obj_justice')
  // 终局:全部目标完成
  const done = new Set(state.questDone)
  for (const id of ['obj_find', 'obj_truth', 'obj_justice', 'obj_mold']) {
    if (!done.has(id)) replayErrors.push(`目标 ${id} 未达成`)
  }
  return replayErrors
  }

  // 最多 3 次 rng 尝试:存在一条可走通的路径即视为可解
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (runReplay(attempt).length === 0) return { ok: true, errors: [] }
  }
  errors.push(...runReplay(1))
  return { ok: false, errors }
}
