/**
 * 方案七·王国议会(回合制王国经营,路线图阶段 6)。
 *
 * v1 落地范围(与 docs/07-kingdom-council.md 的取舍):
 *   - 确定性账本内核:粮/金/军/民心 + 四个隐藏变量(瘟疫/贪腐/外敌/饥荒)纯函数结算;
 *   - 事件模板库 + 事件链(条件触发)+ 平静季兜底;late-game 事件增量放大;
 *   - 4 名顾问:议程/知识质量/欺瞒边界注入 persona;每局开局扰动(财政贪腐度、密探买家)按种子生成;
 *   - 议会 fan-out:顾问立场由引擎按"标签偏好 + 扰动"确定性计算(谁主张哪个选项),LLM 只负责台词;
 *   - 信任系统:结算后按"立场 vs 最优/最劣选项"确定性升降;
 *   - 调查:花金揭露顾问议程,或获取隐藏变量的模糊趋势;
 *   - 20 季终局三栏:王国结局(覆灭/维持/繁荣)+ 决策质量(最优选择率)+ 识人准确度(揭露议程数)。
 *   subagent 化议会与 workflow 编排是后续里程碑(与其余方案共享)。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GamePhase, GameStateBase, ScoreBar } from '../types.js'
import { type ChatTurn } from '../core/llm.js'
import { talkAsNpc } from '../core/npc.js'
import { auditReply, sanitizedLine, type AuditEntry } from '../core/audit.js'
import { hashString, mulberry32 } from '../core/rand.js'
import type { SchemeEngine } from '../core/manager.js'

// ── 数据模型 ──────────────────────────────────────────────────────────────────

export type ResourceKey = 'food' | 'gold' | 'army' | 'loyalty'
export type HiddenKey = 'plague' | 'corruption' | 'threat' | 'famine'

export const HIDDEN_LABEL: Record<HiddenKey, string> = {
  plague: '瘟疫潜伏',
  corruption: '朝堂贪腐',
  threat: '外敌威胁',
  famine: '饥荒压力',
}

export interface CouncilOption {
  id: string
  label: string
  tags: string[]
  delta: Partial<Record<ResourceKey | HiddenKey, number>>
  /** 结算后的叙事说明。 */
  note: string
}

export interface CouncilEvent {
  id: string
  seasonMin: number
  repeat: number
  requires?: { hidden: HiddenKey; min: number }
  title: string
  prompt: string
  options: CouncilOption[]
  best: string
  worst: string
}

export interface CouncilAdvisor {
  id: string
  name: string
  role: string
  persona: string
  /** 议程事实 id(/council investigate 可揭露)。 */
  agendaFact: string | null
  /** 标签偏好:选项 tags 加权求和,最大值即其主张(引擎确定,LLM 只写台词)。 */
  weights: Record<string, number>
  lieStyle: string
  /** 开场语口吻样例。 */
  voice: string
}

export interface CouncilScript {
  id: string
  title: string
  kingdom: string
  intro: string
  seasons: number
  advisors: CouncilAdvisor[]
  facts: { id: string; type: 'motive' | 'identity' | 'testimony'; text: string; auditKeywords?: string[] }[]
  npc: Record<string, { persona: string; knowledge: string[]; mustNotAdmit: string[]; liePolicy: string }>
  events: CouncilEvent[]
  hints: [string, string, string]
}

// ── 手工剧本:云澜王国 ─────────────────────────────────────────────────────────

const F_TREASURER = 'f_treasurer_greed'
const F_GENERAL = 'f_general_warmonger'
const F_PRIEST = 'f_priest_ignorant'
const F_SPY_ENEMY = 'f_spy_enemy'
const F_SPY_COURT = 'f_spy_court'
const F_SPY_LOYAL = 'f_spy_loyal'

