/**
 * 方案六·海龟汤(冒烟测试游戏)。
 * 汤底封存于 truth 文件,绝不进入主 agent 上下文;
 * 裁决:关键词规则快路径 → 插件侧 LLM 兜底 → 默认「无关」。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { complete, extractJson } from '../core/llm.js'
import { hashString } from '../core/rand.js'
import type { SchemeEngine } from '../core/manager.js'

export interface SoupVerdict {
  verdict: 'yes' | 'no' | 'irrelevant'
  note: string
  redHerring: boolean
}

export interface SoupFactPoint {
  key: string
  text: string
  core: boolean
}

export interface SoupRule {
  verdict: 'yes' | 'no'
  /** 全部出现才算命中(可空)。 */
  all?: string[]
  /** 至少出现一个(可空)。 */
  any?: string[]
  point?: string
}

export interface SoupCard {
  id: string
  title: string
  difficulty: 1 | 2 | 3
  surface: string
  truth: string
  factPoints: SoupFactPoint[]
  rules: SoupRule[]
  redHerringPatterns: string[]
  hints: [string, string, string]
  maxQuestions: number
}

export interface SoupState extends GameStateBase {
  scheme: 'soup'
  cardId: string
  questions: { q: string; verdict: SoupVerdict['verdict']; at: number }[]
  redHerrings: number
  coreHits: string[]
  maxQuestions: number
}

// ── 题库(人工打磨,规则先行;负面规则在前,避免复合问题误判) ────────────────────

