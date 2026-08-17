/**
 * 方案三·暴风雪山庄(剧本杀,路线图阶段 4)。
 *
 * v1 落地范围(与 docs/03-social-deduction.md 的取舍):
 *   - 剧本真相复用方案一的 DetectiveCase 结构(事实/证据/NPC 角色页/求解器注解),
 *     因此 solver.ts 可解性门禁与 audit.ts 泄密审计零改动直接复用;
 *   - 玩家固定饰演侦探;5 名 AI 角色(凶手在其中)由插件侧 LLM 无状态扮演,
 *     continuable subagent 化与 workflow 编排是共享的下一里程碑;
 *   - 公聊以插件侧 Promise.all fan-out 收集 5 名 NPC 反应(每人一句,防霸麦);
 *   - 结算用双栏(推理正确性 + 扮演质量)+ 效率辅助栏;扮演质量由独立 rubric 评审。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { completeChat, extractJson, type ChatTurn } from '../core/llm.js'
import { talkAsNpc } from '../core/npc.js'
import { auditReply, sanitizedLine, type AuditEntry } from '../core/audit.js'
import { buildNpcSystem, factText, scriptedCollapse, type DetectiveCase } from './detective.js'
import { generateCase } from './casegen.js'
import { hashString } from '../core/rand.js'
import { solveCase } from './solver.js'
import type { SchemeEngine } from '../core/manager.js'

export interface PartyLine {
  role: 'user' | 'npc'
  speaker: string
  text: string
  at: number
}

export interface PartyState extends GameStateBase {
  scheme: 'party'
  caseId: string
  discoveredClues: string[]
  conversations: Record<string, ChatTurn[]>
  evidenceShown: Record<string, string[]>
  accusedId: string | null
  /** 公聊流水(含玩家发言与 NPC 反应,供扮演质量评审)。 */
  discussion: PartyLine[]
  /** 泄密审计日志(与侦探推理同源)。 */
  auditLog?: AuditEntry[]
  /** 结算时的扮演质量分。 */
  roleplayScore: number | null
  roleplayComment: string | null
  /** 模式:standard(玩家=侦探)/ reversal(玩家=凶手,难度 3)。 */
  mode: 'standard' | 'reversal'
  /** 反转模式:侦探团嫌疑度 0-100(引擎唯一真相,GM 不得口胡)。 */
  suspicion: number
  /** 反转模式:已完成的质询轮数。 */
  reversalRound: number
  /** 反转模式:玩家陈述与引擎评估留档。 */
  reversalLog: { round: number; statement: string; note: string; suspicion: number }[]
  /** 反转模式:是否已终局裁决。 */
  verdictDone: boolean
}

// ── 手工剧本:风雪夜归人 ────────────────────────────────────────────────────────

