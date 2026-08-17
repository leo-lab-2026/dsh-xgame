/**
 * 方案一·雾都谜案(侦探推理,旗舰方案)。
 * 案卷(真相)封存于 truth 文件;GM 与玩家只能通过引擎动作获得线索投影。
 * NPC 审讯由插件侧 LLM 完成:真相只进插件上下文,不进主 agent 上下文。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { completeChat, extractJson, type ChatTurn } from '../core/llm.js'
import { type AuditEntry } from '../core/audit.js'
import type { SchemeEngine } from '../core/manager.js'
import { generateCase } from './casegen.js'
import { hashString } from '../core/rand.js'
import { solveCase } from './solver.js'

export interface NpcScript {
  /** 公开人设(公开信息)与性格、说话风格。 */
  persona: string
  /** 他知道的真相事实 id。 */
  knowledge: string[]
  /** 绝不承认的事实 id(说谎边界)。 */
  mustNotAdmit: string[]
  /** 说谎策略。 */
  liePolicy: string
  /** 凶手专用:他做了什么、如何伪装。 */
  guilt?: string
  /** 铁证齐备时的崩溃反应。 */
  collapse?: string
}

export interface CaseFact {
  id: string
  type: 'timeline' | 'physical' | 'motive' | 'testimony'
  text: string
  /** 求解器注解:该事实排除这些嫌疑人(如不在场证明)。 */
  excludes?: string[]
  /** 审计注解:命中 ≥2 个关键词即视为台词提及该事实(防改写漏网)。 */
  auditKeywords?: string[]
}

export interface CaseClue {
  id: string
  location: string
  description: string
  reveals: string[]
  redHerring?: string
  /** 求解器注解:该线索直接排除这些嫌疑人。 */
  exonerates?: string[]
  /** 求解器注解:该线索是误导线索,指向这些嫌疑人(其必须有排除证据)。 */
  misleadsTo?: string[]
}

export interface DetectiveCase {
  caseId: string
  title: string
  difficulty: number
  setting: string
  opening: string
  victim: { name: string; role: string; death: string }
  locations: string[]
  suspects: { id: string; name: string; role: string; bio: string }[]
  murderer: string
  solution: { means: string; motive: string; opportunity: string }
  facts: CaseFact[]
  clues: CaseClue[]
  keyClueIds: string[]
  npc: Record<string, NpcScript>
  hints: [string, string, string]
  /** 求解器注解:解法核心事实,必须由关键线索揭示,且每条关键线索都不可缺失。 */
  solutionFactIds?: string[]
}

export interface DetectiveState extends GameStateBase {
  scheme: 'detective'
  caseId: string
  discoveredClues: string[]
  conversations: Record<string, ChatTurn[]>
  evidenceShown: Record<string, string[]>
  accusedId: string | null
  theoryText: string | null
  verdict: VerifierResult | null
  /** 泄密审计日志(越界/说漏嘴的发言在此留证,结算时作废并说明)。 */
  auditLog?: AuditEntry[]
}

export interface VerifierResult {
  murdererCorrect: boolean
  meansCorrect: boolean
  motiveCorrect: boolean
  reasoningScore: number
  comment: string
  claims: { claim: string; verdict: 'confirmed' | 'supported' | 'wrong' | 'unsupported'; note: string }[]
}

// ── 手工案件:雾都公馆 ───────────────────────────────────────────────────────