export const COUNCIL: CouncilScript = {
  id: 'cloud-realm',
  title: '云澜王国',
  kingdom: '云澜国',
  intro:
    '先王驾崩,你于乱局中即位,统治云澜国。邻国伏尔泰虎视眈眈,朝中四位重臣各怀心思。每季一场议会,二十季之后,看这个王国会落成什么样子。',
  seasons: 20,
  advisors: [
    {
      id: 'treasurer',
      name: '沈万钧',
      role: '财政大臣',
      persona: '精打细算,开口必谈国库;报忧时眼神飘忽,手指无意识地捻着账册。',
      agendaFact: F_TREASURER,
      weights: { thrift: 2, spend: -1, trade: 1, people: 1 },
      lieStyle: '你会在财政数字上夸大困难,但不敢编造具体账目(怕被查账戳穿);把国库说得越空,你的私囊越鼓。',
      voice: '「陛下,国库的底子,老臣比谁都清楚。」',
    },
    {
      id: 'general',
      name: '霍震霆',
      role: '将军',
      persona: '声若洪钟,坐姿笔挺;谈到军务时两眼放光,谈到伤亡与军费时轻描淡写。',
      agendaFact: F_GENERAL,
      weights: { war: 2, firm: 1, risk: 1, mercy: -1, peace: -1 },
      lieStyle: '你会淡化战争的伤亡与军费、夸大敌军的疲弱,但不敢伪造军情数字(军情渠道可查)。',
      voice: '「给臣三万铁骑,三个月荡平边境。」',
    },
    {
      id: 'priest',
      name: '玄尘子',
      role: '大祭司',
      persona: '仙风道骨,说话必引天象;对民生疾苦有真怜悯,对钱粮实务一窍不通却言之凿凿。',
      agendaFact: F_PRIEST,
      weights: { faith: 2, mercy: 2, people: 1, peace: 1, war: -1, risk: -1 },
      lieStyle: '你以"天意/征兆"包装无知,夸大灾祸以抬教会地位;不编造具体数字,只说"征兆"。',
      voice: '「贫道夜观天象,此乃上苍示警。」',
    },
    {
      id: 'spy',
      name: '顾长风',
      role: '密探头子',
      persona: '形貌低调,声音沙哑;消息最灵,说话只说七分,留三分余地。',
      agendaFact: F_SPY_ENEMY,
      weights: { safe: 1, trade: 1 },
      lieStyle: '你的消息都是真的,但你有选择地说;被收买时,把敌情往买家有利的方向带。',
      voice: '「斥候来报——至于信不信,陛下自己定夺。」',
    },
  ],
  facts: [
    {
      id: F_TREASURER,
      type: 'motive',
      text: '财政大臣沈万钧暗中贪腐,虚报国库亏空,把征来的钱粮中饱私囊。',
      auditKeywords: ['贪腐', '中饱私囊', '私吞', '吞了', '亏空是假的', '虚报'],
    },
    { id: F_GENERAL, type: 'motive', text: '将军霍震霆好战成性,力主先发制人,只为扩军立功。', auditKeywords: ['扩军立功', '好战', '军功', '建功'] },
    { id: F_PRIEST, type: 'identity', text: '大祭司玄尘子不通钱粮实务,以天意神谕掩盖自己的无知。', auditKeywords: ['不通实务', '无知', '不懂', '装神弄鬼', '胡诌'] },
    { id: F_SPY_ENEMY, type: 'identity', text: '密探头子顾长风已被邻国伏尔泰收买,误导朝堂。', auditKeywords: ['收买', '卧底', '细作', '背叛', '通敌', '内应'] },
    { id: F_SPY_COURT, type: 'identity', text: '密探头子顾长风暗中效忠宫廷政敌,图谋不轨。', auditKeywords: ['政敌', '密谋', '废立', '不轨'] },
    { id: F_SPY_LOYAL, type: 'identity', text: '密探头子顾长风忠于王室,只是消息渠道有些老化。', auditKeywords: [] },
  ],
  npc: {
    treasurer: {
      persona: '你是云澜国的财政大臣沈万钧。',
      knowledge: [F_TREASURER],
      mustNotAdmit: [F_TREASURER],
      liePolicy: '绝不承认贪腐;被质问时强调"国库吃紧是老臣算出来的,分毫不差"。',
    },
    general: {
      persona: '你是云澜国的大将军霍震霆。',
      knowledge: [F_GENERAL],
      mustNotAdmit: [F_GENERAL],
      liePolicy: '不承认好战扩权的私心,把一切主张说成"为社稷计"。',
    },
    priest: {
      persona: '你是云澜国的大祭司玄尘子。',
      knowledge: [F_PRIEST],
      mustNotAdmit: [F_PRIEST],
      liePolicy: '绝不承认自己不通实务,一律归为"天意难测"。',
    },
    spy: {
      persona: '你是云澜国的密探头子顾长风。',
      knowledge: [F_SPY_ENEMY],
      mustNotAdmit: [F_SPY_ENEMY],
      liePolicy: '绝不承认被收买,咬定"所有线报都经得起查"。',
    },
  },
  events: [
    {
      id: 'e_calm',
      seasonMin: 1,
      repeat: 2,
      title: '平静的一季',
      prompt: '边境无事,朝野安稳,是难得的太平光景。',
      options: [
        { id: 'rest', label: '休养生息', tags: ['safe', 'people'], delta: { food: 1, loyalty: 1 }, note: '百姓得以喘息,仓廪与民心小有进益。' },
        { id: 'build', label: '大兴土木', tags: ['spend', 'greed'], delta: { gold: -3, loyalty: -1, corruption: 0.05 }, note: '宫殿修起来了,国库与民心却伤了。' },
        { id: 'drill', label: '整军练兵', tags: ['war', 'firm'], delta: { gold: -2, army: 2 }, note: '军容更整,只是又花了一笔。' },
      ],
      best: 'rest',
      worst: 'build',
    },
    {
      id: 'e_drought1',
      seasonMin: 2,
      repeat: 1,
      title: '春旱',
      prompt: '春耕方过,连月无雨。郡守来报:今年的收成怕是撑不到秋粮。',
      options: [
        { id: 'pray', label: '开坛祈雨', tags: ['faith', 'mercy'], delta: { loyalty: 3, famine: 0.15 }, note: '百姓感念君恩,可天不会因为香火就下雨。' },
        { id: 'ration', label: '开仓节粮', tags: ['thrift', 'people'], delta: { food: -4, loyalty: 2, famine: -0.15 }, note: '存粮见底,但灾情稳住了。' },
        { id: 'tax_relief', label: '免征农税', tags: ['mercy', 'people'], delta: { gold: -4, loyalty: 4, famine: -0.05 }, note: '民心大振,国库少了一笔岁入。' },
      ],
      best: 'ration',
      worst: 'pray',
    },
    {
      id: 'e_war_scare',
      seasonMin: 3,
      repeat: 2,
      title: '边境烽烟',
      prompt: '东境斥候回报:邻国伏尔泰正在集结人马,似有犯境之意。',
      options: [
        { id: 'strike', label: '先发制人', tags: ['war', 'risk'], delta: { army: -8, gold: -4, threat: -0.25, loyalty: -2 }, note: '一战胜之,却也元气大伤,百姓怨声载道。' },
        { id: 'defend', label: '固守边境', tags: ['firm', 'safe'], delta: { army: -2, gold: -1, threat: 0.1, loyalty: -1 }, note: '敌军未敢轻进,但边境的阴影更浓了。' },
        { id: 'envoy', label: '遣使连横', tags: ['peace', 'trade'], delta: { gold: -3, threat: -0.2, loyalty: 1 }, note: '使者斡旋,烽烟暂熄,商路重开。' },
        { id: 'appease', label: '送粮示弱', tags: ['peace', 'mercy'], delta: { food: -5, gold: -2, threat: 0.15, loyalty: -3 }, note: '粮车送进了敌营,只换来更大的胃口。' },
      ],
      best: 'envoy',
      worst: 'appease',
    },
    {
      id: 'e_tax',
      seasonMin: 4,
      repeat: 1,
      title: '税制之争',
      prompt: '户部呈上新税策:丈田均税,还是加征丁税?朝堂吵成一团。',
      options: [
        { id: 'land_tax', label: '丈田均税', tags: ['firm', 'people'], delta: { gold: 3, loyalty: 3, corruption: -0.1 }, note: '田亩厘清,豪强无所遁形,国库民心双收。' },
        { id: 'head_tax', label: '加征丁税', tags: ['firm', 'greed'], delta: { gold: 6, loyalty: -5 }, note: '国库一时充盈,民间骂声四起。' },
        { id: 'status_quo', label: '维持现状', tags: ['safe'], delta: {}, note: '什么都没变,问题留给了下一季。' },
      ],
      best: 'land_tax',
      worst: 'head_tax',
    },
    {
      id: 'e_plague',
      seasonMin: 5,
      repeat: 1,
      title: '瘟疫之兆',
      prompt: '南郡来报:时疫有蔓延之象,已有多村染病。',
      options: [
        { id: 'quarantine', label: '封城隔离', tags: ['firm', 'people'], delta: { loyalty: -5, gold: -1, plague: -0.25 }, note: '疫病被摁住了,可封城的日子让百姓怨声不断。' },
        { id: 'pray2', label: '大祭禳灾', tags: ['faith', 'mercy'], delta: { loyalty: 2, plague: 0.15 }, note: '祭坛香火鼎盛,瘟疫可不怕这个。' },
        { id: 'granary', label: '开仓施药', tags: ['spend', 'people', 'mercy'], delta: { gold: -4, food: -3, plague: -0.15, loyalty: 2 }, note: '药到病缓,民心稍安,耗了钱粮。' },
      ],
      best: 'quarantine',
      worst: 'pray2',
    },
    {
      id: 'e_corruption',
      seasonMin: 6,
      repeat: 2,
      title: '御史弹劾',
      prompt: '御史台密奏:有官员虚报账目、克扣粮饷。朝中贪腐,似乎已非一日。',
      options: [
        { id: 'audit', label: '彻查账目', tags: ['firm'], delta: { gold: -2, corruption: -0.25, loyalty: 3 }, note: '贪官落马一批,朝野为之一清。' },
        { id: 'tolerate', label: '姑息了事', tags: ['safe'], delta: { gold: 2, corruption: 0.2, loyalty: -2 }, note: '你按下了奏章,窟窿却越挖越大。' },
        { id: 'seize', label: '抄家充公', tags: ['firm', 'greed'], delta: { gold: 6, corruption: -0.1, loyalty: -6 }, note: '国库进账丰厚,只是抄家之风一起,人人自危。' },
      ],
      best: 'audit',
      worst: 'tolerate',
    },
    {
      id: 'e_wolves',
      seasonMin: 7,
      repeat: 1,
      title: '边境匪患',
      prompt: '西境马匪为祸,劫掠商队,民不聊生。',
      options: [
        { id: 'clear', label: '发兵清剿', tags: ['war', 'firm'], delta: { army: -3, gold: -1, loyalty: 3 }, note: '匪患荡平,商路复通。' },
        { id: 'ignore', label: '暂且放任', tags: ['risk'], delta: { loyalty: -4, gold: -2 }, note: '匪势坐大,商税锐减。' },
        { id: 'bounty', label: '悬赏缉拿', tags: ['spend'], delta: { gold: -3, loyalty: 1 }, note: '重赏之下,匪首授首。' },
      ],
      best: 'clear',
      worst: 'ignore',
    },
    {
      id: 'e_flood',
      seasonMin: 8,
      repeat: 1,
      title: '大河决堤',
      prompt: '连日暴雨,大河水位告急,下游三郡危在旦夕。',
      options: [
        { id: 'dyke', label: '征发民夫修堤', tags: ['spend', 'firm'], delta: { gold: -5, food: -2, loyalty: 3, famine: -0.1 }, note: '大堤保住,三郡无恙。' },
        { id: 'relocate', label: '迁移灾民', tags: ['mercy', 'people'], delta: { loyalty: 2, food: -2, plague: 0.1 }, note: '灾民安顿下来,只是人烟稠密处疫病暗生。' },
        { id: 'ignore_flood', label: '听天由命', tags: ['safe'], delta: { loyalty: -6, food: -4, famine: 0.15, plague: 0.1 }, note: '洪水过后,满目疮痍。' },
      ],
      best: 'dyke',
      worst: 'ignore_flood',
    },
    {
      id: 'e_harvest',
      seasonMin: 9,
      repeat: 2,
      title: '五谷丰登',
      prompt: '风调雨顺,秋收大熟,粮仓眼看要装不下了。',
      options: [
        { id: 'store', label: '广建粮仓囤粮', tags: ['thrift'], delta: { food: 6 }, note: '仓廪充实,来年无忧。' },
        { id: 'festival', label: '大办庆典', tags: ['spend', 'mercy'], delta: { gold: -3, loyalty: 5 }, note: '举国欢庆,民心沸腾,银子像水一样流走。' },
        { id: 'sell', label: '售粮换金', tags: ['trade', 'greed'], delta: { gold: 6, food: -4 }, note: '金库充盈,粮仓却见了底。' },
      ],
      best: 'store',
      worst: 'sell',
    },
    {
      id: 'e_famine',
      seasonMin: 10,
      repeat: 1,
      requires: { hidden: 'famine', min: 0.35 },
      title: '大饥荒',
      prompt: '连年歉收,饥荒席卷北方诸郡,流民塞道。',
      options: [
        { id: 'ration2', label: '全面配给', tags: ['thrift', 'firm', 'people'], delta: { food: -3, loyalty: -2, famine: -0.25 }, note: '配给制稳住了秩序,人人都瘦了一圈。' },
        { id: 'pray3', label: '举国大祭', tags: ['faith'], delta: { gold: -2, loyalty: 1, famine: 0.15 }, note: '祭典盛大,饥荒依旧。' },
        { id: 'buy_grain', label: '重金购粮', tags: ['spend', 'trade'], delta: { gold: -6, food: 5, famine: -0.15 }, note: '邻国的粮食救了急,价钱令人肉痛。' },
      ],
      best: 'ration2',
      worst: 'pray3',
    },
    {
      id: 'e_revolt',
      seasonMin: 11,
      repeat: 1,
      requires: { hidden: 'famine', min: 0.25 },
      title: '民变将起',
      prompt: '多地有饥民聚集,民怨沸腾,一场民变正在酝酿。',
      options: [
        { id: 'suppress', label: '调兵镇压', tags: ['war', 'firm'], delta: { army: -4, loyalty: -5, corruption: 0.05 }, note: '刀兵见血,怨气更深。' },
        { id: 'hear', label: '亲赴倾听请愿', tags: ['mercy', 'people'], delta: { gold: -2, loyalty: 6 }, note: '你站在了百姓面前,民怨化作了信任。' },
        { id: 'buy_off', label: '收买首领', tags: ['spend', 'greed'], delta: { gold: -5, loyalty: 2, corruption: 0.15 }, note: '银钱开路,头领散了,火种还在。' },
      ],
      best: 'hear',
      worst: 'suppress',
    },
    {
      id: 'e_omen',
      seasonMin: 12,
      repeat: 1,
      title: '天象异变',
      prompt: '荧惑守心,彗星经天。民间议论纷纷,人心浮动。',
      options: [
        { id: 'grand_ritual', label: '大祭安民', tags: ['faith', 'spend'], delta: { gold: -4, loyalty: 4 }, note: '祭典之后,人心渐定。' },
        { id: 'ignore_omen', label: '置之不理', tags: ['safe'], delta: { loyalty: -3, corruption: 0.05 }, note: '谣言四起,朝野不安。' },
        { id: 'science', label: '设立天文局', tags: ['firm', 'spend'], delta: { gold: -3, loyalty: 2, plague: -0.05 }, note: '天象归天象,政事归政事,人心大定。' },
      ],
      best: 'grand_ritual',
      worst: 'ignore_omen',
    },
    {
      id: 'e_embassy',
      seasonMin: 13,
      repeat: 1,
      title: '邻国来使',
      prompt: '伏尔泰遣使而来,提议两国联姻会盟,永结盟好。',
      options: [
        { id: 'marry', label: '应允联姻', tags: ['peace', 'trade'], delta: { gold: 3, loyalty: 2, threat: -0.15 }, note: '两国联姻,边境商路大开,烽烟暂歇。' },
        { id: 'decline', label: '断然拒绝', tags: ['firm', 'risk'], delta: { loyalty: -2, threat: 0.1 }, note: '使者拂袖而去,边境风声更紧。' },
        { id: 'tribute', label: '纳贡示好', tags: ['spend', 'safe'], delta: { gold: -5, threat: -0.2, loyalty: -3 }, note: '岁贡换来了暂时的太平,朝野却觉得屈辱。' },
      ],
      best: 'marry',
      worst: 'decline',
    },
  ],
  hints: [
    '每季先看账本再听发言:谁的主张和账本对得上,谁在顾左右而言他。',
    '花 2 金调查一位顾问,能查清他到底效忠于什么。',
    '隐藏的祸患不会自己消失:瘟疫、贪腐、外敌、饥荒,各有各的解决之道。',
  ],
}