export const SNOW_NIGHT: DetectiveCase = {
  caseId: 'snow-night',
  title: '风雪夜归人',
  difficulty: 2,
  setting: '除夕夜,暴雪封山,顾家老宅。',
  opening:
    '顾老爷被发现死在书房:身上有钝器伤,死前疑似被下药。暴雪封山,全员困在宅中,凶手就在席间。你是受邀而来的侦探,在场五名相关人士:少爷顾云舟、女仆梅姨、家庭医生白修远、远亲楚若兰、休假中的刑警韩正。',
  victim: { name: '顾鸿章', role: '顾家老爷', death: '书房内被下镇定剂后遭钝器补击,约 20:12-20:18 之间' },
  locations: ['书房', '餐厅', '卧室', '客房', '厨房', '花园', '走廊', '客厅'],
  suspects: [
    { id: 's_heir', name: '顾云舟', role: '少爷(继承人)', bio: '顾老爷的独子,表面温文尔雅;最近与父亲多次争吵,据说手头拮据。' },
    { id: 's_maid', name: '梅姨', role: '女仆', bio: '在顾家服侍三十年的女仆,卑微恭顺,今晚负责上菜与酒水。' },
    { id: 's_doctor', name: '白修远', role: '家庭医生', bio: '顾家的家庭医生,今晚留宿;与老爷似乎有旧日的医患纠葛。' },
    { id: 's_writer', name: '楚若兰', role: '远亲(作家)', bio: '远房表亲,为分家产而来,说话尖刻带刺。' },
    { id: 's_detective', name: '韩正', role: '刑警(休假中)', bio: '休假中的刑警,与顾老爷是旧识,此行目的讳莫如深。' },
  ],
  murderer: 's_heir',
  solution: {
    means: '在晚餐酒中掺入镇定剂,借 20:12 停电进入书房,用壁炉火钳补一记致死',
    motive: '欠下巨额赌债,急需遗产;老爷发现后已改写遗嘱,欲与其断绝关系',
    opportunity: '20:12 全屋停电的间隙,经走廊进入书房作案',
  },
  facts: [
    { id: 'f_dinner', type: 'timeline', text: '19:00 六人入席晚餐,全员证词覆盖。' },
    { id: 'f_leave', type: 'timeline', text: '20:05 顾老爷咳呛离席(被下药的初期反应)。' },
    { id: 'f_blackout', type: 'timeline', text: '20:12 全屋停电,约 20:18 来电。' },
    { id: 'f_death', type: 'timeline', text: '20:18 来电后,顾老爷被发现死于书房(药 + 钝器)。' },
    { id: 'f_poker', type: 'physical', text: '凶器是书房的壁炉火钳。', auditKeywords: ['火钳', '凶器'] },
    { id: 'f_glass', type: 'physical', text: '书房的醒酒器被打碎在地,说明书房里有第二现场(搏斗/补击)。' },
    { id: 'f_drug', type: 'physical', text: '死者的酒杯里被掺入了镇定剂。', auditKeywords: ['下药', '镇定剂', '掺了药'] },
    { id: 'f_will', type: 'motive', text: '顾老爷上周改写了遗嘱,把少爷的继承份额整段划去。' },
    { id: 'f_debt', type: 'motive', text: '顾云舟欠下巨额赌债,债主已上门催过两次。', auditKeywords: ['赌债', '借据', '催债'] },
    { id: 'f_cig', type: 'physical', text: '花园雪地上只有一个烟蒂,周围没有来回踱步的脚印——像是隔窗扔出来的。' },
    { id: 'f_shadow', type: 'testimony', text: '停电时,门房看见一个穿着少爷斗篷的身影走进书房。', auditKeywords: ['斗篷', '进了书房', '进过书房'] },
    { id: 'f_maid_alibi', type: 'timeline', text: '梅姨 20:05-20:20 一直在厨房与厨娘备菜。', excludes: ['s_maid'] },
    { id: 'f_maid_seen', type: 'testimony', text: '梅姨在停电时看见少爷进了书房,但不敢说。' },
    { id: 'f_doctor_alibi', type: 'timeline', text: '白修远 20:10-20:30 一直在客房点着蜡烛配药,厨娘送热水时看到。', excludes: ['s_doctor'] },
    { id: 'f_doctor_case', type: 'motive', text: '白修远与顾老爷之间有一桩旧医疗事故的纠葛。' },
    { id: 'f_pair_alibi', type: 'timeline', text: '楚若兰与韩正 20:12-20:18 一直在餐厅,互相作证。', excludes: ['s_writer', 's_detective'] },
    { id: 'f_writer_eavesdrop', type: 'testimony', text: '楚若兰 20:00 在顾老爷房门外偷听到了"遗嘱要改"。' },
    { id: 'f_detective_case', type: 'motive', text: '韩正此行是为调查一桩顾老爷牵涉的旧案,与老爷有旧怨。' },
  ],
  clues: [
    { id: 'e_poker', location: '书房', description: '壁炉旁的火钳沾着血迹与玻璃碴,壁炉里的火已经熄了。', reveals: ['f_poker'] },
    { id: 'e_decanter', location: '书房', description: '醒酒器摔碎在地,酒液里混着玻璃碴;书桌上有几滴溅出的酒。', reveals: ['f_glass'] },
    { id: 'e_wine', location: '餐厅', description: '死者的酒杯里残留着镇定剂的白色粉末,酒味发苦。', reveals: ['f_drug'] },
    { id: 'e_will', location: '卧室', description: '保险柜里放着上周新立的遗嘱副本,顾云舟的继承份额被整段划去。', reveals: ['f_will'] },
    { id: 'e_debt', location: '卧室', description: '少爷房间的床底有一叠借据与债主的催债信,数目惊人。', reveals: ['f_debt'] },
    { id: 'e_clock', location: '走廊', description: '走廊的座钟停在 20:12——停电的那一刻,有人拨过保险丝盒。', reveals: ['f_blackout'] },
    { id: 'e_candle', location: '客房', description: '白医生房里的蜡烛快燃尽了,药箱摊开,桌上有一杯还温着的茶。', reveals: ['f_doctor_alibi'] },
    { id: 'e_kitchen', location: '厨房', description: '厨娘作证:梅姨 20:05 到 20:20 一直在厨房和她一起备菜,只离开过一次送醒酒器。', reveals: ['f_maid_alibi'] },
    { id: 'e_cig', location: '花园', description: '雪地上孤零零一个烟蒂,周围没有脚印——少爷说他在花园抽烟,可雪地上没有来回踱步的痕迹。', reveals: ['f_cig'] },
    { id: 'e_dining', location: '餐厅', description: '韩正与楚若兰都声称停电时在餐厅,两人的证词细节对得上。', reveals: ['f_pair_alibi'] },
    { id: 'e_shadow', location: '走廊', description: '门房作证:停电时,他借着雪光看见一个身影进了书房,披着少爷的斗篷。', reveals: ['f_shadow'] },
    { id: 'e_medical', location: '客房', description: '药箱里有一瓶开了封的镇定剂,处方是白医生开的——但剂量少了些。', reveals: [], redHerring: '镇定剂是少爷从药箱偷的,不是白医生下的', misleadsTo: ['s_doctor'] },
    { id: 'e_casefile', location: '客厅', description: '韩正的行李里有一份旧案卷宗,卷宗上顾老爷的名字被红笔圈过。', reveals: [], redHerring: '韩正为旧案而来,但案发时他在餐厅', misleadsTo: ['s_detective'] },
    { id: 'e_letter', location: '客厅', description: '楚若兰的手袋里有一封写给律师的信,谈的都是分家产的事。', reveals: [], redHerring: '楚若兰为钱而来,但案发时她在餐厅', misleadsTo: ['s_writer'] },
  ],
  keyClueIds: ['e_debt', 'e_poker'],
  solutionFactIds: ['f_debt', 'f_poker'],
  npc: {
    s_heir: {
      persona: '表面温文尔雅,内心焦躁;被戳穿时恼羞成怒,语速加快。',
      knowledge: ['f_debt', 'f_drug', 'f_shadow', 'f_poker', 'f_dinner', 'f_leave', 'f_blackout', 'f_death', 'f_cig'],
      mustNotAdmit: ['f_debt', 'f_drug', 'f_shadow', 'f_poker'],
      liePolicy: '声称 20:12 停电时在花园抽烟;赌债绝口不提;被问书房时闪烁其词;被门房证词/烟蒂证据戳穿后改口"只到过书房门口,听见没动静就走了"。',
      guilt: '你杀了父亲:在酒里掺了镇定剂,20:12 停电时进书房,用壁炉火钳补了一记。你偷了白医生的镇定剂,烟蒂是从窗户扔到花园的。你必须伪装无辜,把嫌疑推给白医生或韩正。',
      collapse: '当玩家向你出示「沾血的火钳」与「遗嘱副本/借据」两件铁证后,你崩溃并部分认罪:承认自己欠下赌债、下药并用火钳补击,但辩称"是父亲先要毁了我"。',
    },
    s_maid: {
      persona: '卑微恭顺,欲言又止;被逼问时手会发抖,眼神躲闪。',
      knowledge: ['f_maid_seen', 'f_maid_alibi', 'f_dinner', 'f_blackout', 'f_will'],
      mustNotAdmit: ['f_maid_seen'],
      liePolicy: '对"停电时看见谁"支支吾吾,先说"我在厨房";被厨娘证词对不上的细节戳穿后,改口"只瞥见一个影子,没看清是谁"。',
    },
    s_doctor: {
      persona: '冷静克制,满口医学术语;被问及旧事时明显不自在。',
      knowledge: ['f_drug', 'f_doctor_case', 'f_doctor_alibi', 'f_death', 'f_dinner'],
      mustNotAdmit: ['f_doctor_case'],
      liePolicy: '对医疗纠葛绝口不提,只谈化验与尸检;不编造化验结果。',
    },
    s_writer: {
      persona: '尖刻带刺,喜欢反问;被抓住把柄时声音会突然拔高。',
      knowledge: ['f_writer_eavesdrop', 'f_pair_alibi', 'f_dinner', 'f_will'],
      mustNotAdmit: ['f_writer_eavesdrop'],
      liePolicy: '对分家产的意图半遮半掩;偷听遗嘱的事矢口否认,被戳穿后改口"路过,无意听见的"。',
    },
    s_detective: {
      persona: '老刑警做派,慢条斯理,说话总带"证据"二字。',
      knowledge: ['f_detective_case', 'f_pair_alibi', 'f_dinner', 'f_poker', 'f_glass', 'f_blackout'],
      mustNotAdmit: ['f_detective_case'],
      liePolicy: '对旧案卷宗讳莫如深,只说"私事";对现场痕迹的陈述基本如实。',
    },
  },
  hints: [
    '把 20:05 离席、20:12 停电、20:18 发现尸体三个时间点,对到每个人的证词上。',
    '花园里的烟蒂,不一定代表有人在那里站过。',
    '查一查谁最着急用钱:老爷最近改过什么?谁欠了谁的?',
  ],
}