export const FOG_MANSION: DetectiveCase = {
  caseId: 'fog-mansion',
  title: '雾都公馆',
  difficulty: 2,
  setting: '1920 年代的伦敦郊外,冬夜,大雪封路。',
  opening: '雾都公馆的主人亚瑟·布莱克伍德被发现死在书房:头部遭钝击,门从内反锁,窗户也从内锁着——一间密室。死亡时间约在 21:40 至 22:00。你是应邀而来的侦探,公馆内有五名相关人士:管家哈洛、侄女伊芙琳、家庭医生白医生、远亲作家楚小姐、园丁托马斯。',
  victim: { name: '亚瑟·布莱克伍德', role: '公馆主人', death: '书房内头部钝击,约 21:47,现场呈密室状' },
  locations: ['书房', '卧室', '温室', '湖边', '沙龙', '管家房', '工具房'],
  suspects: [
    { id: 's_butler', name: '哈洛', role: '管家', bio: '服侍布莱克伍德家二十年的老管家,沉稳寡言,今晚负责晚宴服侍。' },
    { id: 's_heir', name: '伊芙琳', role: '侄女(继承人)', bio: '死者的侄女,父母早亡,由伯父抚养;最近因遗产分配与伯父争吵。' },
    { id: 's_doctor', name: '白医生', role: '家庭医生', bio: '每周来两次为死者检查心脏,今晚留宿公馆。' },
    { id: 's_writer', name: '楚小姐', role: '远亲(作家)', bio: '远房表亲,小说家,为采风暂住公馆,案发时在沙龙写作。' },
    { id: 's_gardener', name: '托马斯', role: '园丁', bio: '沉默寡言,负责温室与庭院;据说年轻时坐过牢。' },
  ],
  murderer: 's_butler',
  solution: {
    means: '以壁炉火钳从背后钝击死者',
    motive: '死者发现管家就是二十年前卷款潜逃的银行职员"伊莱·莫顿",打算将其揭发',
    opportunity: '从书房书架后的暗门进出,再从走廊撞门,制造密室假象',
  },
  facts: [
    { id: 'f_darkdoor', type: 'physical', text: '书房书架后有一道暗门,通往屋外的湖边小径;门轴新近上过油。' },
    { id: 'f_poker', type: 'physical', text: '凶器是壁炉火钳。' },
    { id: 'f_poker_missing', type: 'physical', text: '书房壁炉旁的火钳少了一根。' },
    { id: 'f_lake', type: 'physical', text: '凶器火钳被扔进了湖里。' },
    { id: 'f_identity', type: 'motive', text: '管家哈洛原名"伊莱·莫顿",二十年前是银行职员,卷款潜逃。' },
    { id: 'f_wetcoat', type: 'physical', text: '管家在案发后去过湖边。' },
    { id: 'f_footstep', type: 'timeline', text: '21:50 左右伊芙琳到过书房门口。', excludes: ['s_heir'] },
    { id: 'f_burn', type: 'testimony', text: '伊芙琳在温室烧掉了一封信。' },
    { id: 'f_time', type: 'timeline', text: '死亡时间约 21:47(怀表被击碎时停止)。' },
    { id: 'f_keyhole', type: 'timeline', text: '伊芙琳到书房时,门已反锁且里面无人应声。' },
    { id: 'f_alibi_writer', type: 'testimony', text: '楚小姐 21:00-22:00 在沙龙写作,期间听到 21:50 楼梯有脚步声。', excludes: ['s_writer'] },
    { id: 'f_threat', type: 'motive', text: '死者最近威胁要解雇园丁。' },
    { id: 'f_doctor_visit', type: 'timeline', text: '白医生 21:30-22:00 一直在二楼客房,为烫伤的女仆处理伤口。', excludes: ['s_doctor'] },
    { id: 'f_gardener_split', type: 'timeline', text: '园丁 21:00-22:00 一直在柴房劈柴,女仆路过时看到。', excludes: ['s_gardener'] },
  ],
  clues: [
    { id: 'e_poker', location: '书房', description: '壁炉旁的火钳少了一根,石架上有新鲜的划痕,炉灰似被人拨动过。', reveals: ['f_poker_missing'] },
    { id: 'e_wet', location: '书房', description: '窗下地毯上有一小片湿痕,形状像鞋印;窗户本身从内锁着,完好无损。', reveals: [] },
    { id: 'e_darkdoor', location: '书房', description: '书架后藏着一道暗门,通往屋外的湖边小径;门轴新近上过油,把手被擦得很干净。', reveals: ['f_darkdoor'] },
    { id: 'e_clock', location: '书房', description: '死者的怀表摔碎在地,指针停在 21:47。', reveals: ['f_time'] },
    { id: 'e_letter', location: '卧室', description: '死者书桌暗格里有一封二十年前的银行旧信,提到职员"伊莱·莫顿"卷款潜逃,还附着一张年轻职员的合影。', reveals: ['f_identity'] },
    { id: 'e_lake', location: '湖边', description: '湖面冰层有一处破口,岸边泥地有一行男人的脚印;打捞起一根火钳,柄上沾着暗色痕迹。', reveals: ['f_lake', 'f_poker'] },
    { id: 'e_wetcoat', location: '管家房', description: '管家房的炉边挂着一件湿外套,袖口沾着湖泥。管家称是"下午擦窗弄湿的"。', reveals: ['f_wetcoat'] },
    { id: 'e_shoeprint', location: '温室', description: '泥地上有一行女鞋印,鞋底纹路里嵌着书房地毯的蓝色绒絮。', reveals: ['f_footstep'] },
    { id: 'e_ashes', location: '温室', description: '炭盆里有烧剩的纸角,隐约可辨"抱歉"二字。', reveals: ['f_burn'], misleadsTo: ['s_heir'] },
    { id: 'e_notes', location: '沙龙', description: '楚小姐的笔记本摊开着,今晚的时间线旁有一行小字:"21:50,楼梯有脚步声,书房方向。"', reveals: ['f_alibi_writer'] },
    { id: 'e_shears', location: '工具房', description: '工具房里有一把新磨的大剪刀,刀刃极锋利;园丁说是修花枝用的。', reveals: [], redHerring: '凶器其实是火钳,剪刀是障眼法', misleadsTo: ['s_gardener'] },
    { id: 'e_bandage', location: '卧室', description: '客房桌上的烫伤膏与女仆的手帕——女仆说 21:30 到 22:00 白医生一直在给她处理烫伤。', reveals: ['f_doctor_visit'] },
    { id: 'e_wood', location: '工具房', description: '柴房门口堆着新劈的柴,斧头还嵌在木桩上;女仆说园丁整晚都在劈柴。', reveals: ['f_gardener_split'] },
  ],
  keyClueIds: ['e_lake', 'e_letter'],
  solutionFactIds: ['f_identity', 'f_lake'],
  npc: {
    s_butler: {
      persona: '老派管家,措辞恭敬而缓慢;被逼问时眼神会不自觉地看向壁炉。',
      knowledge: ['f_darkdoor', 'f_identity', 'f_poker', 'f_lake', 'f_wetcoat'],
      mustNotAdmit: ['f_identity', 'f_poker', 'f_lake', 'f_wetcoat'],
      liePolicy: '声称 21:30 后一直在配餐室准备夜宵;外套湿是下午擦窗;听到异响才去书房,发现门反锁后撞门。绝口不提湖边与暗门。',
      guilt: '你杀了亚瑟:21:45 从暗门进入书房,用壁炉火钳从背后击中他,再从暗门离开,把火钳扔进湖里,最后从走廊撞门制造密室。你必须伪装无辜。',
      collapse: '当玩家向你出示"湖中火钳"与"旧信"两件铁证后,你崩溃并部分认罪:承认自己就是伊莱·莫顿,承认火钳是自己扔的,但辩称"是他先要毁了我"。',
    },
    s_heir: {
      persona: '大小姐脾气,紧张时语速变快,手指绞着披肩。',
      knowledge: ['f_footstep', 'f_burn', 'f_keyhole'],
      mustNotAdmit: ['f_footstep', 'f_burn'],
      liePolicy: '先声称整晚在温室;被鞋印证据戳穿后改口"到过书房门口,门反锁着,以为他睡了";被纸灰证据戳穿后承认烧的是自己写给伯父的信(为争吵道歉)。',
    },
    s_doctor: {
      persona: '冷静克制,满口医学术语,对时间点很敏感。',
      knowledge: ['f_time', 'f_doctor_visit'],
      mustNotAdmit: [],
      liePolicy: '不说谎,只陈述验尸与检查结论;对没有把握的推测不置可否。',
    },
    s_writer: {
      persona: '观察力强,语带机锋,喜欢复述别人话里的矛盾。',
      knowledge: ['f_alibi_writer', 'f_darkdoor'],
      mustNotAdmit: ['f_darkdoor'],
      liePolicy: '基本如实,但隐瞒自己幼时发现过书房暗门这件事(怕被怀疑);被追问才会承认。',
    },
    s_gardener: {
      persona: '沉默寡言,有戒心,被冤枉时会突然激动。',
      knowledge: ['f_threat', 'f_gardener_split'],
      mustNotAdmit: ['f_threat'],
      liePolicy: '隐瞒自己坐过牢与被死者威胁解雇的事;对"为什么磨剪刀"支支吾吾(其实是修剪花枝)。',
    },
  },
  hints: [
    '把每个人的不在场证明和时间线对齐——尤其是 21:40 到 22:00 之间。',
    '密室有两种:真的进不去,或者有别的路。书房里也许有第三扇"门"。',
    '湖边的发现和管家房里的东西,指向同一个人。',
  ],
}