// ── 状态 ──────────────────────────────────────────────────────────────────────

export interface CouncilPerturb {
  /** 财政大臣贪腐度 0(清廉)~0.8(巨贪)。 */
  treasurerCorruption: number
  /** 密探头子买家:enemy(邻国)/ court(政敌)/ none(清白)。 */
  spyBuyer: 'enemy' | 'court' | 'none'
}

export interface CouncilHistoryEntry {
  season: number
  eventId: string
  title: string
  optionId: string
  label: string
  notes: string[]
}

export interface CouncilState extends GameStateBase {
  scheme: 'council'
  season: number
  resources: Record<ResourceKey, number>
  hidden: Record<HiddenKey, number>
  lastHidden: Record<HiddenKey, number>
  trust: Record<string, number>
  exposed: string[]
  exploded: HiddenKey[]
  history: CouncilHistoryEntry[]
  pending: { eventId: string; stances: Record<string, string> } | null
  used: Record<string, number>
  perturb: CouncilPerturb
  conversations: Record<string, ChatTurn[]>
  auditLog?: AuditEntry[]
  decisions: number
  bestChoices: number
}

function initialResources(difficulty: number): Record<ResourceKey, number> {
  if (difficulty <= 1) return { food: 48, gold: 32, army: 42, loyalty: 58 }
  if (difficulty === 3) return { food: 34, gold: 20, army: 28, loyalty: 44 }
  return { food: 42, gold: 28, army: 34, loyalty: 52 }
}