export const SOUP_CARDS: SoupCard[] = [
  {
    id: 'soup-turtle',
    title: '海龟汤',
    difficulty: 2,
    surface: '一个男人走进一家餐厅,点了一碗海龟汤,喝了一口,然后回家自杀了。为什么?',
    truth: '他多年前在海上遇难,濒死时同伴给了他一份"海龟汤",他因此活了下来。今天这碗汤的味道与当年一模一样,他意识到当年喝下的其实是同伴的肉。',
    factPoints: [
      { key: 'sea', text: '他曾经在海上遇难/漂流', core: false },
      { key: 'taste', text: '汤的味道与当年某次经历一模一样', core: false },
      { key: 'source', text: '当年那锅"汤"其实是用人肉熬的', core: true },
      { key: 'guilt', text: '他因醒悟真相、愧疚而自杀', core: false },
    ],
    rules: [
      { verdict: 'yes', any: ['海难', '遇难', '漂流', '船难', '被困海上', '海上出事'], point: 'sea' },
      { verdict: 'yes', all: ['味道'], any: ['一样', '相同', '一模一样', '熟悉', '以前', '曾经', '当年', '喝过'], point: 'taste' },
      { verdict: 'yes', any: ['人肉', '吃人', '同伴的肉', '朋友的肉', '用人做的'], point: 'source' },
      { verdict: 'yes', all: ['同伴', '朋友', '伙伴', '船员'], any: ['肉', '救', '牺牲', '死', '煮'], point: 'source' },
      { verdict: 'yes', any: ['愧疚', '自责', '良心', '醒悟', '意识到', '无法承受', '崩溃'], point: 'guilt' },
      { verdict: 'yes', any: ['自杀', '不想活', '寻死'], point: 'guilt' },
      { verdict: 'no', any: ['毒', '下毒', '有毒', '中毒'] },
      { verdict: 'no', any: ['难喝', '太难吃', '太贵', '账单', '付不起', '没钱'] },
      { verdict: 'no', any: ['老板', '服务员', '厨师', '服务员下毒', '谋杀他'] },
    ],
    redHerringPatterns: ['毒', '下毒', '难喝', '太贵', '账单', '钱'],
    hints: [
      '别急着怀疑这碗汤本身有没有问题——先想想他"为什么喝得出来"。',
      '关键在于这碗汤的味道,和一个他过去的经历对上了。',
      '他曾经在海上遇难。那时候同伴也给了他一碗"海龟汤"。',
    ],
    maxQuestions: 35,
  },
  {
    id: 'soup-bar-water',
    title: '酒吧与水',
    difficulty: 1,
    surface: '一个男人走进酒吧,点了一杯水。酒保却突然掏出一把枪指着他。男人说了声"谢谢",然后离开了。为什么?',
    truth: '男人一直打嗝,想点水止嗝。酒保突然掏枪把他吓了一大跳,打嗝立刻停了,所以他道谢离开。',
    factPoints: [
      { key: 'hiccup', text: '男人当时一直在打嗝', core: true },
      { key: 'scare', text: '受惊吓可以止住打嗝', core: true },
    ],
    rules: [
      { verdict: 'yes', any: ['打嗝', '嗝'], point: 'hiccup' },
      { verdict: 'yes', all: ['吓'], any: ['枪', '指', '惊', '跳'], point: 'scare' },
      { verdict: 'yes', any: ['止嗝', '治打嗝', '治疗打嗝'], point: 'scare' },
      { verdict: 'no', any: ['抢劫', '劫匪', '抢钱', '杀人', '寻仇', '仇人'] },
      { verdict: 'no', any: ['毒', '下毒', '有毒'] },
      { verdict: 'no', any: ['威胁他', '恐吓他', '绑架'] },
    ],
    redHerringPatterns: ['抢劫', '劫匪', '仇', '毒', '威胁', '绑架'],
    hints: [
      '酒保不是坏人,枪也不是用来伤害他的。',
      '注意男人的身体状态——他进酒吧前就有点"小毛病"。',
      '那个小毛病,恰恰是"吓一跳"能治好的。',
    ],
    maxQuestions: 20,
  },
  {
    id: 'soup-elevator',
    title: '电梯十楼',
    difficulty: 2,
    surface: '一个男人住在十楼。他每天坐电梯下楼上班;可回家时只坐到七楼,再爬楼梯上十楼。一到下雨天,他却直接坐电梯到十楼。为什么?',
    truth: '男人是侏儒,个子太矮,够不到十楼的电梯按钮。下雨天他带着伞,可以用伞柄按到十楼按钮。',
    factPoints: [
      { key: 'short', text: '他个子很矮(侏儒)', core: true },
      { key: 'reach', text: '他够不到十楼按钮', core: false },
      { key: 'umbrella', text: '伞柄可以按到十楼按钮', core: false },
    ],
    rules: [
      { verdict: 'yes', any: ['矮', '侏儒', '个子小', '个子不高', '身高'], point: 'short' },
      { verdict: 'yes', any: ['够不到', '够不着', '按不到', '够不到按钮', '按不到按钮'], point: 'reach' },
      { verdict: 'yes', any: ['伞'], point: 'umbrella' },
      { verdict: 'yes', all: ['按钮'], any: ['十楼', '按'] },
      { verdict: 'no', any: ['锻炼', '健身', '减肥', '心脏', '健康'] },
      { verdict: 'no', any: ['鬼', '灵异', '害怕', '邻居', '躲'] },
    ],
    redHerringPatterns: ['锻炼', '健身', '健康', '鬼', '灵异'],
    hints: [
      '问题不在楼梯,而在于他"够不够得着"。',
      '他的身高和常人不太一样。',
      '下雨天他多了一样随身的东西——那东西够长。',
    ],
    maxQuestions: 30,
  },
  {
    id: 'soup-lighthouse',
    title: '灯塔守望者',
    difficulty: 3,
    surface: '一个男人住在海边的灯塔里,与世隔绝。每天邮差都会划船来给他送信。有一天,邮差没有来。男人自杀了。为什么?',
    truth: '邮差是他与外界唯一的联系。那天没有信,意味着连唯一记得他的人也不再理他,他彻底绝望,结束了自己的生命。',
    factPoints: [
      { key: 'isolated', text: '他独居灯塔,与世隔绝', core: false },
      { key: 'only-link', text: '邮差/信件是他与外界的唯一联系', core: true },
      { key: 'despair', text: '失去唯一联系后他彻底绝望', core: false },
    ],
    rules: [
      { verdict: 'yes', any: ['独居', '灯塔', '与世隔绝', '孤岛', '一个人住'], point: 'isolated' },
      { verdict: 'yes', any: ['唯一', '唯一的联系', '唯一联系'], point: 'only-link' },
      { verdict: 'yes', all: ['信'], any: ['唯一', '联系', '等待', '期盼'] },
      { verdict: 'yes', any: ['绝望', '孤独', '寂寞', '被遗忘', '抛弃'], point: 'despair' },
      { verdict: 'yes', any: ['自杀', '不想活'], point: 'despair' },
      { verdict: 'no', any: ['仇', '债', '威胁', '秘密', '罪'] },
      { verdict: 'no', any: ['邮差死了', '邮差遇害', '邮差被杀'] },
    ],
    redHerringPatterns: ['仇', '债', '威胁', '秘密', '遇害'],
    hints: [
      '先别想邮差出了什么事——想想信对这个人意味着什么。',
      '这个人与外界的联系,只有这一条。',
      '信没来的那一刻,他意识到自己彻底被世界遗忘了。',
    ],
    maxQuestions: 30,
  },
  {
    id: 'soup-hospital-light',
    title: '医院的灯',
    difficulty: 1,
    surface: '一个男人出车祸住院,眼睛被纱布包着。深夜,护士查完房,关灯离开。第二天清晨,男人从病房窗户跳了下去。为什么?',
    truth: '男人刚做完眼睛手术,医生说明天拆纱布就能恢复视力。深夜护士照例关灯,他眼前一片漆黑,误以为手术失败、自己已经失明,绝望之下跳楼。',
    factPoints: [
      { key: 'surgery', text: '他刚做完眼睛手术,纱布明天就能拆', core: false },
      { key: 'dark', text: '护士深夜关灯,他误把黑暗当作失明', core: true },
      { key: 'despair', text: '他以为自己失明,绝望自杀', core: false },
    ],
    rules: [
      { verdict: 'no', any: ['绝症', '癌症', '病危', '仇', '债', '钱', '抢劫'] },
      { verdict: 'no', any: ['护士害', '护士杀', '医生害', '医生杀', '谋杀'] },
      { verdict: 'yes', any: ['眼睛', '手术', '纱布', '拆线', '拆纱布'] },
      { verdict: 'yes', any: ['关灯', '停电', '灯关了', '灯被关'] },
      { verdict: 'yes', any: ['失明', '瞎', '看不见', '以为瞎', '以为失明'] },
      { verdict: 'yes', any: ['绝望', '崩溃'] },
    ],
    redHerringPatterns: ['害', '杀', '仇', '绝症', '抢劫'],
    hints: [
      '他看不见,不是因为眼睛,而是因为——灯。',
      '黑暗让他产生了误会:他以为手术失败了。',
      '护士只是照例关灯;他误以为失明,绝望自杀。',
    ],
    maxQuestions: 20,
  },
  {
    id: 'soup-funeral',
    title: '葬礼上的邂逅',
    difficulty: 2,
    surface: '一个男人在葬礼上对一个女人一见钟情。葬礼结束后不久,他杀死了自己的妹妹。为什么?',
    truth: '他只能在葬礼场合见到那个女人。为了再办一场葬礼、再次见到她,他杀死了自己的妹妹。',
    factPoints: [
      { key: 'crush', text: '他对葬礼上遇见的女人一见钟情', core: false },
      { key: 'only-funeral', text: '他只能在葬礼场合见到那个女人', core: true },
      { key: 'new-funeral', text: '杀妹妹是为了制造一场新葬礼,再次见到她', core: true },
    ],
    rules: [
      { verdict: 'no', any: ['遗产', '继承', '保险', '钱', '财产'] },
      { verdict: 'no', any: ['情敌', '三角恋', '出轨', '报复', '仇恨'] },
      { verdict: 'no', any: ['疯子', '精神病', '随机', '无差别'] },
      { verdict: 'yes', all: ['爱上'], any: ['她', '女人', '葬礼', '那个'] },
      { verdict: 'yes', any: ['一见钟情', '喜欢上', '心动', '迷恋'] },
      { verdict: 'yes', all: ['再见'], any: ['葬礼', '她', '女人', '见面'] },
      { verdict: 'yes', any: ['再办葬礼', '再办一场', '新葬礼', '另一场葬礼', '制造葬礼', '举办葬礼', '再举行'] },
      { verdict: 'yes', all: ['妹妹'], any: ['杀', '死', '害'] },
      { verdict: 'no', all: ['妹妹'], any: ['爱上', '喜欢', '心动'] },
    ],
    redHerringPatterns: ['遗产', '继承', '钱', '情敌', '报复', '精神病'],
    hints: [
      '关键不是他杀了谁,而是葬礼上他遇见了谁。',
      '他做这一切,是为了一个"下一次见面"的机会。',
      '他只能在葬礼上见到那个女人——所以要再办一场葬礼。',
    ],
    maxQuestions: 30,
  },
  {
    id: 'soup-desert-match',
    title: '沙漠里的火柴',
    difficulty: 2,
    surface: '一个男人赤身裸体死在沙漠里,手里攥着一根折断的火柴,身边没有任何脚印。为什么?',
    truth: '他和同伴乘热气球穿越沙漠。气球漏气下坠,大家脱光衣服减重仍然不够,于是抽火柴签决定谁跳下去——抽到折断火柴的人跳。他抽中了断火柴,跳了下去,所以周围没有脚印。',
    factPoints: [
      { key: 'balloon', text: '他们乘热气球穿越沙漠,气球出故障下坠', core: true },
      { key: 'draw', text: '超重时抽火柴签(折断=死签),他抽中了', core: true },
      { key: 'naked', text: '脱光衣服是为了减重', core: false },
      { key: 'no-footprint', text: '没有脚印是因为他从空中坠下', core: false },
    ],
    rules: [
      { verdict: 'no', any: ['被杀', '谋杀', '他杀', '劫匪', '绑架', '凶手'] },
      { verdict: 'no', any: ['自杀', '寻死', '不想活'] },
      { verdict: 'no', any: ['迷路', '渴死', '饿死', '中暑', '晒死', '脱水'] },
      { verdict: 'yes', any: ['热气球', '气球', '飞艇'] },
      { verdict: 'yes', all: ['火柴'], any: ['抽', '抽签', '签', '短', '折断', '抓阄'] },
      { verdict: 'yes', all: ['跳'], any: ['抽', '抽中', '抽签', '签', '选'] },
      { verdict: 'yes', any: ['脱光', '裸体', '赤身', '衣服', '减重', '减轻', '超重'] },
      { verdict: 'yes', all: ['脚印'], any: ['空中', '坠落', '天上', '掉下', '从天上'] },
    ],
    redHerringPatterns: ['谋杀', '劫匪', '渴死', '迷路', '自杀'],
    hints: [
      '先别管脚印——想想他为什么不穿衣服,又是从哪来的。',
      '他不是走进去的。他在天上,而天上的人在做一道选择题。',
      '热气球、超重、抽签——抽到短火柴的人跳了下去。',
    ],
    maxQuestions: 35,
  },
  {
    id: 'soup-seaweed',
    title: '湖里的水草',
    difficulty: 3,
    surface: '一个男人和女友在湖边约会。他下水游泳,上岸后却自杀了。为什么?',
    truth: '他游泳时脚被"水草"缠住,他拼命挣脱。上岸后才发现女友不见了——女友在他下水后落水求救,他误把她的头发当作水草挣脱,害得女友溺亡;他悔恨交加,自杀殉情。',
    factPoints: [
      { key: 'hair', text: '缠住他的"水草"其实是女友的头发', core: true },
      { key: 'drowned', text: '女友在他游泳时落水求救,被误判为水草', core: true },
      { key: 'regret', text: '他明白真相后悔恨自杀', core: false },
    ],
    rules: [
      { verdict: 'no', any: ['谋杀', '情杀', '他杀', '杀人'] },
      { verdict: 'no', any: ['出轨', '劈腿', '第三者', '背叛'] },
      { verdict: 'no', any: ['债', '仇', '钱', '财产'] },
      { verdict: 'yes', any: ['水草'] },
      { verdict: 'yes', any: ['头发', '发丝', '长发'] },
      { verdict: 'yes', all: ['女友'], any: ['落水', '掉进', '掉入', '溺水', '淹', '求救', '呼救'] },
      { verdict: 'yes', all: ['误'], any: ['水草', '头发', '挣脱', '救', '以为'] },
      { verdict: 'yes', any: ['悔恨', '自责', '愧疚', '崩溃', '殉情'] },
    ],
    redHerringPatterns: ['谋杀', '出轨', '债', '仇'],
    hints: [
      '先想清楚:湖里的"水草",真的是水草吗?',
      '他游泳的时候,湖边还发生了另一件事——和另一个人有关。',
      '他挣脱的不是水草,是女友的头发;他错过了求救,所以悔恨自杀。',
    ],
    maxQuestions: 30,
  },
]