const CASES: DetectiveCase[] = [FOG_MANSION]

/** 每难度的程序化案件池(惰性构建;生成后一律过求解器,不合格换种子重生成)。 */
const GENERATED_POOL = new Map<number, DetectiveCase[]>()

function generatedPool(difficulty: number): DetectiveCase[] {
  const cached = GENERATED_POOL.get(difficulty)
  if (cached) return cached
  const pool: DetectiveCase[] = []
  let seed = difficulty * 100003
  let attempts = 0
  while (pool.length < 4 && attempts < 24) {
    attempts += 1
    try {
      const caseData = generateCase(seed, difficulty)
      if (solveCase(caseData).ok) pool.push(caseData)
    } catch {
      // 生成异常,换种子重试
    }
    seed += 1
  }
  if (pool.length === 0) {
    throw new Error('dsh-xgame:案件生成器未能产出可解案件,请反馈该错误')
  }
  GENERATED_POOL.set(difficulty, pool)
  return pool
}

/** 选择案件:手工招牌案件 + 通过求解器门禁的程序化案件。 */
export function pickCase(difficulty: number, seed: number): DetectiveCase {
  const manual = CASES.filter((c) => c.difficulty === difficulty)
  const pool = [...manual, ...generatedPool(difficulty)]
  return pool[Math.abs(seed) % pool.length]
}