const SCRIPTS: DetectiveCase[] = [SNOW_NIGHT]

/** 每难度的程序化剧本池(生成后过求解器门禁,与侦探推理同源)。 */
const GENERATED_POOL = new Map<number, DetectiveCase[]>()

function partyPool(difficulty: number): DetectiveCase[] {
  const cached = GENERATED_POOL.get(difficulty)
  if (cached) return cached
  const pool: DetectiveCase[] = []
  let seed = difficulty * 100003 + 900000
  let attempts = 0
  while (pool.length < 4 && attempts < 24) {
    attempts += 1
    try {
      const caseData = generateCase(seed, difficulty)
      if (solveCase(caseData).ok) pool.push(caseData)
    } catch {
      // 换种子重试
    }
    seed += 1
  }
  if (pool.length === 0) {
    throw new Error('dsh-xgame:剧本生成器未能产出可解剧本')
  }
  GENERATED_POOL.set(difficulty, pool)
  return pool
}

/** 选本:难度 3 固定招牌剧本(反转模式);1/2 = 招牌 + 通过门禁的程序化剧本。 */
export function pickScript(difficulty: number, seed: number): DetectiveCase {
  if (difficulty === 3) return SNOW_NIGHT
  const manual = difficulty === 2 ? [SNOW_NIGHT] : []
  const pool = [...manual, ...partyPool(difficulty)]
  return pool[Math.abs(seed) % pool.length]
}