function pickCard(difficulty: number, seed: number): SoupCard {
  const pool = SOUP_CARDS.filter((card) => card.difficulty === difficulty)
  const candidates = pool.length > 0 ? pool : SOUP_CARDS
  return candidates[Math.abs(seed) % candidates.length]
}

// ── 裁决 ────────────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/[?？!！,。.、]/g, '')
}

function ruleMatches(rule: SoupRule, q: string): boolean {
  if (rule.all !== undefined) {
    for (const word of rule.all) if (!q.includes(normalize(word))) return false
  }
  if (rule.any !== undefined) {
    const hit = rule.any.some((word) => q.includes(normalize(word)))
    if (!hit) return false
  }
  return true
}

function redHerringHit(card: SoupCard, q: string): boolean {
  return card.redHerringPatterns.some((word) => q.includes(normalize(word)))
}

function recordPoint(state: SoupState, card: SoupCard, point?: string): void {
  if (point === undefined) return
  const fact = card.factPoints.find((f) => f.key === point)
  if (fact !== undefined && !state.coreHits.includes(fact.key)) {
    state.coreHits.push(fact.key)
  }
}

const JUDGE_SYSTEM = `你是海龟汤的裁决引擎。你会收到汤底与玩家的一个问题。玩家不知道汤底。
只输出一个 JSON 对象:{"verdict":"yes"|"no"|"irrelevant","note":"给主持人的简短提示,告诉它如何措辞回答,但绝不复述汤底细节"}
判定标准:
- 问题涉及的内容与汤底事实相符或部分相符 → "yes"
- 问题提出一个与汤底矛盾或错误的猜测 → "no"
- 问题与汤底无关、或无法判定、或属于玩家在错误方向上兜圈子 → "irrelevant"
汤底原文只在你的上下文里,绝不外泄。`