/** 铁证崩溃:凶手 + 全部关键线索已出示 + 有崩溃台词时,返回该台词(否则 null)。 */
export function scriptedCollapse(caseData: DetectiveCase, evidenceShown: Record<string, string[]>, suspectId: string): string | null {
  const script = caseData.npc[suspectId]
  if (!script?.collapse) return null
  if (suspectId !== caseData.murderer) return null
  const shown = evidenceShown[suspectId] ?? []
  const hasAllKeys = caseData.keyClueIds.every((k) => shown.includes(k))
  return hasAllKeys ? script.collapse : null
}

// ── 文案 ────────────────────────────────────────────────────────────────────

/** NPC 系统提示所需的结构视图(侦探案卷/剧本杀剧本/时间循环剧本都满足)。 */
export interface NpcCaseView {
  title: string
  suspects: { id: string; name: string; role: string; bio: string }[]
  facts: CaseFact[]
  npc: Record<string, NpcScript>
}

export function factText(caseData: { facts: CaseFact[] }, id: string): string {
  return caseData.facts.find((f) => f.id === id)?.text ?? id
}

export function buildNpcSystem(caseData: NpcCaseView, npcId: string): string {
  const suspect = caseData.suspects.find((s) => s.id === npcId)
  if (!suspect) throw new Error(`未知 NPC:${npcId}`)
  const script = caseData.npc[npcId]
  const lines: string[] = []
  lines.push(`你在推理游戏《${caseData.title}》中扮演角色「${suspect.name}」(${suspect.role})。`)
  lines.push(`你的人设:${script.persona}`)
  lines.push(`你的公开身份:${suspect.bio}`)
  lines.push('')
  lines.push('你【只知道以下事实】(除此之外的案情你一概不知,也不知道凶手是谁):')
  for (const factId of script.knowledge) {
    lines.push(`- ${factText(caseData, factId)}`)
  }
  lines.push('')
  lines.push(`你绝不能承认或说出的事实:${script.mustNotAdmit.map((id) => factText(caseData, id)).join(';') || '无'}`)
  lines.push(`你的说谎策略:${script.liePolicy}`)
  if (script.guilt) {
    lines.push('')
    lines.push(`【你的秘密】${script.guilt}`)
  }
  lines.push('')
  lines.push('对话要求:始终以第一人称、口语化回答;一次说 1-3 句话;不要跳出角色;被问到你不知道的事时,按你的性格回避、推脱或说"不清楚",绝不要编造与上面事实矛盾的确切供词;不要主动自爆。')
  return lines.join('\n')
}