/** 反转模式配置(烧脑难度:玩家=凶手)。 */
const REVERSAL = {
  /** 侦探团每轮搜到的新证据(顺序)。 */
  clueOrder: ['e_wine', 'e_poker', 'e_debt', 'e_will'],
  /** 凶手公开说辞的关键词(与剧本 liePolicy 一致)。 */
  alibiKeywords: ['花园', '抽烟', '烟蒂'],
  /** 每轮质询数(之后可终局裁决)。 */
  rounds: 5,
  /** 每轮新证据带来的嫌疑度。 */
  clueSuspicion: 10,
  /** 陈述与证据矛盾的嫌疑度(已搜到该证据后自曝)。 */
  contradictionSuspicion: 20,
  /** 陈述自曝未搜到的秘密的嫌疑度(更可疑)。 */
  leakSuspicion: 25,
  /** 陈述坚守公开说辞且未自曝时的洗清幅度。 */
  alibiCleanse: 8,
  /** 终局裁决阈值:嫌疑度 ≥ 此值被识破。 */
  catchThreshold: 60,
}

// ── 文案 ──────────────────────────────────────────────────────────────────────

function buildBrief(caseData: DetectiveCase, state: PartyState): string {
  const roster = caseData.suspects.map((s) => `- ${s.name}(${s.role}):${s.bio}`).join('\n')
  return `【游戏开始:剧本杀 · ${caseData.title}】(难度 ${caseData.difficulty}/3)

现在你是本局的导演兼主持人。玩家饰演侦探,与 5 名相关人士同困暴雪山庄。剧本真相只存在于游戏引擎中,你的上下文里【没有】凶手与真相。请遵守以下铁律:

1. 场景与证据【只能通过工具获得】:玩家要求搜证时,调用 \`party_search\`(参数 scene 为场景名);引擎返回什么,你才能叙述什么。严禁自行编造线索、证词或现场细节。
2. 对质【必须通过工具】:玩家与某个角色单独谈话时,调用 \`party_talk\`(npc + text),把玩家的话原文传给引擎,引擎返回该角色的回应,你再转述(可加神态描写,不得改动内容)。
3. 公聊用 \`party_discuss\`:玩家公开发言或抛出线索时,把发言原文传入,引擎会收集全体角色的反应;你按返回顺序呈现,不要替任何角色加戏。
4. 出示证据用 \`party_show\`;终局指控用 \`party_accuse\`(不可撤销,立即结算)。
5. 不要暗示或泄露你"不知道"的真相;你只负责主持节奏、渲染氛围、整理玩家已获得的证据。
6. 玩家可以用 /roles 看角色名册、/timeline 看已确证时间线、/game score 查进度、/hint 买提示、/game quit 结束看真相。

【案情简报】
${caseData.setting}
${caseData.opening}

【相关人士】
${roster}

【可搜证场景】${caseData.locations.join('、')}

用两三句导演口吻的开场白宣布命案发生,并等待玩家第一个指令。`
}