async function llmAdjudicate(ctx: Context, route: AgentRoute, card: SoupCard, question: string, signal?: AbortSignal): Promise<SoupVerdict> {
  const user = `汤底:${card.truth}\n\n玩家的问题:${question}`
  const text = await complete(ctx, route, {
    system: JUDGE_SYSTEM,
    user,
    maxTokens: 300,
    signal,
  })
  const parsed = extractJson<{ verdict: 'yes' | 'no' | 'irrelevant'; note?: string }>(text)
  const verdict = parsed.verdict === 'yes' || parsed.verdict === 'no' ? parsed.verdict : 'irrelevant'
  return { verdict, note: parsed.note ?? '', redHerring: redHerringHit(card, question) }
}

export async function adjudicateQuestion(
  ctx: Context,
  route: AgentRoute,
  card: SoupCard,
  state: SoupState,
  question: string,
  signal?: AbortSignal,
): Promise<{ verdict: SoupVerdict; usedLlm: boolean }> {
  const q = normalize(question)
  for (const rule of card.rules) {
    if (ruleMatches(rule, q)) {
      recordPoint(state, card, rule.point)
      return {
        verdict: { verdict: rule.verdict, note: '', redHerring: redHerringHit(card, q) },
        usedLlm: false,
      }
    }
  }
  try {
    const verdict = await llmAdjudicate(ctx, route, card, question, signal)
    if (verdict.verdict === 'yes') {
      // LLM 命中「是」时,尽量记一个事实点(若有匹配的)
      const hit = card.factPoints.find((f) => q.includes(normalize(f.text.slice(0, 8))))
      if (hit) recordPoint(state, card, hit.key)
    }
    return { verdict, usedLlm: true }
  } catch {
    return { verdict: { verdict: 'irrelevant', note: '', redHerring: redHerringHit(card, q) }, usedLlm: false }
  }
}