function buildBrief(caseData: DetectiveCase, state: DetectiveState): string {
  const suspectList = caseData.suspects.map((s) => `- ${s.name}(${s.role}):${s.bio}`).join('\n')
  return `【游戏开始:侦探推理 · ${caseData.title}】(难度 ${caseData.difficulty}/3)

现在你是本局的主持人(侦探助手),我是玩家扮演的侦探。案情真相只存在于游戏引擎中,你的上下文里【没有】凶手与真相。请遵守以下铁律:

1. 场景与线索【只能通过工具获得】:玩家要求勘查某地点时,调用 \`detective_examine\` 工具(参数 target 为地点名或线索名);引擎返回什么,你才能叙述什么。严禁自行编造线索、证词或现场细节。
2. 审讯【必须通过工具】:玩家要与某个 NPC 说话时,调用 \`detective_talk\` 工具,把玩家的话原文传给引擎,引擎会返回 NPC 的回应,你再以主持人口吻转述(可以加一点神态描写,但不得改动回应内容)。
3. 出示证据用 \`detective_show\` 工具;玩家指控凶手用 \`detective_accuse\`;玩家提交完整推理报告用 \`detective_submit_theory\`。
4. 不要暗示或泄露你"不知道"的真相;你只负责主持节奏、渲染氛围、整理玩家已获得的线索。
5. 玩家可以用 /casefile 看已收集线索、/game score 查进度、/hint 买提示、/game quit 结束看真相。

【案情简报】
${caseData.setting}
${caseData.opening}

【相关人士】
${suspectList}

【可勘查地点】${caseData.locations.join('、')}

用两三句主持人的开场白欢迎侦探,并等待玩家第一个指令。`
}

function resumeBrief(state: DetectiveState): string {
  const clueCount = state.discoveredClues.length
  return `【继续游戏:侦探推理】你仍是主持人,真相仍在引擎中。已收集 ${clueCount} 条线索。请提醒玩家继续调查;玩家动作一律通过 detective_examine / detective_talk / detective_show / detective_accuse / detective_submit_theory 工具执行。`
}

function scoreBars(state: DetectiveState): ScoreBar[] {
  if (state.score) return state.score
  const solved = state.phase === 'solved'
  return [
    { label: '结论正确性', value: solved ? 100 : 0, note: solved ? '已锁定真相' : '尚未定论' },
    { label: '推理质量', value: state.verdict?.reasoningScore ?? 0, note: state.verdict ? '由独立评审按断言逐条评分' : '提交推理报告后评分' },
    { label: '效率', value: Math.max(0, 100 - state.turns * 2 - state.hintsUsed * 15), note: `${state.turns} 次行动 · ${state.hintsUsed} 次提示` },
  ]
}

function settleText(state: DetectiveState, truth: unknown): string {
  const caseData = truth as DetectiveCase
  const bars = scoreBars(state)
  const murderName = caseData.suspects.find((s) => s.id === caseData.murderer)?.name ?? caseData.murderer
  const verdictLines = state.verdict
    ? state.verdict.claims.map((c) => `- [${c.verdict}] ${c.claim}${c.note !== '' ? `(${c.note})` : ''}`).join('\n')
    : ''
  const auditSection = (state.auditLog ?? []).length > 0
    ? `\n【泄密审计】\n${auditLogText(caseData, state.auditLog)}\n`
    : ''
  return `【侦探推理 · 结算】${caseData.title}
${bars.map((bar) => `- ${bar.label}:${bar.value}(${bar.note})`).join('\n')}

【真相】
凶手:${murderName}
手法:${caseData.solution.means}
动机:${caseData.solution.motive}
作案条件:${caseData.solution.opportunity}

【关键证据链】${caseData.keyClueIds.map((id) => caseData.clues.find((c) => c.id === id)?.description).join(';')}
${verdictLines !== '' ? `\n【推理报告评审】\n${verdictLines}\n评语:${state.verdict?.comment ?? ''}` : ''}${auditSection}`
}