function makePerturb(seed: number, difficulty: number): CouncilPerturb {
  const rng = mulberry32(seed + 7919)
  const corruption = difficulty === 3 ? 0.5 + rng() * 0.3 : difficulty === 1 ? rng() * 0.25 : rng() * 0.5
  const buyerRoll = rng()
  const spyBuyer: CouncilPerturb['spyBuyer'] =
    difficulty === 3 ? (buyerRoll < 0.6 ? 'enemy' : 'court') : difficulty === 1 ? 'none' : buyerRoll < 0.35 ? 'enemy' : buyerRoll < 0.5 ? 'court' : 'none'
  return { treasurerCorruption: Math.round(corruption * 100) / 100, spyBuyer }
}

// ── 立场计算(引擎确定,LLM 只写台词) ─────────────────────────────────────────

function advisorWeights(script: CouncilScript, advisor: CouncilAdvisor, perturb: CouncilPerturb): Record<string, number> {
  const weights = { ...advisor.weights }
  if (advisor.id === 'treasurer' && perturb.treasurerCorruption > 0.45) weights.greed = 3
  if (advisor.id === 'spy') {
    if (perturb.spyBuyer === 'enemy') {
      weights.risk = 2
      weights.peace = -2
    } else if (perturb.spyBuyer === 'court') {
      weights.firm = 2
      weights.mercy = -1
    }
  }
  return weights
}

export function computeStance(script: CouncilScript, advisor: CouncilAdvisor, event: CouncilEvent, perturb: CouncilPerturb): string {
  const weights = advisorWeights(script, advisor, perturb)
  let bestOption = event.options[0]
  let bestScore = -Infinity
  for (const option of event.options) {
    let score = 0
    for (const tag of option.tags) score += weights[tag] ?? 0
    if (score > bestScore) {
      bestScore = score
      bestOption = option
    }
  }
  return bestOption.id
}