// ── 猜底 ────────────────────────────────────────────────────────────────────

const GUESS_SYSTEM = `你是海龟汤的判定引擎。你会收到汤底与玩家给出的完整答案。
判断玩家的答案是否实质上还原了汤底的核心(允许换说法、允许省略细节,但核心因果必须一致)。
只输出一个 JSON 对象:{"solved":true|false,"comment":"一句话评语,给主持人参考,不要复述汤底"}`

export async function judgeGuess(
  ctx: Context,
  route: AgentRoute,
  card: SoupCard,
  answer: string,
  signal?: AbortSignal,
): Promise<{ solved: boolean; comment: string }> {
  try {
    const text = await complete(ctx, route, {
      system: GUESS_SYSTEM,
      user: `汤底:${card.truth}\n\n玩家的答案:${answer}`,
      maxTokens: 300,
      signal,
    })
    const parsed = extractJson<{ solved: boolean; comment?: string }>(text)
    return { solved: parsed.solved === true, comment: parsed.comment ?? '' }
  } catch {
    // 兜底:关键词重叠率粗糙判定
    const truthWords = new Set(normalize(card.truth).split(''))
    const answerWords = normalize(answer)
    let hits = 0
    for (const ch of truthWords) if (answerWords.includes(ch)) hits++
    const ratio = hits / Math.max(truthWords.size, 1)
    return { solved: ratio > 0.55, comment: '' }
  }
}

