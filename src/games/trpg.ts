/**
 * 方案二·织梦者(单人跑团,路线图阶段 6)。
 *
 * v1 落地范围(与 docs/02-solo-trpg.md 的取舍):
 *   - M1 角色卡与骰子:固定属性组 + 种子 RNG(d20 优势/劣势),骰子历史全量落盘,不可篡改;
 *   - M2-lite 世界模块:手工《霜松林地》(4 区域/NPC/物品/主支线任务链),程序化世界生成是后续里程碑;
 *   - M3-lite 回合制战斗状态机:先攻/攻击/敌人 AI/死亡(失败不死档,晕倒回旅店)/逃跑/胜利奖励,
 *     附战斗模拟器回归(固定对局胜负分布落在目标区间);
 *   - 奇招裁决:trpg_check(skill, dc, description) —— GM 提议 DC,引擎掷骰并留档;
 *   - NPC 对话复用插件侧 LLM 无状态扮演 + 泄密审计;major NPC subagent 化是共享的下一里程碑。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { type ChatTurn } from '../core/llm.js'
import { talkAsNpc } from '../core/npc.js'
import { auditReply, sanitizedLine, type AuditEntry } from '../core/audit.js'
import { hashString, mulberry32 } from '../core/rand.js'
import { generateWorld, solveWorld } from './worldgen.js'
import type { SchemeEngine } from '../core/manager.js'

// ── 数据模型 ──────────────────────────────────────────────────────────────────

export interface TrpgCharacter {
  name: string
  level: number
  xp: number
  attributes: { str: number; dex: number; con: number; int: number; wis: number; cha: number }
  skills: Record<string, number>
  hp: { current: number; max: number }
  ac: number
  prof: number
  gold: number
}

export interface TrpgRegion {
  id: string
  name: string
  desc: string
  adjacent: string[]
  danger: number
  /** 进入时的遭遇表:weight 概率。 */
  encounters: { id: string; weight: number }[]
  /** 该区域可拾取的物品。 */
  items?: string[]
  /** 该区域可检查的目标(引擎裁决)。 */
  landmarks: { id: string; name: string; desc: string; examine?: { requires: string[]; text: string; item?: string; questObjective?: string } }[]
  /** 进入条件。 */
  requires?: { item?: string }
}

export interface TrpgItem {
  id: string
  name: string
  desc: string
  qty: number
  /** 使用效果(引擎裁决)。 */
  use?: { heal?: number; giveTo?: string; opens?: string; text: string }
}

export interface TrpgNpc {
  id: string
  name: string
  role: string
  bio: string
  regionId: string
  persona: string
  knowledge: string[]
  mustNotAdmit: string[]
  liePolicy: string
}

export interface TrpgEnemyTemplate {
  id: string
  name: string
  hp: number
  ac: number
  atk: number
  dmg: [number, number, number] // 骰数,面数,加值
  drop?: { gold: number; item?: string; questObjective?: string; xp: number }
}

export interface TrpgQuest {
  id: string
  type: 'main' | 'side'
  title: string
  objectives: { id: string; desc: string }[]
  reward: { gold: number; xp: number }
}

export interface TrpgScript {
  id: string
  title: string
  intro: string
  startRegion: string
  regions: TrpgRegion[]
  npcs: TrpgNpc[]
  facts: { id: string; type: 'motive' | 'testimony'; text: string; auditKeywords?: string[] }[]
  enemies: TrpgEnemyTemplate[]
  items: TrpgItem[]
  quests: TrpgQuest[]
  hints: [string, string, string]
}

// ── 世界模块:霜松林地 ─────────────────────────────────────────────────────────

const F_ROGUE = 'f_rogue_raid'