function advisorAgendaFact(script: CouncilScript, advisorId: string, perturb: CouncilPerturb): string | null {
  if (advisorId === 'spy') {
    if (perturb.spyBuyer === 'enemy') return F_SPY_ENEMY
    if (perturb.spyBuyer === 'court') return F_SPY_COURT
    return F_SPY_LOYAL
  }
  return script.advisors.find((a) => a.id === advisorId)?.agendaFact ?? null
}

// ── 事件抽取 ──────────────────────────────────────────────────────────────────

export function pickEvent(script: CouncilScript, state: CouncilState): CouncilEvent {
  for (const event of script.events) {
    if (state.season < event.seasonMin) continue
    if ((state.used[event.id] ?? 0) >= event.repeat) continue
    if (event.requires !== undefined && state.hidden[event.requires.hidden] < event.requires.min) continue
    return event
  }
  return script.events[0]
}

// ── 裁决(纯函数) ──────────────────────────────────────────────────────────────

const LATE_MULTIPLIER = 1.3

export interface DecideResult {
  text: string
  fallen?: boolean
  finished?: boolean
}

function applyDeltas(state: CouncilState, event: CouncilEvent, option: CouncilOption): { notes: string[]; fallen: boolean } {
  const mult = state.season >= 14 ? LATE_MULTIPLIER : 1
  const notes: string[] = []
  for (const [key, raw] of Object.entries(option.delta)) {
    const value = Math.round((raw as number) * mult * 10) / 10
    if (key === 'plague' || key === 'corruption' || key === 'threat' || key === 'famine') {
      state.hidden[key as HiddenKey] = Math.min(1, Math.max(0, state.hidden[key as HiddenKey] + value))
      notes.push(`${HIDDEN_LABEL[key as HiddenKey]} ${value >= 0 ? '+' : ''}${value}(模糊信号)`)
    } else {
      state.resources[key as ResourceKey] = Math.min(100, state.resources[key as ResourceKey] + value)
      notes.push(`${key === 'food' ? '粮' : key === 'gold' ? '金' : key === 'army' ? '军' : '民心'} ${value >= 0 ? '+' : ''}${value}`)
    }
  }
  notes.push(option.note)
  const fallen = state.decisions >= 4 && Object.values(state.resources).some((v) => v <= 0)
  return { notes, fallen }
}

function checkThresholds(script: CouncilScript, state: CouncilState): string[] {
  void script
  const lines: string[] = []
  const thresholds: Record<HiddenKey, { at: number; text: string; effect: Partial<Record<ResourceKey | HiddenKey, number>> }> = {
    plague: { at: 0.8, text: '瘟疫爆发!南郡十室九空。', effect: { loyalty: -10, food: -8 } },
    corruption: { at: 0.8, text: '贪腐案发,国库被蛀空一截!', effect: { gold: -8, loyalty: -4 } },
    threat: { at: 0.8, text: '边境战败,伏尔泰铁骑叩关!', effect: { army: -12, loyalty: -8 } },
    famine: { at: 0.8, text: '大饥荒席卷全国!', effect: { food: -10, loyalty: -10 } },
  }
  for (const [key, spec] of Object.entries(thresholds) as [HiddenKey, { at: number; text: string; effect: Partial<Record<ResourceKey | HiddenKey, number>> }][]) {
    if (!state.exploded.includes(key) && state.hidden[key] >= spec.at) {
      state.exploded.push(key)
      lines.push(`⚠ ${spec.text}`)
      for (const [rk, value] of Object.entries(spec.effect)) {
        if (rk === 'food' || rk === 'gold' || rk === 'army' || rk === 'loyalty') state.resources[rk as ResourceKey] = Math.min(100, state.resources[rk as ResourceKey] + (value as number))
        else state.hidden[rk as HiddenKey] = Math.min(1, Math.max(0, state.hidden[rk as HiddenKey] + (value as number)))
      }
    }
  }
  return lines
}

export function updateTrust(state: CouncilState, event: CouncilEvent, stances: Record<string, string>): string[] {
  const notes: string[] = []
  for (const [advisorId, stance] of Object.entries(stances)) {
    let delta = 0.02
    let verdict = '未置可否'
    if (stance === event.best) {
      delta = 0.15
      verdict = '主张被验证正确'
    } else if (stance === event.worst) {
      delta = -0.15
      verdict = '主张与结果相悖'
    }
    state.trust[advisorId] = Math.min(1, Math.max(0, (state.trust[advisorId] ?? 0.5) + delta))
    notes.push(`信任 ${advisorId}:${verdict}(${delta >= 0 ? '+' : ''}${delta})`)
  }
  return notes
}

/** 开启议会议程:确定本季事件与各顾问立场(引擎确定),返回事件卡。 */
export function openCouncil(script: CouncilScript, state: CouncilState): { event: CouncilEvent; stances: Record<string, string> } {
  const event = pickEvent(script, state)
  const stances: Record<string, string> = {}
  for (const advisor of script.advisors) {
    stances[advisor.id] = computeStance(script, advisor, event, state.perturb)
  }
  state.pending = { eventId: event.id, stances }
  return { event, stances }
}