// ── 计分 ────────────────────────────────────────────────────────────────────

function computeScore(state: SoupState, solved: boolean): ScoreBar[] {
  const bars: ScoreBar[] = [
    {
      label: '结论正确性',
      value: solved ? 100 : 0,
      note: solved ? '成功还原汤底' : '未还原汤底',
    },
  ]
  const efficiency = Math.max(0, 100 - state.questions.length * 2 - state.redHerrings * 8 - state.hintsUsed * 15)
  bars.push({
    label: '效率',
    value: efficiency,
    note: `${state.questions.length} 个问题 · ${state.redHerrings} 次红鱼 · ${state.hintsUsed} 次提示`,
  })
  const coreCount = state.coreHits.length
  bars.push({
    label: '推理质量',
    value: solved ? Math.min(100, coreCount * 40) : Math.min(80, coreCount * 40),
    note: coreCount > 0 ? `已触及 ${coreCount} 个关键要素` : '尚未触及关键要素',
  })
  return bars
}

/** soup_guess 命中后的结算。 */
export function settleSoup(state: SoupState, solved: boolean): { score: ScoreBar[]; text: string } {
  const score = computeScore(state, solved)
  const lines = score.map((bar) => `- ${bar.label}:${bar.value}(${bar.note})`).join('\n')
  const text = `【海龟汤 · 结算】${solved ? '✅ 还原成功!' : ''}

${lines}

主持人守则:恭喜玩家并公布三栏得分。告诉玩家:输入 /game quit 可以查看汤底完整真相。`
  return { score, text }
}

// ── 简报 ────────────────────────────────────────────────────────────────────