export const FROSTPINE: TrpgScript = {
  id: 'frostpine',
  title: '霜松林地',
  intro:
    '霜松林地的黄昏,雪粒簌簌。你是路过的冒险者,在「松针旅店」落脚。柜台后的老板压低了声音:往雾沼送货的商队,已经三天没有消息了。',
  startRegion: 'frostpine',
  regions: [
    {
      id: 'frostpine',
      name: '霜松林地',
      desc: '雪压松枝的林地,松针旅店的烟囱冒着热气,铁匠铺的锤声叮叮当当。',
      adjacent: ['ironhold', 'mistmere'],
      danger: 0,
      encounters: [],
      landmarks: [
        { id: 'lm_inn', name: '松针旅店', desc: '旅店大厅里,老板老霍克擦着杯子,几个伐木工在喝酒。' },
        { id: 'lm_smithy', name: '铁匠铺', desc: '铁匠希尔达正在炉前挥锤,眉头紧锁。' },
      ],
    },
    {
      id: 'mistmere',
      name: '雾沼',
      desc: '雾气贴着水面流淌的沼泽,车轮印一路歪歪斜斜延伸进雾里,又突然消失。',
      adjacent: ['frostpine'],
      danger: 1,
      encounters: [{ id: 'wolf', weight: 60 }],
      landmarks: [
        {
          id: 'lm_wreck',
          name: '商队残骸',
          desc: '翻倒的货车,货物被洗劫一空。车辕上有利刃劈砍的痕迹。',
          examine: { requires: [], text: '你仔细查看:货箱上烙着「铁喉」的印记,车辙旁还有几枚带齿的靴印。商队是被铁喉城寨的人劫走的。', questObjective: 'obj_find' },
        },
      ],
    },
    {
      id: 'ironhold',
      name: '铁喉城寨',
      desc: '木栅围起的山寨,火把昏黄,一个守卫靠在门口打盹。',
      adjacent: ['frostpine', 'ironhold_inner'],
      danger: 2,
      encounters: [{ id: 'bandit', weight: 50 }, { id: 'bandit', weight: 25 }],
      landmarks: [
        { id: 'lm_gate', name: '寨门', desc: '寨门半掩,门后是通往内厅的路。' },
        {
          id: 'lm_inner_door',
          name: '内厅门',
          desc: '内厅的门上挂着铜锁。',
          examine: { requires: [], text: '铜锁需要一把铜钥匙才能打开。' },
        },
      ],
    },
    {
      id: 'ironhold_inner',
      name: '铁喉内厅',
      desc: '火光通明的内厅,一个身披铁甲的汉子背对着你,在油灯下看地图。',
      adjacent: ['ironhold'],
      danger: 3,
      encounters: [{ id: 'rogue', weight: 100 }],
      requires: { item: 'copper_key' },
      landmarks: [
        {
          id: 'lm_goods',
          name: '商队货物',
          desc: '堆在角落的货箱,烙着商队的印记。',
          examine: { requires: [], text: '失踪商队的货物全在这里。铁牙罗格就是幕后主使。', questObjective: 'obj_truth' },
        },
      ],
    },
  ],
  npcs: [
    {
      id: 'n_innkeeper',
      name: '老霍克',
      role: '旅店老板',
      bio: '松针旅店的老板,消息灵通,爱打听。',
      regionId: 'frostpine',
      persona: '市侩而热心,说话爱卖关子。',
      knowledge: [],
      mustNotAdmit: [],
      liePolicy: '基本如实;不知道的事就摊手。',
    },
    {
      id: 'n_hilda',
      name: '希尔达',
      role: '铁匠',
      bio: '林地铁匠,手艺精湛;她最趁手的铁砧模具被狼叼去了雾沼。',
      regionId: 'frostpine',
      persona: '爽利直接,嗓门大;提到模具就叹气。',
      knowledge: [],
      mustNotAdmit: [],
      liePolicy: '基本如实。',
    },
    {
      id: 'n_rogue',
      name: '铁牙罗格',
      role: '铁喉城寨话事人',
      bio: '铁喉城寨的头目,刀疤脸,据说与多起劫案有关。',
      regionId: 'ironhold_inner',
      persona: '凶悍而多疑,喜欢把玩刀柄。',
      knowledge: [F_ROGUE],
      mustNotAdmit: [F_ROGUE],
      liePolicy: '矢口否认劫过商队,把黑锅推给"流寇"。',
    },
  ],
  facts: [{ id: F_ROGUE, type: 'motive', text: '商队就是铁牙罗格带人劫的,货物藏在铁喉内厅。', auditKeywords: ['劫', '商队', '货物', '我干的', '抢'] }],
  enemies: [
    { id: 'wolf', name: '雾沼灰狼', hp: 9, ac: 12, atk: 3, dmg: [1, 4, 1], drop: { gold: 0, item: 'anvil_mold', xp: 30 } },
    { id: 'bandit', name: '铁喉山贼', hp: 11, ac: 13, atk: 3, dmg: [1, 6, 1], drop: { gold: 8, item: 'copper_key', xp: 40 } },
    { id: 'rogue', name: '铁牙罗格', hp: 26, ac: 15, atk: 5, dmg: [1, 8, 2], drop: { gold: 50, xp: 120, questObjective: 'obj_justice' } },
  ],
  items: [
    { id: 'shortsword', name: '短剑', desc: '一柄普通的短剑。', qty: 1 },
    { id: 'potion', name: '治疗药水', desc: '红色的小瓶,喝下可恢复 12 点生命。', qty: 2, use: { heal: 12, text: '你仰头喝下药水,暖意流过四肢。' } },
    { id: 'rope', name: '麻绳', desc: '20 尺麻绳。', qty: 1 },
    { id: 'copper_key', name: '铜钥匙', desc: '内厅门上的铜锁钥匙。', qty: 1, use: { opens: 'ironhold_inner', text: '铜钥匙一转,内厅的门开了。' } },
    { id: 'anvil_mold', name: '铁砧模具', desc: '希尔达被狼叼走的铁砧模具。', qty: 1, use: { giveTo: 'n_hilda', text: '希尔达接过模具,眼睛一亮:"好小子!这是谢礼。"她塞给你 20 枚金币。' } },
  ],
  quests: [
    {
      id: 'q_main',
      type: 'main',
      title: '失踪的商队',
      objectives: [
        { id: 'obj_find', desc: '在雾沼找到失踪商队的下落' },
        { id: 'obj_truth', desc: '查清劫走商队的幕后主使' },
        { id: 'obj_justice', desc: '夺回货物,让铁牙罗格伏法' },
      ],
      reward: { gold: 80, xp: 200 },
    },
    {
      id: 'q_side',
      type: 'side',
      title: '铁匠的模具',
      objectives: [{ id: 'obj_mold', desc: '从雾沼的狼口夺回铁砧模具,还给希尔达' }],
      reward: { gold: 20, xp: 50 },
    },
  ],
  hints: [
    '雾沼里有商队的痕迹——先去那里看看。',
    '狼叼走了铁匠的模具;铁喉山贼身上似乎有把铜钥匙。',
    '内厅门需要铜钥匙;罗格不好惹,先备好药水。',
  ],
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

export interface CombatUnit {
  id: string
  name: string
  hp: number
  max: number
  ac: number
  atk: number
  dmg: [number, number, number]
  dead: boolean
  drop?: TrpgEnemyTemplate['drop']
}

export interface TrpgState extends GameStateBase {
  scheme: 'trpg'
  character: TrpgCharacter
  inventory: { id: string; qty: number }[]
  regionId: string
  visited: string[]
  npcAttitude: Record<string, number>
  npcAlive: Record<string, boolean>
  questDone: string[]
  eventLog: { at: number; type: string; detail: string }[]
  combat: CombatUnit[] | null
  round: number
  rngCounter: number
  restUsed: number
  conversations: Record<string, ChatTurn[]>
  auditLog?: AuditEntry[]
}

function makeCharacter(difficulty: number): TrpgCharacter {
  const hpMax = difficulty <= 1 ? 34 : difficulty === 3 ? 22 : 28
  const gold = difficulty <= 1 ? 60 : difficulty === 3 ? 20 : 40
  return {
    name: '冒险者',
    level: 1,
    xp: 0,
    attributes: { str: 12, dex: 14, con: 13, int: 11, wis: 12, cha: 12 },
    skills: { stealth: 2, athletics: 1, persuasion: 1, perception: 1 },
    hp: { current: hpMax, max: hpMax },
    ac: 15,
    prof: 2,
    gold,
  }
}

export function attrMod(attr: number): number {
  return Math.floor((attr - 10) / 2)
}

function dcOffset(difficulty: number): number {
  return difficulty <= 1 ? -2 : difficulty === 3 ? 2 : 0
}

// ── 骰子(种子 RNG,历史留档) ──────────────────────────────────────────────────

export interface RollResult {
  roll: number
  total: number
  success: boolean
  nat1: boolean
  nat20: boolean
  detail: string
}

function rollDie(state: TrpgState, sessionId: string, sides: number): number {
  const rng = mulberry32(hashString(sessionId) + state.rngCounter * 2654435761 + 0x9e3779b9)
  state.rngCounter += 1
  return 1 + Math.floor(rng() * sides)
}

export function rollCheck(script: TrpgScript, state: TrpgState, sessionId: string, skill: string, dc: number, advantage: 'none' | 'adv' | 'dis' = 'none', description = ''): RollResult {
  void script
  const normalized = skill.trim().toLowerCase()
  const skillBonus = Object.entries(state.character.skills).find(([k]) => k === normalized || normalized.includes(k))?.[1] ?? 0
  const attrBonus = attrMod(state.character.attributes.dex)
  const rolls = [rollDie(state, sessionId, 20), ...(advantage !== 'none' ? [rollDie(state, sessionId, 20)] : [])]
  const roll = advantage === 'adv' ? Math.max(...rolls) : advantage === 'dis' ? Math.min(...rolls) : rolls[0]
  const total = roll + state.character.prof + skillBonus + attrBonus
  const nat1 = roll === 1
  const nat20 = roll === 20
  const success = !nat1 && (nat20 || total >= dc)
  state.eventLog.push({ at: Date.now(), type: 'check', detail: `${description !== '' ? description + ':' : ''}${skill} d20=${roll} 总计 ${total} vs DC ${dc} → ${success ? '成功' : '失败'}(优势/劣势:${advantage})` })
  state.turns += 1
  return { roll, total, success, nat1, nat20, detail: `d20=${roll} + ${state.character.prof + skillBonus + attrBonus} = ${total} ${success ? '≥' : '<'} DC ${dc} → ${success ? '成功' : '失败'}` }
}

// ── 移动与遭遇 ────────────────────────────────────────────────────────────────

export interface MoveResult {
  text: string
  combat?: boolean
}

export function move(script: TrpgScript, state: TrpgState, sessionId: string, to: string, difficulty: number): MoveResult {
  const current = script.regions.find((r) => r.id === state.regionId)
  const target = script.regions.find((r) => r.id === to || r.name === to || to.includes(r.name))
  if (target === undefined) {
    return { text: `没有「${to}」这个地方。相邻区域:${(current?.adjacent ?? []).map((id) => script.regions.find((r) => r.id === id)?.name).join('、')}。` }
  }
  if (current !== undefined && !current.adjacent.includes(target.id) && target.id !== state.regionId) {
    return { text: `「${target.name}」不接壤。相邻区域:${current.adjacent.map((id) => script.regions.find((r) => r.id === id)?.name).join('、')}。` }
  }
  if (target.requires?.item !== undefined && !state.inventory.some((i) => i.id === target.requires?.item)) {
    const itemName = script.items.find((i) => i.id === target.requires?.item)?.name
    return { text: `你进不去「${target.name}」——需要${itemName ?? '某样东西'}。` }
  }
  state.regionId = target.id
  if (!state.visited.includes(target.id)) state.visited.push(target.id)
  state.turns += 1
  const lines = [`你来到了${target.name}。${target.desc}`]
  // 遭遇检定(种子 RNG,按 danger 与遭遇表)
  if (state.combat === null && target.encounters.length > 0) {
    const totalWeight = target.encounters.reduce((sum, e) => sum + e.weight, 0)
    const roll = rollDie(state, sessionId, totalWeight)
    let acc = 0
    let hitId: string | null = null
    for (const e of target.encounters) {
      acc += e.weight
      if (roll <= acc) {
        hitId = e.id
        break
      }
    }
    if (hitId !== null && roll <= totalWeight * Math.min(1, 0.3 + target.danger * 0.2 + dcOffset(difficulty) * 0.02)) {
      const enemy = script.enemies.find((e) => e.id === hitId)
      if (enemy !== undefined) {
        const combat = startCombat(script, state, [enemy.id])
        const unit = combat.find((u) => !u.dead)
        lines.push(`⚠ 遭遇!${unit?.name ?? '敌人'}拦住了你的去路!进入战斗。`)
        return { text: lines.join('\n'), combat: true }
      }
    }
  }
  const npcsHere = script.npcs.filter((n) => n.regionId === target.id && (state.npcAlive[n.id] ?? true)).map((n) => `${n.name}(${n.role})`)
  if (npcsHere.length > 0) lines.push(`在场的人:${npcsHere.join('、')}`)
  if (target.landmarks.length > 0) lines.push(`可检查:${target.landmarks.map((l) => l.name).join('、')}`)
  return { text: lines.join('\n') }
}

// ── 战斗状态机 ────────────────────────────────────────────────────────────────

function startCombat(script: TrpgScript, state: TrpgState, enemyIds: string[]): CombatUnit[] {
  state.combat = enemyIds.map((id) => {
    const t = script.enemies.find((e) => e.id === id)
    if (t === undefined) throw new Error(`未知敌人 ${id}`)
    const hpMul = state.difficulty <= 1 ? 0.85 : state.difficulty === 3 ? 1.15 : 1
    return { id: t.id, name: t.name, hp: Math.max(1, Math.round(t.hp * hpMul)), max: Math.round(t.hp * hpMul), ac: t.ac, atk: t.atk, dmg: t.dmg, dead: false, drop: t.drop }
  })
  state.round = 1
  state.eventLog.push({ at: Date.now(), type: 'combat_start', detail: enemyIds.join(',') })
  return state.combat
}

export interface CombatResult {
  text: string
  victory?: boolean
  defeat?: boolean
}

function enemyTurn(script: TrpgScript, state: TrpgState, sessionId: string): string[] {
  void script
  const lines: string[] = []
  const player = state.character
  for (const unit of state.combat ?? []) {
    if (unit.dead) continue
    const roll = rollDie(state, sessionId, 20)
    const total = roll + unit.atk
    if (roll === 20 || total >= player.ac) {
      const dmg = rollDie(state, sessionId, unit.dmg[1]) + unit.dmg[2]
      player.hp.current = Math.max(0, player.hp.current - dmg)
      state.eventLog.push({ at: Date.now(), type: 'combat', detail: `${unit.name} 攻击命中,造成 ${dmg} 伤害` })
      lines.push(`${unit.name} 的攻击命中了你,造成 ${dmg} 点伤害。`)
    } else {
      lines.push(`${unit.name} 的攻击落空了。`)
    }
  }
  return lines
}

export function attack(script: TrpgScript, state: TrpgState, sessionId: string, targetKey: string): CombatResult {
  if (state.combat === null) {
    return { text: '现在没有战斗。' }
  }
  const target = state.combat.find((u) => !u.dead && (u.id === targetKey || u.name === targetKey || targetKey.includes(u.name)))
  if (target === undefined) {
    const alive = state.combat.filter((u) => !u.dead).map((u) => u.name)
    return { text: `没有这个敌人。可攻击:${alive.join('、')}。` }
  }
  const player = state.character
  const roll = rollDie(state, sessionId, 20)
  const atkBonus = state.character.prof + attrMod(state.character.attributes.str)
  const lines: string[] = []
  if (roll === 20 || roll + atkBonus >= target.ac) {
    const dmg = rollDie(state, sessionId, 6) + Math.max(1, attrMod(state.character.attributes.str))
    target.hp -= dmg
    state.eventLog.push({ at: Date.now(), type: 'combat', detail: `你攻击 ${target.name} 命中,造成 ${dmg} 伤害` })
    lines.push(`你的短剑命中${target.name},造成 ${dmg} 点伤害。`)
    if (target.hp <= 0) {
      target.dead = true
      lines.push(`${target.name}倒下了!`)
    }
  } else {
    lines.push(`你的攻击落空了(d20=${roll} + ${atkBonus} < AC ${target.ac})。`)
  }
  const alive = state.combat.filter((u) => !u.dead)
  if (alive.length === 0) {
    const victory = endCombatVictory(script, state, sessionId)
    return { text: [...lines, ...victory].join('\n'), victory: true }
  }
  lines.push(...enemyTurn(script, state, sessionId))
  if (player.hp.current <= 0) {
    const defeat = handleDefeat(script, state)
    return { text: [...lines, ...defeat].join('\n'), defeat: true }
  }
  state.round += 1
  state.turns += 1
  lines.push(`(第 ${state.round} 轮,你的 HP ${player.hp.current}/${player.hp.max})`)
  return { text: lines.join('\n') }
}

function endCombatVictory(script: TrpgScript, state: TrpgState, sessionId: string): string[] {
  const lines: string[] = []
  const units = state.combat ?? []
  let totalGold = 0
  for (const unit of units) {
    const drop = unit.drop
    if (drop === undefined) continue
    totalGold += drop.gold
    state.character.xp += drop.xp
    lines.push(`获得 ${drop.xp} 经验。`)
    if (drop.item !== undefined && !state.inventory.some((i) => i.id === drop.item)) {
      const item = script.items.find((i) => i.id === drop.item)
      state.inventory.push({ id: drop.item, qty: item?.qty ?? 1 })
      lines.push(`获得道具:${item?.name ?? drop.item}。`)
    }
    if (drop.questObjective !== undefined) {
      state.questDone.push(drop.questObjective)
      const quest = script.quests.find((q) => q.objectives.some((o) => o.id === drop.questObjective))
      lines.push(`任务推进:「${quest?.objectives.find((o) => o.id === drop.questObjective)?.desc}」完成。`)
    }
  }
  if (totalGold > 0) {
    state.character.gold += totalGold
    lines.push(`搜刮到 ${totalGold} 枚金币。`)
  }
  // 升级:经验阈值 60 / 150
  const thresholds: Record<number, number> = { 1: 60, 2: 150 }
  while (state.character.level < 3 && state.character.xp >= thresholds[state.character.level]) {
    state.character.level += 1
    state.character.hp.max += 5
    state.character.hp.current = state.character.hp.max
    state.character.prof += 1
    lines.push(`你升到了 ${state.character.level} 级!生命上限 +5,熟练加值 +1。`)
  }
  state.combat = null
  state.round = 0
  state.eventLog.push({ at: Date.now(), type: 'combat_end', detail: 'victory' })
  void sessionId
  return ['【战斗胜利】', ...lines]
}

function handleDefeat(script: TrpgScript, state: TrpgState): string[] {
  // 失败不死档:晕倒,被送回松针旅店,HP 恢复 1,丢失 10% 金币
  const lost = Math.floor(state.character.gold * 0.1)
  state.character.gold -= lost
  state.character.hp.current = 1
  state.regionId = 'frostpine'
  state.combat = null
  state.round = 0
  state.eventLog.push({ at: Date.now(), type: 'combat_end', detail: 'defeat' })
  void script
  return [`【你倒下了】你眼前一黑,再醒来时已躺在松针旅店的床上,浑身酸痛,兜里少了 ${lost} 枚金币(损失 10%)。失败不死档——休息一下,再出发。`]
}

export function flee(script: TrpgScript, state: TrpgState, sessionId: string, difficulty: number): CombatResult {
  void script
  if (state.combat === null) return { text: '现在没有战斗。' }
  const dc = 12 + (difficulty === 3 ? 2 : difficulty <= 1 ? -2 : 0)
  const result = rollCheck(script, state, sessionId, 'stealth', dc, 'none', '逃离战斗')
  if (result.success) {
    state.combat = null
    state.round = 0
    state.eventLog.push({ at: Date.now(), type: 'combat_end', detail: 'fled' })
    return { text: `你瞅准空当,转身钻进了雾里,甩掉了追兵。(${result.detail})` }
  }
  const lines = [`你没能甩掉敌人!(${result.detail})`]
  lines.push(...enemyTurn(script, state, sessionId))
  if (state.character.hp.current <= 0) {
    lines.push(...handleDefeat(script, state))
    return { text: lines.join('\n'), defeat: true }
  }
  state.turns += 1
  return { text: lines.join('\n') }
}

// ── 检查/使用/休息 ────────────────────────────────────────────────────────────

export function examine(script: TrpgScript, state: TrpgState, target: string): string {
  const region = script.regions.find((r) => r.id === state.regionId)
  if (region === undefined) return '你在一片虚空之中。'
  const norm = target.trim()
  const landmark = region.landmarks.find((l) => l.id === norm || l.name === norm || norm.includes(l.name) || l.name.includes(norm))
  if (landmark !== undefined) {
    const exam = landmark.examine
    if (exam !== undefined) {
      const missing = exam.requires.filter((r) => !state.questDone.includes(r) && !state.inventory.some((i) => i.id === r))
      if (missing.length > 0) {
        return `${landmark.desc}\n(线索还不够——先去别处看看)`
      }
      const lines = [landmark.desc, exam.text]
      if (exam.item !== undefined && !state.inventory.some((i) => i.id === exam.item)) {
        const item = script.items.find((i) => i.id === exam.item)
        state.inventory.push({ id: exam.item, qty: item?.qty ?? 1 })
        lines.push(`(获得:${item?.name ?? exam.item})`)
      }
      if (exam.questObjective !== undefined && !state.questDone.includes(exam.questObjective)) {
        state.questDone.push(exam.questObjective)
        const quest = script.quests.find((q) => q.objectives.some((o) => o.id === exam.questObjective))
        lines.push(`任务推进:「${quest?.objectives.find((o) => o.id === exam.questObjective)?.desc}」完成。`)
      }
      state.turns += 1
      return lines.join('\n')
    }
    return landmark.desc
  }
  const npc = script.npcs.find((n) => (n.id === norm || n.name === norm || norm.includes(n.name)) && n.regionId === state.regionId)
  if (npc !== undefined) {
    return `${npc.name}(${npc.role}):${npc.bio}`
  }
  return `这里没有「${target}」。可检查:${region.landmarks.map((l) => l.name).join('、') || '(无)'}。`
}

export function useItem(script: TrpgScript, state: TrpgState, itemKey: string): string {
  const byName = script.items.find((i) => i.id === itemKey || i.name === itemKey || itemKey.includes(i.name) || i.name.includes(itemKey))
  const entry = state.inventory.find((i) => i.id === itemKey || (byName !== undefined && i.id === byName.id))
  if (entry === undefined) {
    return byName !== undefined ? `你的背包里没有${byName.name}。` : `你没有「${itemKey}」。`
  }
  const item = script.items.find((i) => i.id === entry.id)
  if (item?.use === undefined) {
    return `${item?.name ?? entry.id}似乎不能这样用。`
  }
  if (item.use.heal !== undefined) {
    if (state.character.hp.current >= state.character.hp.max) return '你并没有受伤。'
    state.character.hp.current = Math.min(state.character.hp.max, state.character.hp.current + item.use.heal)
    entry.qty -= 1
    state.turns += 1
    return `${item.use.text}(恢复 ${item.use.heal} 点,现 HP ${state.character.hp.current}/${state.character.hp.max})`
  }
  if (item.use.opens !== undefined) {
    const region = script.regions.find((r) => r.id === item.use?.opens)
    return region !== undefined ? `${item.use.text}(现在可以前往${region.name}了)` : item.use.text
  }
  if (item.use.giveTo !== undefined) {
    const npc = script.npcs.find((n) => n.id === item.use?.giveTo)
    if (npc === undefined || npc.regionId !== state.regionId) {
      return npc !== undefined ? `${npc.name}不在这里。` : '收礼的人不在这里。'
    }
    entry.qty -= 1
    state.character.gold += 20
    state.questDone.push('obj_mold')
    state.npcAttitude[npc.id] = (state.npcAttitude[npc.id] ?? 0) + 3
    state.turns += 1
    return `${item.use.text}(获得 20 金币;任务「铁匠的模具」完成)`
  }
  return item.use.text
}

export function rest(script: TrpgScript, state: TrpgState): string {
  void script
  if (state.restUsed >= 3) {
    return '你已经休整过太多次,身体再也躺不住了。'
  }
  state.restUsed += 1
  const heal = Math.min(10, state.character.hp.max - state.character.hp.current)
  state.character.hp.current += heal
  state.turns += 1
  return `你在旅店歇了一晚,恢复 ${heal} 点生命(现 HP ${state.character.hp.current}/${state.character.hp.max};今日休整 ${state.restUsed}/3)。`
}

// ── NPC 对话(插件侧 LLM + 审计) ───────────────────────────────────────────────

export async function talk(
  ctx: Context,
  sessionId: string,
  route: AgentRoute,
  script: TrpgScript,
  state: TrpgState,
  npcId: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const npc = script.npcs.find((n) => n.id === npcId || n.name === npcId)
  if (npc === undefined) {
    return `没有这个人。在场可选:${script.npcs.filter((n) => n.regionId === state.regionId).map((n) => n.name).join('、') || '(无)'}。`
  }
  if (npc.regionId !== state.regionId) {
    return `${npc.name}不在这里。`
  }
  if (!(state.npcAlive[npc.id] ?? true)) {
    return `${npc.name}已经不在了。`
  }
  const attitude = state.npcAttitude[npc.id] ?? 0
  const system = [
    `你在单人跑团《${script.title}》中扮演「${npc.name}」(${npc.role})。`,
    `你的性格:${npc.persona}`,
    `你的公开身份:${npc.bio}`,
    `你对玩家的好感度:${attitude > 0 ? '+' : ''}${attitude}(正数=亲近,负数=戒备)`,
    `你【只知道以下事实】(除此之外你一概不知):`,
    ...(npc.knowledge.length > 0 ? npc.knowledge.map((id) => `- ${script.facts.find((f) => f.id === id)?.text ?? id}`) : ['- (没什么特别的见闻)']),
    `你绝不能承认或说出:${npc.mustNotAdmit.map((id) => script.facts.find((f) => f.id === id)?.text ?? id).join(';') || '无'}`,
    `你的说话边界:${npc.liePolicy}`,
    '对话要求:第一人称、口语化、1-3 句话;不知道的事就说不知道;不要替玩家掷骰或决定成败。',
  ].join('\n')
  let reply: string
  try {
    const out = await talkAsNpc(ctx, {
      sessionId,
      route,
      label: `npc:trpg:${npc.id}`,
      system,
      user: `玩家说:${text}`,
      history: (state.conversations[npc.id] ?? []).slice(-6),
      maxTokens: 300,
      signal,
    })
    reply = out.text
  } catch {
    reply = `${npc.name}含糊地应了一声。`
  }
  const verdict = auditReply({ facts: script.facts, npc: Object.fromEntries(script.npcs.map((n) => [n.id, { knowledge: n.knowledge, mustNotAdmit: n.mustNotAdmit }])) }, npc.id, reply)
  if (verdict.flagged) {
    state.auditLog = [...(state.auditLog ?? []), { npcId: npc.id, at: Date.now(), kind: 'slip', factIds: [...verdict.outOfScope, ...verdict.slipped], snippet: reply }]
    reply = sanitizedLine(npc.name)
  }
  state.conversations[npc.id] = [
    ...(state.conversations[npc.id] ?? []),
    { role: 'user' as const, text },
    { role: 'assistant' as const, text: reply },
  ].slice(-8)
  state.turns += 1
  return `「${npc.name}」:${reply}`
}

// ── 计分与文案 ────────────────────────────────────────────────────────────────

function questProgress(script: TrpgScript, state: TrpgState): { done: number; total: number } {
  const total = script.quests.reduce((sum, q) => sum + q.objectives.length, 0)
  const done = state.questDone.filter((id) => script.quests.some((q) => q.objectives.some((o) => o.id === id))).length
  return { done, total }
}

export function trpgScore(script: TrpgScript, state: TrpgState): ScoreBar[] {
  const progress = questProgress(script, state)
  return [
    { label: '冒险进度', value: Math.round((progress.done / Math.max(progress.total, 1)) * 100), note: `任务目标 ${progress.done}/${progress.total}` },
    { label: '角色成长', value: Math.min(100, Math.round(state.character.xp / 3)), note: `${state.character.xp} 经验 · 等级 ${state.character.level}` },
    { label: '生存状态', value: Math.max(0, Math.round((state.character.hp.current / state.character.hp.max) * 100)), note: `HP ${state.character.hp.current}/${state.character.hp.max} · 金币 ${state.character.gold}` },
  ]
}

function settleText(script: TrpgScript, state: TrpgState): string {
  const progress = questProgress(script, state)
  const log = state.eventLog.slice(-12).map((e) => `- ${e.type}:${e.detail}`).join('\n')
  return `【跑团 · 结算】${script.title}
${trpgScore(script, state).map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

【冒险回顾】任务目标 ${progress.done}/${progress.total} · 探明区域 ${state.visited.map((id) => script.regions.find((r) => r.id === id)?.name).filter(Boolean).join('、')}
【事件日志(最近)】
${log || '(无)'}`
}

function scoreText(script: TrpgScript, state: TrpgState): string {
  return `【跑团 · 当前状态】${script.regions.find((r) => r.id === state.regionId)?.name ?? state.regionId} · HP ${state.character.hp.current}/${state.character.hp.max} · 金币 ${state.character.gold}

${trpgScore(script, state).map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

/sheet 看角色卡,/quests 看任务,/world 看地图。`
}

function buildBrief(script: TrpgScript, state: TrpgState): string {
  const regions = script.regions.map((r) => `- ${r.name}:${r.desc}`).join('\n')
  return `【游戏开始:单人跑团 · ${script.title}】(难度 ${state.difficulty}/3)

现在你是本局的地下城主(DM)。玩家是${script.title}的冒险者,自由行动、自由冒险。请遵守以下铁律:

1. 数值只能来自引擎:骰子、伤害、检定、任务状态一律引用工具返回值,你【禁止自行报点、自行加减血、自行给物品、自行宣布任务完成】。
2. 意图解析:玩家自由输入后,先解析为引擎工具调用,拿到结果后再渲染叙事:
   - 移动 → \`trpg_move\`(to);检查地点/物品/人物 → \`trpg_examine\`;
   - 技能检定/奇招 → \`trpg_check\`(skill + dc:你按难度提议 DC 5-25,由引擎掷骰并留档;成功后由你渲染后果,但 HP/状态变化必须走引擎);
   - 对话 → \`trpg_talk\`(npc + text,台词由引擎生成并过审计);
   - 使用物品 → \`trpg_use\`;拾取 → \`trpg_take\`;
   - 战斗 → \`trpg_attack\`(target)/ \`trpg_flee\`;休整 → \`trpg_rest\`。
3. 状态忠实:每次回复基于引擎快照(区域/HP/背包/任务),不得描写玩家没有的物品、已死的 NPC 或未到达的区域。
4. 失败不死档:检定失败、战斗失利用"后果"渲染(丢失金币、惊动守卫、被送回旅店),而非死档惩罚。
5. 玩家可以用 /sheet /quests /world /bag /map /hint /game score /game quit。

${script.intro}

【初始装备】短剑、麻绳、治疗药水 ×2;金币 ${state.character.gold}。

【已知区域】
${regions}

用两三句 DM 口吻的开场白描述松针旅店的黄昏,并等待玩家第一个动作。`
}

function resumeBrief(script: TrpgScript, state: TrpgState): string {
  const progress = questProgress(script, state)
  return `【继续游戏:单人跑团 · ${script.title}】你在${script.regions.find((r) => r.id === state.regionId)?.name ?? state.regionId},HP ${state.character.hp.current}/${state.character.hp.max},任务进度 ${progress.done}/${progress.total}。你仍是 DM:数值只走引擎;玩家动作经 trpg_move / trpg_examine / trpg_check / trpg_talk / trpg_use / trpg_attack / trpg_flee / trpg_rest 工具执行。请提醒玩家"我们继续",并简述上次的处境。`
}

// ── 面板(/sheet /quests /world /bag /map) ────────────────────────────────────

export type TrpgPanel = 'sheet' | 'quests' | 'world' | 'bag' | 'map'

export function panelText(script: TrpgScript, state: TrpgState, panel: TrpgPanel): string {
  switch (panel) {
    case 'sheet': {
      const c = state.character
      const attrs = Object.entries(c.attributes).map(([k, v]) => `${k.toUpperCase()} ${v}(${v >= 10 ? '+' : ''}${attrMod(v)})`).join(' · ')
      const skills = Object.entries(c.skills).map(([k, v]) => `${k} +${v}`).join(' · ')
      return `【角色卡】${c.name} · 等级 ${c.level} · 经验 ${c.xp}
HP ${c.hp.current}/${c.hp.max} · AC ${c.ac} · 熟练加值 +${c.prof} · 金币 ${c.gold}
属性:${attrs}
技能:${skills}`
    }
    case 'quests': {
      const lines = script.quests.map((q) => {
        const objs = q.objectives.map((o) => `  ${state.questDone.includes(o.id) ? '☑' : '☐'} ${o.desc}`).join('\n')
        const doneAll = q.objectives.every((o) => state.questDone.includes(o.id))
        return `【${q.type === 'main' ? '主线' : '支线'}】${q.title}${doneAll ? '(已完成,奖励 ' + q.reward.gold + ' 金 / ' + q.reward.xp + ' 经验)' : ''}\n${objs}`
      })
      return `【任务日志】\n${lines.join('\n\n')}`
    }
    case 'world': {
      const lines = script.regions.map((r) => `- ${r.name}${r.id === state.regionId ? ' ← 你在这里' : ''}${state.visited.includes(r.id) ? '' : '(未探明)'} · 相邻:${r.adjacent.map((id) => script.regions.find((x) => x.id === id)?.name).join('/')}`)
      return `【世界地图】\n${lines.join('\n')}`
    }
    case 'bag': {
      const lines = state.inventory.map((i) => {
        const item = script.items.find((x) => x.id === i.id)
        return `- ${item?.name ?? i.id} ×${i.qty}:${item?.desc ?? ''}`
      })
      return `【背包】\n${lines.join('\n') || '(空)'}`
    }
    case 'map': {
      return panelText(script, state, 'world')
    }
  }
}

// ── 引擎入口 ──────────────────────────────────────────────────────────────────

/** 构造初始状态(引擎与测试/世界求解器共用)。 */
export function makeTrpgState(script: TrpgScript, difficulty: number, rngCounter = 1): TrpgState {
  const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
  const now = Date.now()
  return {
    scheme: 'trpg',
    difficulty: level,
    startedAt: now,
    updatedAt: now,
    phase: 'playing' as GamePhase,
    turns: 0,
    hintsUsed: 0,
    score: null,
    character: makeCharacter(level),
    inventory: [
      { id: 'shortsword', qty: 1 },
      { id: 'potion', qty: 2 },
      { id: 'rope', qty: 1 },
    ],
    regionId: script.startRegion,
    visited: [script.startRegion],
    npcAttitude: {},
    npcAlive: {},
    questDone: [],
    eventLog: [],
    combat: null,
    round: 0,
    rngCounter,
    restUsed: 0,
    conversations: {},
    auditLog: [],
  }
}

/** 世界池:手工招牌 + 通过求解器的程序化世界(按会话确定性选本)。 */
const WORLD_POOL = new Map<number, TrpgScript[]>()

function pickWorld(seed: number): TrpgScript {
  let pool = WORLD_POOL.get(2)
  if (pool === undefined) {
    pool = [FROSTPINE]
    for (let s2 = 1; pool.length < 3 && s2 < 120; s2 += 1) {
      const world = generateWorld(s2, 2)
      if (solveWorld(world).ok && !pool.some((x) => x.id === world.id)) pool.push(world)
    }
    WORLD_POOL.set(2, pool)
  }
  return pool[Math.abs(seed) % pool.length]
}

export const trpgEngine: SchemeEngine = {
  id: 'trpg',
  label: '单人跑团',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const script = pickWorld(hashString(sessionId))
    const state = makeTrpgState(script, difficulty)
    return { state, truth: script, brief: buildBrief(script, state) }
  },
  resumeBrief(state, truth) {
    const script = (truth as TrpgScript | undefined) ?? FROSTPINE
    return resumeBrief(script, state as TrpgState)
  },
  scoreText(state, truth) {
    const script = (truth as TrpgScript | undefined) ?? FROSTPINE
    return scoreText(script, state as TrpgState)
  },
  settleText(state, truth) {
    return settleText(truth as TrpgScript, state as TrpgState)
  },
  hint(state, truth) {
    const script = truth as TrpgScript
    const idx = Math.min((state as TrpgState).hintsUsed, script.hints.length - 1)
    return { text: `【提示 ${idx + 1}/${script.hints.length}】${script.hints[idx]}` }
  },
}