/** 玩家决策:结算账本 + 信任更新 + 隐藏变量引爆 + 进入下一季。 */
export function decide(script: CouncilScript, state: CouncilState, optionId: string): DecideResult {
  if (state.pending === null) {
    return { text: '本季尚未开启议会。请先让主持人调用 council_consult。' }
  }
  const event = script.events.find((e) => e.id === state.pending?.eventId) ?? script.events[0]
  const option = event.options.find((o) => o.id === optionId)
  if (option === undefined) {
    return { text: `没有「${optionId}」这个选项。可选:${event.options.map((o) => `${o.id}(${o.label})`).join('、')}。` }
  }
  // 每季税赋(常态收入,难度越高越紧)
  const taxIncome = state.difficulty <= 1 ? 3 : state.difficulty === 2 ? 2 : 1
  state.resources.gold = Math.min(100, state.resources.gold + taxIncome)
  state.resources.food = Math.min(100, state.resources.food + 1)
  const incomeNotes = [`税赋入库:金 +${taxIncome} · 粮 +1`]
  const { notes, fallen } = applyDeltas(state, event, option)
  const trustNotes = updateTrust(state, event, state.pending.stances)
  const thresholdLines = checkThresholds(script, state)
  const allNotes = [...incomeNotes, ...notes, ...thresholdLines, ...trustNotes]
  state.decisions += 1
  if (option.id === event.best) state.bestChoices += 1
  state.history.push({ season: state.season, eventId: event.id, title: event.title, optionId: option.id, label: option.label, notes: allNotes })
  const fallenAfter = state.decisions >= 4 && Object.values(state.resources).some((v) => v <= 0)
  state.pending = null
  state.season += 1
  state.lastHidden = { ...state.hidden }
  state.turns += 1
  const lines = [`【第 ${state.season - 1} 季 · 结算】你选择了「${option.label}」。`]
  lines.push(...allNotes)
  if (fallenAfter) {
    state.phase = 'given_up'
    lines.push('', settleText(script, state))
    return { text: lines.join('\n'), fallen: true }
  }
  if (state.season > script.seasons) {
    state.phase = 'solved'
    lines.push('', settleText(script, state))
    return { text: lines.join('\n'), finished: true }
  }
  return { text: lines.join('\n') }
}

/** 调查:揭露顾问议程,或查看隐藏变量趋势(花 2 金)。 */
export function investigate(script: CouncilScript, state: CouncilState, target: string): string {
  if (state.pending === null) {
    return '本季尚未开启议会,无从调查。'
  }
  if (state.resources.gold < 2) {
    return '国库连 2 金的调查经费都拿不出了。'
  }
  const norm = target.trim()
  const advisor = script.advisors.find((a) => a.id === norm || a.name === norm || norm.includes(a.name) || norm.includes(a.role))
  if (advisor !== undefined) {
    state.resources.gold -= 2
    const factId = advisorAgendaFact(script, advisor.id, state.perturb)
    const fact = script.facts.find((f) => f.id === factId)
    state.turns += 1
    if (factId !== null && fact !== undefined && !state.exposed.includes(factId)) {
      state.exposed.push(factId)
      return `【调查 ${advisor.name}】你花 2 金暗中查访,查到了:` + fact.text
    }
    return `【调查 ${advisor.name}】未发现新的不轨之处。`
  }
  const hiddenKey = (Object.keys(HIDDEN_LABEL) as HiddenKey[]).find((k) => HIDDEN_LABEL[k].includes(norm) || norm.includes(HIDDEN_LABEL[k]) || norm.includes(k))
  if (hiddenKey !== undefined) {
    state.resources.gold -= 2
    state.turns += 1
    const current = state.hidden[hiddenKey]
    const prev = state.lastHidden[hiddenKey] ?? current
    const trend = Math.abs(current - prev) < 0.02 ? '平稳' : current > prev ? '在上升' : '在下降'
    return `【密报】${HIDDEN_LABEL[hiddenKey]}的趋势:${trend}。(模糊信号,无精确数字)`
  }
  return `调查对象不明。可查:${script.advisors.map((a) => a.name).join('、')},或 ${Object.values(HIDDEN_LABEL).join('、')}。`
}

// ── 计分与文案 ────────────────────────────────────────────────────────────────

export function councilScore(script: CouncilScript, state: CouncilState): ScoreBar[] {
  const fallen = Object.values(state.resources).some((v) => v <= 0)
  // 繁荣门槛:经济(金)与民生(粮/民心)齐头并进;军力不计入繁荣判定
  const prosper = state.resources.food >= 60 && state.resources.gold >= 40 && state.resources.loyalty >= 60
  const outcome = fallen ? 0 : prosper ? 100 : 60
  const outcomeNote = fallen ? '王国覆灭' : prosper ? '繁荣昌盛' : '勉力维持'
  const decisionQuality = state.decisions > 0 ? Math.round((state.bestChoices / state.decisions) * 100) : 0
  const peopleSkill = Math.min(100, state.exposed.length * 25)
  return [
    { label: '王国结局', value: outcome, note: `${outcomeNote}(第 ${Math.min(state.season, script.seasons)} 季)` },
    { label: '决策质量', value: decisionQuality, note: `${state.bestChoices}/${state.decisions} 次选择了最优方案` },
    { label: '识人准确度', value: peopleSkill, note: `已揭露 ${state.exposed.length}/${script.advisors.length} 名顾问的真实面目` },
  ]
}

function settleText(script: CouncilScript, state: CouncilState): string {
  const bars = councilScore(script, state)
  const exposedLines = state.exposed.map((id) => `- ${script.facts.find((f) => f.id === id)?.text ?? id}`)
  return `【王国议会 · 结算】${script.title}
${bars.map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

【终局账本】粮 ${state.resources.food} · 金 ${state.resources.gold} · 军 ${state.resources.army} · 民心 ${state.resources.loyalty}
【顾问真相】
${exposedLines.join('\n') || '(你没能看清任何人)'}

【历史决策】${state.history.map((h) => `第${h.season}季「${h.title}」→ ${h.label}`).join(';') || '(无)'}`
}

function scoreText(script: CouncilScript, state: CouncilState): string {
  return `【王国议会 · 当前进度】第 ${state.season}/${script.seasons} 季
粮 ${state.resources.food} · 金 ${state.resources.gold} · 军 ${state.resources.army} · 民心 ${state.resources.loyalty}

${councilScore(script, state).map((b) => `- ${b.label}:${b.value}(${b.note})`).join('\n')}

让主持人调用 council_consult 开启本季议会。`
}