function resumeBrief(caseData: DetectiveCase, state: PartyState): string {
  return `【继续游戏:剧本杀 · ${caseData.title}】你仍是导演,真相仍在引擎中。已搜到 ${state.discoveredClues.length} 条证据,公聊 ${state.discussion.length} 条。请提醒玩家继续;玩家动作一律通过 party_search / party_talk / party_discuss / party_show / party_accuse 工具执行。`
}

export function partyScoreBars(caseData: DetectiveCase, state: PartyState): ScoreBar[] {
  const accused = caseData.suspects.find((s) => s.id === state.accusedId)
  return [
    {
      label: '推理正确性',
      value: state.phase === 'solved' ? 100 : 0,
      note: state.phase === 'solved' ? `指控「${accused?.name ?? ''}」正确` : state.accusedId !== null ? `指控「${accused?.name ?? ''}」错误` : '尚未指控',
    },
    {
      label: '扮演质量',
      value: state.roleplayScore ?? 0,
      note: state.roleplayScore !== null ? (state.roleplayComment ?? '独立评审按扮演 rubric 评分') : '指控时由独立评审评分',
    },
    {
      label: '效率',
      value: Math.max(0, 100 - state.turns * 2 - state.hintsUsed * 15),
      note: `${state.turns} 次行动 · ${state.hintsUsed} 次提示`,
    },
  ]
}

function scoreText(caseData: DetectiveCase, state: PartyState): string {
  return `【剧本杀 · 当前进度】已搜到 ${state.discoveredClues.length} 条证据 · 行动 ${state.turns} 次 · 提示 ${state.hintsUsed} 次

${partyScoreBars(caseData, state).map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

锁定凶手后,让主持人调用 party_accuse 发起终局指控。`
}

export function partySettleText(caseData: DetectiveCase, state: PartyState): string {
  const murderName = caseData.suspects.find((s) => s.id === caseData.murderer)?.name ?? caseData.murderer
  const auditSection = (state.auditLog ?? []).length > 0
    ? `\n【泄密审计】${state.auditLog?.map((e) => `${caseData.suspects.find((s) => s.id === e.npcId)?.name ?? e.npcId} 的发言越界已作废`).join(';')}\n`
    : ''
  return `【剧本杀 · 结算】${caseData.title}
${partyScoreBars(caseData, state).map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

【真相】
凶手:${murderName}
手法:${caseData.solution.means}
动机:${caseData.solution.motive}
作案条件:${caseData.solution.opportunity}

【关键证据链】${caseData.keyClueIds.map((id) => caseData.clues.find((c) => c.id === id)?.description).join(';')}${auditSection}`
}

// ── 面板(/roles /timeline) ────────────────────────────────────────────────────

export type PartyPanel = 'roles' | 'timeline' | 'role'

export function panelText(caseData: DetectiveCase, state: PartyState, panel: PartyPanel): string {
  switch (panel) {
    case 'role': {
      if (state.mode !== 'reversal') {
        return '【你的角色】本局你是侦探,凶手藏在五名相关人士之中。真相只存在于游戏引擎。'
      }
      const murderer = caseData.npc[caseData.murderer]
      const murderName = caseData.suspects.find((sp) => sp.id === caseData.murderer)?.name ?? '你'
      return `【你的秘密角色卡——仅你可见,主持人看不到这页】
你就是凶手!你饰演「${murderName}」。

【你做了什么】${murderer.guilt ?? caseData.solution.means + '。' + caseData.solution.motive + '。'}

【你的公开说辞】${murderer.liePolicy}

【被铁证砸脸时的反应(是否认罪由你自定)】${murderer.collapse ?? '(无)'}

【玩法】侦探团会轮流质问你:坚守公开说辞可洗清嫌疑;一旦说漏嘴、或与已搜到的证据矛盾,嫌疑度会大涨。${REVERSAL.rounds} 轮质询后终局裁决:嫌疑度 < ${REVERSAL.catchThreshold} 即可全身而退。`
    }
    case 'roles': {
      const lines = caseData.suspects.map((s) => `- ${s.name}(${s.role}):${s.bio}`)
      return `【角色名册】${caseData.title}\n${lines.join('\n')}`
    }
    case 'timeline': {
      const revealed = new Set<string>()
      for (const clueId of state.discoveredClues) {
        const clue = caseData.clues.find((c) => c.id === clueId)
        if (clue !== undefined) for (const f of clue.reveals) revealed.add(f)
      }
      const lines = caseData.facts
        .filter((f) => f.type === 'timeline' && revealed.has(f.id))
        .map((f) => `- ${factText(caseData, f.id)}`)
      return `【已确证时间线】\n${lines.length > 0 ? lines.join('\n') : '(暂无——去搜证吧;时间线只显示已被证据证实的事实)'}`
    }
  }
}