/** 战斗模拟器:固定角色 vs 敌人,跑 N 场,统计胜率(回归测试用)。 */
export function combatSimulate(seed: number, enemyId: string, difficulty: number, rounds: number): { wins: number; losses: number; avgPlayerHp: number } {
  let wins = 0
  let losses = 0
  let hpSum = 0
  const script = FROSTPINE
  for (let i = 0; i < rounds; i++) {
    const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
    const now = Date.now()
    const state: TrpgState = {
      scheme: 'trpg',
      difficulty: level,
      startedAt: now,
      updatedAt: now,
      phase: 'playing',
      turns: 0,
      hintsUsed: 0,
      score: null,
      character: makeCharacter(level),
      inventory: [{ id: 'shortsword', qty: 1 }],
      regionId: 'arena',
      visited: ['arena'],
      npcAttitude: {},
      npcAlive: {},
      questDone: [],
      eventLog: [],
      combat: null,
      round: 0,
      rngCounter: seed * 1000 + i,
      restUsed: 0,
      conversations: {},
      auditLog: [],
    }
    const sessionId = `sim-${seed}-${i}`
    startCombat(script, state, [enemyId])
    let guard = 0
    while (state.combat !== null && guard < 100) {
      const target = state.combat.find((u) => !u.dead)
      if (target === undefined) break
      const result = attack(script, state, sessionId, target.id)
      if (result.victory) {
        wins += 1
        break
      }
      if (result.defeat) {
        losses += 1
        break
      }
      guard += 1
    }
    if (guard >= 100) throw new Error('战斗模拟死循环')
    hpSum += state.character.hp.current
  }
  return { wins, losses, avgPlayerHp: Math.round((hpSum / rounds) * 10) / 10 }
}