function buildBrief(script: CouncilScript, state: CouncilState): string {
  const roster = script.advisors.map((a) => `- ${a.name}(${a.role})`).join('\n')
  return `【游戏开始:王国议会 · ${script.title}】(难度 ${state.difficulty}/3,共 ${script.seasons} 季)

现在你是本局的主持人(史官)。玩家是${script.kingdom}的新君,每季召开一次议会:四名顾问各怀心思地献策,玩家拍板,账本与结局承担后果。请遵守以下铁律:

1. 你【不知道顾问们的真实议程与隐藏变量】。议程真相只存于游戏引擎,不要暗示、不要剧透。
2. 每季流程必须经工具:
   - \`council_consult\` 开启议会:引擎确定本季事件与各顾问立场,返回事件卡;你按事件卡揭示本季议题;
   - \`council_speak\` 收集四名顾问的发言(引擎让每人按其立场与风格发言,台词过审计),你按顺序转述,不得替顾问加词;
   - \`council_question\` 玩家向某位顾问追问时,把原话传入,引擎返回该顾问的回应;
   - \`council_investigate\` 玩家花 2 金调查顾问或某个隐藏祸患(瘟疫/贪腐/外敌/饥荒)的趋势;
   - \`council_decide\` 玩家拍板(option 为选项 id):引擎结算账本、更新信任、引爆隐藏祸患、进入下一季;你只能按结算结果叙事,不得改账本。
3. 顾问的话可能半真半假——这是玩法,不是缺陷;你不得替玩家判断谁在说谎。
4. 玩家可以用 /ledger 看账本、/trust 看信任评级、/history 看历史决策、/hint 买提示、/game score 查进度、/game quit 结束看真相。

${script.intro}

【开局账本】粮 ${state.resources.food} · 金 ${state.resources.gold} · 军 ${state.resources.army} · 民心 ${state.resources.loyalty}

【四名重臣】
${roster}

用两三句史官口吻的开场白宣布新君即位、第一季议会即将召开,并等待玩家指令。`
}

function resumeBrief(script: CouncilScript, state: CouncilState): string {
  return `【继续游戏:王国议会 · ${script.title}】第 ${state.season}/${script.seasons} 季。账本:粮 ${state.resources.food} · 金 ${state.resources.gold} · 军 ${state.resources.army} · 民心 ${state.resources.loyalty}。你仍是主持人:不知道顾问议程与隐藏变量;每季经 council_consult / council_speak / council_question / council_investigate / council_decide 工具推进。请提醒玩家"我们继续"。`
}

// ── 顾问发言(LLM 台词,引擎立场) ─────────────────────────────────────────────

export function buildAdvisorSystem(script: CouncilScript, state: CouncilState, advisor: CouncilAdvisor, event: CouncilEvent, stanceId: string): string {
  const option = event.options.find((o) => o.id === stanceId) ?? event.options[0]
  const factId = advisorAgendaFact(script, advisor.id, state.perturb)
  const agenda = script.facts.find((f) => f.id === factId)
  const lines: string[] = []
  lines.push(`你在策略游戏《${script.title}》中扮演${script.kingdom}的${advisor.role}「${advisor.name}」。`)
  lines.push(`你的性格与说话风格:${advisor.persona}`)
  if (agenda !== undefined) lines.push(`【你的私心(绝不能承认,可用话术掩饰)】${agenda.text}`)
  lines.push(`你的说谎方式:${advisor.lieStyle}`)
  lines.push(`口吻样例:${advisor.voice}`)
  lines.push('')
  lines.push(`【本季议题】${event.title}:${event.prompt}`)
  lines.push(`【你的立场(引擎指定)】你主张选项「${option.label}」。请以你的身份与风格,为这个主张说一段话(2-4 句,可含神态),可以攻讦他人主张,但不要跳出角色、不要自爆私心。`)
  lines.push('对话要求:第一人称、口语化;被问到你领域外的事时,按你的风格含糊带过。')
  return lines.join('\n')
}

export async function speak(
  ctx: Context,
  sessionId: string,
  route: AgentRoute,
  script: CouncilScript,
  state: CouncilState,
  signal?: AbortSignal,
): Promise<{ lines: { advisorId: string; name: string; optionId: string; text: string; flagged: boolean }[] }> {
  if (state.pending === null) return { lines: [] }
  const event = script.events.find((e) => e.id === state.pending?.eventId) ?? script.events[0]
  const results = await Promise.all(
    script.advisors.map(async (advisor) => {
      const stanceId = state.pending?.stances[advisor.id] ?? event.best
      let text: string
      try {
        const out = await talkAsNpc(ctx, {
          sessionId,
          route,
          label: `npc:council:${advisor.id}`,
          system: buildAdvisorSystem(script, state, advisor, event, stanceId),
          user: `本季议题:${event.title}。请发言。`,
          history: (state.conversations[advisor.id] ?? []).slice(-6),
          maxTokens: 300,
          signal,
        })
        text = out.text
      } catch {
        text = `${advisor.name}捋了捋胡须,没有开口。`
      }
      const verdict = auditReply({ facts: script.facts, npc: script.npc }, advisor.id, text)
      if (verdict.flagged) {
        state.auditLog = [...(state.auditLog ?? []), { npcId: advisor.id, at: Date.now(), kind: 'slip', factIds: [...verdict.outOfScope, ...verdict.slipped], snippet: text }]
        text = sanitizedLine(advisor.name)
        return { advisorId: advisor.id, name: advisor.name, optionId: stanceId, text, flagged: true }
      }
      return { advisorId: advisor.id, name: advisor.name, optionId: stanceId, text, flagged: false }
    }),
  )
  return { lines: results }
}

export async function question(
  ctx: Context,
  sessionId: string,
  route: AgentRoute,
  script: CouncilScript,
  state: CouncilState,
  advisorId: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const advisor = script.advisors.find((a) => a.id === advisorId || a.name === advisorId)
  if (advisor === undefined) {
    return `没有这位重臣。可选:${script.advisors.map((a) => a.name).join('、')}。`
  }
  const event = state.pending !== null ? (script.events.find((e) => e.id === state.pending?.eventId) ?? script.events[0]) : script.events[0]
  const stanceId = state.pending?.stances[advisor.id] ?? event.best
  let reply: string
  try {
    const out = await talkAsNpc(ctx, {
      sessionId,
      route,
      label: `npc:council:${advisor.id}`,
      system: buildAdvisorSystem(script, state, advisor, event, stanceId),
      user: `玩家追问:${text}`,
      history: (state.conversations[advisor.id] ?? []).slice(-8),
      maxTokens: 300,
      signal,
    })
    reply = out.text
  } catch {
    reply = `${advisor.name}含糊地应了一声。`
  }
  const verdict = auditReply({ facts: script.facts, npc: script.npc }, advisor.id, reply)
  const flagged = verdict.flagged
  if (flagged) {
    state.auditLog = [...(state.auditLog ?? []), { npcId: advisor.id, at: Date.now(), kind: 'slip', factIds: [...verdict.outOfScope, ...verdict.slipped], snippet: reply }]
    reply = sanitizedLine(advisor.name)
  }
  state.conversations[advisor.id] = [
    ...(state.conversations[advisor.id] ?? []),
    { role: 'user' as const, text },
    { role: 'assistant' as const, text: reply },
  ].slice(-10)
  return flagged ? reply : `「${advisor.name}」:${reply}`
}