// ── 公聊 fan-out ──────────────────────────────────────────────────────────────

export interface DiscussLine {
  npcId: string
  name: string
  text: string
  flagged: boolean
}

/**
 * 公聊:并发收集 5 名 NPC 对玩家发言的反应(每人一句)。
 * 每句台词过泄密审计,越界即作废;结果按名册顺序返回。
 */
export async function discuss(
  ctx: Context,
  sessionId: string,
  route: AgentRoute,
  caseData: DetectiveCase,
  state: PartyState,
  statement: string,
  signal?: AbortSignal,
): Promise<{ lines: DiscussLine[] }> {
  const recent = state.discussion.slice(-6).map((l) => `${l.speaker}:${l.text}`).join('\n')
  const context = `【公聊现场】最近发言:\n${recent || '(暂无)'}\n\n【玩家刚刚公开发言】${statement}\n\n请以你的角色身份,对这一发言或当前局面做出反应(一句话,可带神态),不要跳出角色。`
  const results = await Promise.all(
    caseData.suspects.map(async (suspect) => {
      let text: string
      try {
        const out = await talkAsNpc(ctx, {
          sessionId,
          route,
          label: `npc:party:${suspect.id}`,
          system: buildNpcSystem(caseData, suspect.id),
          user: context,
          history: (state.conversations[suspect.id] ?? []).slice(-6),
          maxTokens: 300,
          signal,
        })
        text = out.text
      } catch {
        text = `${suspect.name}沉默着,没有接话。`
      }
      const verdict = auditReply(caseData, suspect.id, text)
      if (verdict.flagged) {
        state.auditLog = [
          ...(state.auditLog ?? []),
          { npcId: suspect.id, at: Date.now(), kind: verdict.slipped.length > 0 ? 'slip' : 'leak', factIds: [...verdict.outOfScope, ...verdict.slipped], snippet: text },
        ]
        text = sanitizedLine(suspect.name)
        return { npcId: suspect.id, name: suspect.name, text, flagged: true }
      }
      return { npcId: suspect.id, name: suspect.name, text, flagged: false }
    }),
  )
  return { lines: results }
}

// ── 扮演质量评审(独立 rubric,LLM 兜底) ────────────────────────────────────────

const ROLEPLAY_SYSTEM = `你是剧本杀的独立评审。你会收到玩家在公聊/私聊中的全部发言。
请按扮演 rubric 评分(0-100,锚定:入戏自洽、紧扣角色身份、无元游戏话术 80-100;基本入戏偶有出戏 60-80;频繁元游戏/与角色身份脱节 <60)。
只输出一个 JSON 对象:{"score":<0-100>,"comment":"给玩家的一句评语"}`

export async function verifyRoleplay(
  ctx: Context,
  route: AgentRoute,
  discussion: PartyLine[],
  signal?: AbortSignal,
): Promise<{ score: number; comment: string }> {
  const playerLines = discussion.filter((l) => l.role === 'user').map((l) => `- ${l.text}`).join('\n')
  if (playerLines.trim() === '') return { score: 60, comment: '玩家未在讨论中发言。' }
  try {
    const text = await completeChat(ctx, route, {
      system: ROLEPLAY_SYSTEM,
      user: `【玩家在讨论中的全部发言】\n${playerLines}`,
      maxTokens: 300,
      signal,
    })
    const parsed = extractJson<{ score?: number; comment?: string }>(text)
    return {
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 60,
      comment: typeof parsed.comment === 'string' ? parsed.comment : '',
    }
  } catch {
    return { score: 60, comment: '' }
  }
}

// ── 引擎入口 ──────────────────────────────────────────────────────────────────