function buildBrief(card: SoupCard, state: SoupState): string {
  return `【游戏开始:海龟汤 · ${card.title}】(难度 ${card.difficulty}/3)

现在你是海龟汤主持人。玩家不知道汤底,会不断提问题来还原真相。请遵守以下铁律:

1. 你【不知道汤底】。不要猜测、不要编造、不要脑补故事——汤底只存在于游戏引擎中。
2. 玩家每提出一个问题,你必须先调用工具 \`soup_ask\`,把玩家的问题原文传进去;引擎会返回裁决(是 / 否 / 无关)和措辞提示,你【严格按裁决回答】,再根据提示润色成一两句话。
3. 不要主动透露真相,不要在"无关"的回答里塞额外信息。
4. 【禁止虚构细节】你只知道汤面这一句话,不得补充任何汤面之外的设定(地点、人物、事件、动机一律不得自行添加);若裁决为"无关",只说明该问题与汤底无关即可,不要编造新场景来圆场。
5. 当玩家给出完整的汤底还原(如"我知道了,答案是……")时,调用工具 \`soup_guess\` 提交他的答案,按引擎返回的结果回应。
6. 玩家可以用 /game score 查分、/game quit 结束并看真相、/hint 买提示(提示由引擎给出)。

汤面:${card.surface}

用一句主持人的开场白欢迎玩家,然后等待第一个问题。`
}

function resumeBrief(state: SoupState): string {
  return `【继续游戏:海龟汤】已进行 ${state.questions.length} 个问题${state.hintsUsed > 0 ? `,已用 ${state.hintsUsed} 次提示` : ''}。你仍是主持人:不知道汤底,玩家提问时先调用 soup_ask,完整答案用 soup_guess 提交。请提醒玩家"我们继续",并复述汤面。`
}

function settleText(state: SoupState, truth: unknown): string {
  const card = truth as SoupCard
  const solved = state.phase === 'solved'
  const bars = computeScore(state, solved)
  const lines = bars.map((bar) => `- ${bar.label}:${bar.value}(${bar.note})`)
  return `【海龟汤 · 结算】${solved ? '✅ 已还原汤底' : '❌ 未还原汤底'}

${lines.join('\n')}

【真相】${card.truth}

本局问题数:${state.questions.length} · 红鱼:${state.redHerrings} · 提示:${state.hintsUsed}`
}

function scoreText(state: SoupState): string {
  const bars = computeScore(state, state.phase === 'solved')
  return `【海龟汤 · 当前进度】已问 ${state.questions.length}/${state.maxQuestions} 个问题 · 红鱼 ${state.redHerrings} · 提示 ${state.hintsUsed}

${bars.map((bar) => `- ${bar.label}:${bar.value}(${bar.note})`).join('\n')}

猜出汤底后直接说出你的答案,主持人会替你提交判定。`
}

// ── 引擎入口 ────────────────────────────────────────────────────────────────

export const soupEngine: SchemeEngine = {
  id: 'soup',
  label: '海龟汤',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 1
    const card = pickCard(level, hashString(sessionId) + level)
    const now = Date.now()
    const state: SoupState = {
      scheme: 'soup',
      difficulty: card.difficulty,
      startedAt: now,
      updatedAt: now,
      phase: 'playing' as GamePhase,
      turns: 0,
      hintsUsed: 0,
      score: null,
      cardId: card.id,
      questions: [],
      redHerrings: 0,
      coreHits: [],
      maxQuestions: card.maxQuestions,
    }
    return { state, truth: card, brief: buildBrief(card, state) }
  },
  resumeBrief(state) {
    return resumeBrief(state as SoupState)
  },
  scoreText(state) {
    return scoreText(state as SoupState)
  },
  settleText(state, truth) {
    return settleText(state as SoupState, truth)
  },
  hint(state, truth) {
    const card = truth as SoupCard
    const idx = Math.min((state as SoupState).hintsUsed, card.hints.length - 1)
    return { text: `【提示 ${idx + 1}/${card.hints.length}】${card.hints[idx]}` }
  },
}