/** 终局结算文本(工具内部使用,与 /game quit 共用)。 */
export const settleDetective = settleText

function scoreText(state: DetectiveState): string {
  const bars = scoreBars(state)
  return `【侦探推理 · 当前进度】已收集 ${state.discoveredClues.length} 条线索 · 行动 ${state.turns} 次 · 提示 ${state.hintsUsed} 次

${bars.map((bar) => `- ${bar.label}:${bar.value}(${bar.note})`).join('\n')}

整理好推理后直接说出结论,或让主持人调用 detective_submit_theory 提交完整推理报告。`
}

// ── 推理报告评审(插件侧 LLM,含完整真相) ──────────────────────────────────────

const VERIFIER_SYSTEM = `你是本格推理游戏的独立评审。你会收到案件完整真相与玩家提交的推理报告。
请把玩家的报告拆解为若干断言,逐条对照真相判定,并给出结论正确性与推理质量评分(0-100,锚定:全对且证据链完整 90-100;方向对但证据链弱 60-80;部分对 40-60;基本错误 <40)。
只输出一个 JSON 对象:
{"murdererCorrect":true|false,"meansCorrect":true|false,"motiveCorrect":true|false,"reasoningScore":<0-100>,"comment":"给玩家的总评语(2-3 句)","claims":[{"claim":"玩家断言原文摘要","verdict":"confirmed"|"supported"|"wrong"|"unsupported","note":"一句理由"}]}`

export async function verifyTheory(
  ctx: Context,
  route: AgentRoute,
  caseData: DetectiveCase,
  report: string,
  signal?: AbortSignal,
): Promise<VerifierResult> {
  const murderName = caseData.suspects.find((s) => s.id === caseData.murderer)?.name
  const clueList = caseData.clues.map((c) => `- [${c.location}] ${c.description}`).join('\n')
  const user = `【案件真相】
凶手:${murderName}
手法:${caseData.solution.means}
动机:${caseData.solution.motive}
作案条件:${caseData.solution.opportunity}
关键证据:${caseData.keyClueIds.map((id) => caseData.clues.find((c) => c.id === id)?.description).join(';')}
全部线索(含所在位置):
${clueList}

【玩家推理报告】
${report}`
  const text = await completeChat(ctx, route, { system: VERIFIER_SYSTEM, user, maxTokens: 1200, signal })
  const parsed = extractJson<VerifierResult>(text)
  return {
    murdererCorrect: parsed.murdererCorrect === true,
    meansCorrect: parsed.meansCorrect === true,
    motiveCorrect: parsed.motiveCorrect === true,
    reasoningScore: typeof parsed.reasoningScore === 'number' ? parsed.reasoningScore : 50,
    comment: typeof parsed.comment === 'string' ? parsed.comment : '',
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
  }
}

/** LLM 抽查审计:台词是否说出该 NPC 知识范围之外的事实(语义级复核)。 */
const AUDIT_SYSTEM = `你是推理游戏的泄密审计员。你会收到一位 NPC 允许知道的事实清单,以及该 NPC 刚刚对玩家说的台词。
判断台词是否说出了清单之外的事实或线索——包括暗示、同义改写、说出凶手/手法/动机相关的新信息。
只输出一个 JSON 对象:{"leak":true|false,"note":"一句理由(无泄漏时可为空)"}`

export async function llmAuditReply(
  ctx: Context,
  route: AgentRoute,
  caseData: DetectiveCase,
  npcId: string,
  reply: string,
  signal?: AbortSignal,
): Promise<{ leak: boolean; note: string }> {
  const suspect = caseData.suspects.find((s) => s.id === npcId)
  if (suspect === undefined) return { leak: false, note: '' }
  const script = caseData.npc[npcId]
  const knowledge = (script?.knowledge ?? []).map((id) => `- ${factText(caseData, id)}`).join('\n')
  try {
    const text = await completeChat(ctx, route, {
      system: AUDIT_SYSTEM,
      user: `【${suspect.name} 允许知道的事实】\n${knowledge || '(无)'}\n\n【${suspect.name} 的台词】\n${reply}`,
      maxTokens: 200,
      signal,
    })
    const parsed = extractJson<{ leak?: boolean; note?: string }>(text)
    return { leak: parsed.leak === true, note: typeof parsed.note === 'string' ? parsed.note : '' }
  } catch {
    return { leak: false, note: '' }
  }
}