export const partyEngine: SchemeEngine = {
  id: 'party',
  label: '剧本杀',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const caseData = pickScript(difficulty, hashString(sessionId) + difficulty)
    const reversal = difficulty === 3
    const now = Date.now()
    const state: PartyState = {
      scheme: 'party',
      difficulty: reversal ? 3 : caseData.difficulty,
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
      discussion: [],
      auditLog: [],
      roleplayScore: null,
      roleplayComment: null,
      mode: reversal ? 'reversal' : 'standard',
      suspicion: 0,
      reversalRound: 0,
      reversalLog: [],
      verdictDone: false,
    }
    void sessionId
    return { state, truth: caseData, brief: reversal ? buildReversalBrief(caseData, state) : buildBrief(caseData, state) }
  },
  resumeBrief(state, truth) {
    const partyState = state as PartyState
    const caseData = (truth as DetectiveCase | undefined) ?? SNOW_NIGHT
    return resumeBrief(caseData, partyState)
  },
  scoreText(state, truth) {
    const partyState = state as PartyState
    const caseData = (truth as DetectiveCase | undefined) ?? SNOW_NIGHT
    return scoreText(caseData, partyState)
  },
  settleText(state, truth) {
    return partySettleText(truth as DetectiveCase, state as PartyState)
  },
  hint(state, truth) {
    const caseData = truth as DetectiveCase
    const idx = Math.min((state as PartyState).hintsUsed, caseData.hints.length - 1)
    return { text: `【提示 ${idx + 1}/${caseData.hints.length}】${caseData.hints[idx]}` }
  },
}

// ── 反转模式(难度 3:玩家 = 凶手,侦探团围猎) ──────────────────────────────

function buildReversalBrief(caseData: DetectiveCase, state: PartyState): string {
  const roster = caseData.suspects.map((sp) => `- ${sp.name}(${sp.role}):${sp.bio}`).join('\n')
  return `【游戏开始:剧本杀 · ${caseData.title} · 反转模式】(难度 3/3)

现在你是本局的导演兼主持人。本局是反转模式:【玩家饰演凶手】,其余四名相关人士组成侦探团,由韩正牵头围猎玩家。请遵守以下铁律:

1. 你【不知道玩家的作案细节与证据真相】。剧本真相只存在于游戏引擎中;玩家有一份只有他自己能看的秘密角色卡(/role 命令展示,你绝不能查看或猜测)。
2. 每轮质询的流程必须经工具:
   - \`party_discuss\`:侦探团公开讨论并质问玩家,引擎收集各角色的发言;
   - \`party_talk\`:某位侦探团成员单独质问玩家,把他的话原文传入;
   - \`party_defend\`:玩家提交陈述/辩解,引擎对照证据裁决嫌疑度升降,并在每轮末揭示侦探团新搜到的证据;
   - \`party_verdict\`:${REVERSAL.rounds} 轮质询结束后终局裁决(嫌疑度 ≥ ${REVERSAL.catchThreshold} 即被识破),不可提前。
3. 嫌疑度只有引擎能改:你不得口胡"他看起来很可疑",只能转述引擎的嫌疑度数字与裁决理由。
4. 玩家可以 /role 看自己的秘密角色卡、/game score 查进度、/game quit 结束看真相。

【案情简报】
${caseData.setting}
${caseData.opening}

【相关人士】(玩家饰演其中一人,其余为侦探团)
${roster}

用两三句导演口吻宣布:命案发生,侦探团开始围猎——第一轮质询开始,请侦探团先发言。`
}

export interface DefendResult {
  text: string
}