// ── 面板(/ledger /trust /history) ────────────────────────────────────────────

export type CouncilPanel = 'ledger' | 'trust' | 'history'

const TRUST_LABEL = (t: number): string => (t >= 0.75 ? '极可信' : t >= 0.55 ? '可靠' : t >= 0.35 ? '存疑' : '可疑')

export function panelText(script: CouncilScript, state: CouncilState, panel: CouncilPanel): string {
  switch (panel) {
    case 'ledger': {
      const lines = [
        `粮 ${state.resources.food} · 金 ${state.resources.gold} · 军 ${state.resources.army} · 民心 ${state.resources.loyalty}`,
        `(隐藏祸患只显示模糊趋势,不显示数字;花 2 金可调查)`,
      ]
      for (const key of ['plague', 'corruption', 'threat', 'famine'] as HiddenKey[]) {
        const prev = state.lastHidden[key] ?? state.hidden[key]
        const trend = Math.abs(state.hidden[key] - prev) < 0.02 ? '平稳' : state.hidden[key] > prev ? '↑ 上升' : '↓ 下降'
        lines.push(`- ${HIDDEN_LABEL[key]}:${trend}`)
      }
      return `【账本 · 第 ${state.season}/${script.seasons} 季】\n${lines.join('\n')}`
    }
    case 'trust': {
      const lines = script.advisors.map((a) => `- ${a.name}(${a.role}):${TRUST_LABEL(state.trust[a.id] ?? 0.5)}` + (state.exposed.some((id) => script.facts.find((f) => f.id === id)?.text.includes(a.name)) ? '(议程已揭露)' : ''))
      return `【信任评级】(引擎按主张与结果维护,仅供参考)\n${lines.join('\n')}`
    }
    case 'history': {
      const lines = state.history.map((h) => `- 第${h.season}季「${h.title}」→ ${h.label}(${h.notes.slice(0, 2).join(';')})`)
      return `【历史决策】\n${lines.join('\n') || '(暂无)'}`
    }
  }
}

// ── 引擎入口 ──────────────────────────────────────────────────────────────────

export const councilEngine: SchemeEngine = {
  id: 'council',
  label: '王国议会',
  async create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }> {
    const script = COUNCIL
    const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
    const now = Date.now()
    const trust: Record<string, number> = {}
    for (const advisor of script.advisors) trust[advisor.id] = 0.5
    const hidden: Record<HiddenKey, number> = { plague: 0.3, corruption: 0.35, threat: 0.4, famine: 0.2 }
    if (level === 3) {
      hidden.corruption = 0.55
      hidden.threat = 0.55
    }
    const state: CouncilState = {
      scheme: 'council',
      difficulty: level,
      startedAt: now,
      updatedAt: now,
      phase: 'playing' as GamePhase,
      turns: 0,
      hintsUsed: 0,
      score: null,
      season: 1,
      resources: initialResources(level),
      hidden,
      lastHidden: { ...hidden },
      trust,
      exposed: [],
      exploded: [],
      history: [],
      pending: null,
      used: {},
      perturb: makePerturb(hashString(sessionId), level),
      conversations: {},
      auditLog: [],
      decisions: 0,
      bestChoices: 0,
    }
    return { state, truth: script, brief: buildBrief(script, state) }
  },
  resumeBrief(state) {
    return resumeBrief(COUNCIL, state as CouncilState)
  },
  scoreText(state) {
    return scoreText(COUNCIL, state as CouncilState)
  },
  settleText(state, truth) {
    return settleText(truth as CouncilScript, state as CouncilState)
  },
  hint(state, truth) {
    const script = truth as CouncilScript
    const idx = Math.min((state as CouncilState).hintsUsed, script.hints.length - 1)
    return { text: `【提示 ${idx + 1}/${script.hints.length}】${script.hints[idx]}` }
  },
}

/** 经济模拟器:随机决策跑满 20 季,校验无 NaN、无死循环(回归测试用)。 */
export function simulate(seed: number, difficulty: number): { finished: boolean; fallen: boolean; season: number } {
  const rng = mulberry32(seed)
  const script = COUNCIL
  const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
  const trust: Record<string, number> = {}
  for (const advisor of script.advisors) trust[advisor.id] = 0.5
  const hidden: Record<HiddenKey, number> = { plague: 0.3, corruption: 0.35, threat: 0.4, famine: 0.2 }
  if (level === 3) {
    hidden.corruption = 0.55
    hidden.threat = 0.55
  }
  const state: CouncilState = {
    scheme: 'council',
    difficulty: level,
    startedAt: 0,
    updatedAt: 0,
    phase: 'playing',
    turns: 0,
    hintsUsed: 0,
    score: null,
    season: 1,
    resources: initialResources(level),
    hidden,
    lastHidden: { ...hidden },
    trust,
    exposed: [],
    exploded: [],
    history: [],
    pending: null,
    used: {},
    perturb: makePerturb(seed, level),
    conversations: {},
    auditLog: [],
    decisions: 0,
    bestChoices: 0,
  }
  let fallen = false
  let finished = false
  while (!fallen && !finished) {
    const { event } = openCouncil(script, state)
    const option = event.options[Math.floor(rng() * event.options.length)]
    const result = decide(script, state, option.id)
    if (result.fallen === true) fallen = true
    if (result.finished === true) finished = true
    if (state.season > script.seasons + 1) throw new Error('死循环')
  }
  return { finished, fallen, season: state.season }
}