export function verdictScore(state: DetectiveState): ScoreBar[] {
  const verdict = state.verdict
  const correctness = verdict
    ? (verdict.murdererCorrect ? 60 : 0) + (verdict.meansCorrect ? 20 : 0) + (verdict.motiveCorrect ? 20 : 0)
    : 0
  return [
    {
      label: '结论正确性',
      value: correctness,
      note: verdict
        ? `凶手${verdict.murdererCorrect ? '✓' : '✗'} · 手法${verdict.meansCorrect ? '✓' : '✗'} · 动机${verdict.motiveCorrect ? '✓' : '✗'}`
        : '未提交推理报告',
    },
    {
      label: '推理质量',
      value: verdict?.reasoningScore ?? 0,
      note: verdict ? '独立评审按断言逐条评分' : '',
    },
    { label: '效率', value: Math.max(0, 100 - state.turns * 2 - state.hintsUsed * 15), note: `${state.turns} 次行动 · ${state.hintsUsed} 次提示` },
  ]
}

/** 审计日志渲染(卷宗与结算共用)。 */
export function auditLogText(caseData: DetectiveCase, auditLog: AuditEntry[] | undefined): string {
  const entries = auditLog ?? []
  if (entries.length === 0) return '无:全部 NPC 发言均在角色边界内。'
  const lines = entries.map((entry) => {
    const npc = caseData.suspects.find((s) => s.id === entry.npcId)
    const facts = entry.factIds.length > 0 ? entry.factIds.map((id) => factText(caseData, id)).join(';') : '(未定位具体事实,由 LLM 抽查审计判定)'
    const kind = entry.kind === 'leak' ? '越界泄密' : '说漏嘴'
    return `- [${kind}] ${npc?.name ?? entry.npcId} 的发言疑似提及「${facts}」——该发言已作废,不视为有效证词。`
  })
  return lines.join('\n')
}

/** /casefile 卷宗文本(线索来自真相案卷,与生成案件同样适用)。 */
export function casefileText(state: DetectiveState, caseData: DetectiveCase): string {
  const lines = state.discoveredClues.map((id) => {
    const clue = caseData.clues.find((c) => c.id === id)
    return clue ? `- [${clue.location}] ${clue.description}` : `- ${id}`
  })
  const audit = auditLogText(caseData, state.auditLog)
  return `【卷宗】已收集 ${state.discoveredClues.length}/${caseData.clues.length} 条线索\n${lines.join('\n') || '(暂无,去勘查现场吧)'}\n\n【证词审计】${audit}`
}

// ── 引擎入口 ────────────────────────────────────────────────────────────────

export const detectiveEngine: SchemeEngine = {
  id: 'detective',
  label: '侦探推理',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const caseData = pickCase(difficulty, hashString(sessionId) + difficulty)
    const now = Date.now()
    const state: DetectiveState = {
      scheme: 'detective',
      difficulty: caseData.difficulty,
      startedAt: now,
      updatedAt: now,
      phase: 'playing' as GamePhase,
      turns: 0,
      hintsUsed: 0,
      score: null,
      caseId: caseData.caseId,
      discoveredClues: [],
      conversations: {},
      evidenceShown: {},
      accusedId: null,
      theoryText: null,
      verdict: null,
      auditLog: [],
    }
    return { state, truth: caseData, brief: buildBrief(caseData, state) }
  },
  resumeBrief(state) {
    return resumeBrief(state as DetectiveState)
  },
  scoreText(state) {
    return scoreText(state as DetectiveState)
  },
  settleText(state, truth) {
    return settleText(state as DetectiveState, truth)
  },
  hint(state, truth) {
    const caseData = truth as DetectiveCase
    const idx = Math.min((state as DetectiveState).hintsUsed, caseData.hints.length - 1)
    return { text: `【提示 ${idx + 1}/${caseData.hints.length}】${caseData.hints[idx]}` }
  },
}