/** 玩家陈述评估:对照证据与秘密裁决嫌疑度(引擎唯一真相)。 */
export function reversalDefend(script: DetectiveCase, state: PartyState, statement: string): DefendResult {
  if (state.verdictDone) {
    return { text: '终局裁决已经完成。' }
  }
  if (state.reversalRound >= REVERSAL.rounds) {
    return { text: `质询已经结束(${state.reversalRound}/${REVERSAL.rounds} 轮)。让主持人调用 party_verdict 终局裁决。` }
  }
  const murderer = script.npc[script.murderer]
  const mustNotAdmit = new Set(murderer.mustNotAdmit ?? [])
  const audit = auditReply(
    { facts: script.facts, npc: { __player: { knowledge: [], mustNotAdmit: [...mustNotAdmit] } } },
    '__player',
    statement,
  )
  // 关键词层:凶手提及凶器/下药/赌债等词,哪怕一笔带过,也是破绽
  const norm = statement.toLowerCase().replace(/\s+/g, '')
  for (const fact of script.facts) {
    if (!mustNotAdmit.has(fact.id)) continue
    const kws = fact.auditKeywords ?? []
    if (kws.length > 0 && kws.some((k) => norm.includes(k)) && !audit.slipped.includes(fact.id)) {
      audit.slipped.push(fact.id)
      audit.flagged = true
    }
  }
  const revealedFacts = new Set<string>()
  for (const clueId of state.discoveredClues) {
    const clue = script.clues.find((c) => c.id === clueId)
    for (const f of clue?.reveals ?? []) revealedFacts.add(f)
  }
  const notes: string[] = []
  let delta = 0
  for (const factId of audit.slipped) {
    if (revealedFacts.has(factId)) {
      delta += REVERSAL.contradictionSuspicion
      notes.push(`你的说法与侦探团已搜到的证据矛盾(「${factText(script, factId)}」)——嫌疑大增!`)
    } else {
      delta += REVERSAL.leakSuspicion
      notes.push(`你自曝了尚未被搜到的秘密(「${factText(script, factId)}」)——口风不紧,嫌疑大增!`)
    }
  }
  if (audit.slipped.length === 0 && REVERSAL.alibiKeywords.some((k) => norm.includes(k))) {
    delta -= REVERSAL.alibiCleanse
    notes.push('你坚守公开说辞,侦探团没抓到把柄——嫌疑略降。')
  }
  state.suspicion = Math.min(100, Math.max(0, state.suspicion + delta))
  state.reversalRound += 1
  state.reversalLog.push({ round: state.reversalRound, statement, note: notes.join(';') || '陈述中性,侦探团没有明显反应。', suspicion: state.suspicion })
  state.discussion = [...state.discussion, { role: 'user', speaker: '你(凶手)', text: statement, at: Date.now() }]
  state.turns += 1
  const lines = [notes.length > 0 ? notes.join('\n') : '(侦探团交换着眼色,没有明显反应)', `【引擎裁决】嫌疑度 ${delta >= 0 ? '+' : ''}${delta} → ${state.suspicion}/100`]
  if (state.reversalRound <= REVERSAL.clueOrder.length) {
    const clueId = REVERSAL.clueOrder[state.reversalRound - 1]
    const clue = script.clues.find((c) => c.id === clueId)
    if (clue !== undefined && !state.discoveredClues.includes(clueId)) {
      state.discoveredClues.push(clueId)
      state.suspicion = Math.min(100, state.suspicion + REVERSAL.clueSuspicion)
      lines.push(`【侦探团搜证】韩正从「${clue.location}」带回新证据:「${clue.description}」(嫌疑度 +${REVERSAL.clueSuspicion} → ${state.suspicion}/100)`)
    }
  }
  if (state.reversalRound >= REVERSAL.rounds) {
    lines.push('质询轮次已尽。侦探团交换眼神——是时候终局裁决了。让主持人调用 party_verdict。')
  }
  return { text: lines.join('\n') }
}

/** 终局裁决:嫌疑度 ≥ 阈值 → 被识破;否则全身而退。 */
export function reversalVerdict(script: DetectiveCase, state: PartyState, roleplay: { score: number; comment: string }): { caught: boolean; text: string } {
  if (state.verdictDone) {
    return { caught: state.phase === 'given_up', text: '终局裁决已经完成。' }
  }
  if (state.reversalRound < REVERSAL.rounds) {
    return { caught: false, text: `质询还没结束(第 ${state.reversalRound}/${REVERSAL.rounds} 轮),侦探团还在调查。` }
  }
  state.verdictDone = true
  state.roleplayScore = roleplay.score
  state.roleplayComment = roleplay.comment
  const caught = state.suspicion >= REVERSAL.catchThreshold
  state.phase = caught ? 'given_up' : 'solved'
  const murderName = script.suspects.find((sp) => sp.id === script.murderer)?.name ?? '你'
  const bars = [
    { label: '逃脱结局', value: caught ? 0 : 100, note: caught ? `被识破(嫌疑度 ${state.suspicion}/100)` : `全身而退(嫌疑度 ${state.suspicion}/100)` },
    { label: '扮演质量', value: roleplay.score, note: roleplay.comment || '独立评审按扮演 rubric 评分' },
    { label: '效率', value: Math.max(0, 100 - state.turns * 2 - state.hintsUsed * 15), note: `${state.turns} 次行动 · ${state.hintsUsed} 次提示` },
  ]
  const text = `【剧本杀 · 反转模式 · 结算】${script.title}
${bars.map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

【真相】凶手就是你自己——「${murderName}」。
手法:${script.solution.means}
动机:${script.solution.motive}
作案条件:${script.solution.opportunity}

【质询复盘】
${state.reversalLog.map((l) => `- 第${l.round}轮:${l.note}(嫌疑度 ${l.suspicion})`).join('\n')}`
  return { caught, text }
}

/** 工具层入口:结算(指控)组装。 */
export function settleParty(caseData: DetectiveCase, state: PartyState, roleplay: { score: number; comment: string }): void {
  state.roleplayScore = roleplay.score
  state.roleplayComment = roleplay.comment
}
