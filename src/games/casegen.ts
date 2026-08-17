/**
 * 程序化案件生成器(方案一·雾都谜案)。
 *
 * 设计目标(见 docs/01-detective.md §5.2 与 §7):
 *   - 先定事实,再写叙事:真相(事实图)由模板 + 种子随机数组装,生成后冻结;
 *   - 结构上保证可解:解法事实(motive/disposal/route)各由恰好一条关键线索揭示,
 *     每条关键线索拿走即不可解;每名非凶手嫌疑人都有明确排除证据(不在场证明);
 *   - 每条误导线索(红鲱鱼)指向的嫌疑人都有可洗清的证据;
 *   - 难度分级:1=4 嫌疑人/1 红鲱鱼,2=5 嫌疑人/2 红鲱鱼,3=6 嫌疑人/3 红鲱鱼。
 *
 * 生成是纯函数(同一种子 → 同一案件),因此可回归测试;是否采用交由上层求解器门禁。
 */

import type { CaseClue, CaseFact, DetectiveCase, NpcScript } from './detective.js'
import { hashString, mulberry32 } from '../core/rand.js'

// ── 确定性随机 ────────────────────────────────────────────────────────────────

export { hashString }

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ── 模板:手法(凶器 + 处置 + 进出路线 + 现场) ─────────────────────────────────

interface MeansTemplate {
  id: string
  /** 现场地点。 */
  scene: string
  /** 死状简述(进入 opening 与 victim.death)。 */
  deathBrief: string
  meansText: string
  opportunityText: string
  /** 凶器迹象事实 + 支持线索(现场)。 */
  weaponSign: { factId: string; factText: string; clue: { id: string; description: string } }
  /** 决定性事实 + 关键线索(处置地点)。 */
  disposal: { factId: string; factText: string; clue: { id: string; location: string; description: string } }
  /** 进出路线事实 + 线索。 */
  route: { factId: string; factText: string; clue: { id: string; location: string; description: string } }
  /** 凶手说谎策略专用句。 */
  lieTail: string
  /** 现场障眼法线索(红鲱鱼,无指向嫌疑人)。 */
  ambience: { id: string; description: string; redHerring: string }
  hint: string
}

const MEANS: MeansTemplate[] = [
  {
    id: 'poker-lake',
    scene: '书房',
    deathBrief: '头部遭钝击,门从内反锁,窗户也从内锁着——一间密室',
    meansText: '以壁炉火钳从背后钝击死者',
    opportunityText: '从书架后的暗门进出书房,作案后把火钳扔进湖里,再从走廊撞门制造密室假象',
    weaponSign: {
      factId: 'f_weapon',
      factText: '书房壁炉旁的火钳少了一根,石架上有新鲜划痕',
      clue: { id: 'e_weapon', description: '壁炉旁的火钳少了一根,石架上有新鲜的划痕,炉灰似被人拨动过。' },
    },
    disposal: {
      factId: 'f_disposal',
      factText: '凶器是壁炉火钳,被扔进了湖里',
      clue: {
        id: 'e_disposal',
        location: '湖边',
        description: '湖面冰层有一处破口,岸边泥地有一行脚印;打捞起一根火钳,柄上沾着暗色痕迹。',
      },
    },
    route: {
      factId: 'f_route',
      factText: '书房书架后有一道暗门通往屋外小径,门轴新近上过油',
      clue: {
        id: 'e_route',
        location: '书房',
        description: '书架后藏着一道暗门,通往屋外的小径;门轴新近上过油,把手被擦得很干净。',
      },
    },
    lieTail: '声称外套湿是下午擦窗弄的;听到异响才去书房,发现门反锁后撞门。绝口不提湖边与暗门。',
    ambience: {
      id: 'e_wet',
      description: '窗下地毯上有一小片湿痕,形状像鞋印;窗户本身从内锁着,完好无损。',
      redHerring: '湿痕指向"有人从窗户进出",其实是凶手从湖边回来时踩的障眼法',
    },
    hint: '书房不止一扇门。想想案发后谁"恰好"去过湖边。',
  },
  {
    id: 'poison-cup',
    scene: '书房',
    deathBrief: '伏在书桌上,口角有白沫,酒杯打翻在地',
    meansText: '把砒霜掺进死者的睡前酒',
    opportunityText: '趁晚宴混乱调换酒杯,再从未锁的窗户离开并把插销锁回',
    weaponSign: {
      factId: 'f_weapon',
      factText: '死者的酒杯被仔细洗过,杯底却残留一丝白色粉末',
      clue: { id: 'e_weapon', description: '书桌上的酒杯洗得异常干净,杯底却残留一丝白色粉末。' },
    },
    disposal: {
      factId: 'f_disposal',
      factText: '毒药是砒霜,空药瓶被藏在花园假山后',
      clue: {
        id: 'e_disposal',
        location: '花园',
        description: '假山石缝里塞着一个空药瓶,瓶底的粉末与酒杯里的残留一致,标签上的字被刮掉了。',
      },
    },
    route: {
      factId: 'f_route',
      factText: '书房窗户的插销被人做过手脚,可以从外面锁回',
      clue: {
        id: 'e_route',
        location: '书房',
        description: '窗台内侧有细小的撬痕,插销上缠着一小截鱼线——有人从外面把窗户重新锁上了。',
      },
    },
    lieTail: '声称碰过酒杯只是因为收拾餐具;绝口不提花园与那个药瓶。',
    ambience: {
      id: 'e_wet',
      description: '书桌下的地毯上有一小片湿痕,像是不小心泼洒又擦干的酒渍。',
      redHerring: '酒渍让人以为死者挣扎打翻酒杯,其实是凶手调包时留下的障眼法',
    },
    hint: '死得"太安静"了。看看他最后喝了什么,以及谁有机会碰那个杯子。',
  },
  {
    id: 'balcony-rope',
    scene: '阳台',
    deathBrief: '坠楼身亡,后脑有钝伤,阳台栏杆上留着抓痕',
    meansText: '将死者诱至阳台,从背后推下',
    opportunityText: '用绳索从楼顶速降到阳台作案,再攀绳离开',
    weaponSign: {
      factId: 'f_weapon',
      factText: '阳台石栏上有死者指甲的新鲜抓痕',
      clue: { id: 'e_weapon', description: '阳台石栏上有几道新鲜的抓痕,像是人坠下前挣扎时留下的。' },
    },
    disposal: {
      factId: 'f_disposal',
      factText: '楼顶水箱旁系着一条登山绳,另一端垂向阳台',
      clue: {
        id: 'e_disposal',
        location: '楼顶',
        description: '水箱的铁梯旁系着一条登山绳,绳头磨损,长度正好够到阳台;绳子上还缠着一片衣料纤维。',
      },
    },
    route: {
      factId: 'f_route',
      factText: '通往楼顶的门锁被撬开,又被重新挂好',
      clue: {
        id: 'e_route',
        location: '楼梯间',
        description: '通往楼顶的门锁上有新鲜的撬痕,插销被重新挂好,门把手上没有灰尘——最近有人上过楼顶。',
      },
    },
    lieTail: '声称从未上过楼顶,也没听说当晚有谁上去过。',
    ambience: {
      id: 'e_flower',
      description: '阳台角落的花盆被打翻,泥土撒了一地。',
      redHerring: '花盆像搏斗痕迹,其实是当晚被大风吹倒的障眼法',
    },
    hint: '凶手没走正门。看看高处——以及谁有机会从那里进出。',
  },
  {
    id: 'strangle-cord',
    scene: '书房',
    deathBrief: '颈部有勒痕,系被绳状物勒毙',
    meansText: '用书房窗帘的束绳从背后勒死死者',
    opportunityText: '死者主动开门让凶手进屋,作案后把绳头扔进锅炉烧掉',
    weaponSign: {
      factId: 'f_weapon',
      factText: '书房窗帘的束绳不翼而飞,断口整齐',
      clue: { id: 'e_weapon', description: '书房厚重的窗帘少了一根束绳,断口整齐,像是被利器割下的。' },
    },
    disposal: {
      factId: 'f_disposal',
      factText: '锅炉房的煤灰里有一截烧焦的绳头,与窗帘绳同色',
      clue: {
        id: 'e_disposal',
        location: '锅炉房',
        description: '锅炉房的煤灰里埋着一截烧焦的绳头,颜色与书房窗帘绳一致,还没有烧尽。',
      },
    },
    route: {
      factId: 'f_route',
      factText: '书房门锁完好没有撬痕,死者当晚只给熟人开门',
      clue: {
        id: 'e_route',
        location: '书房',
        description: '书房的门锁完好无损,没有撬痕——来者与死者相识,是死者主动开的门。',
      },
    },
    lieTail: '声称没去过书房,更没碰过锅炉。',
    ambience: {
      id: 'e_wet',
      description: '门边地毯上有一小片湿痕,像鞋印又不像。',
      redHerring: '湿痕让人以为凶手鞋底带水,其实是女仆傍晚拖地留下的障眼法',
    },
    hint: '门锁完好说明来者是熟人。熟人里,谁身上少了样东西、又多了样东西?',
  },
  {
    id: 'ice-dagger',
    scene: '书房',
    deathBrief: '后心有一处窄细的刺创,创口周围却没有凶器',
    meansText: '用冰锥刺入死者后心,冰锥融化后凶器消失',
    opportunityText: '从地窖取冰磨成冰锥,作案后任其融化在壁炉边',
    weaponSign: {
      factId: 'f_weapon',
      factText: '壁炉前有一小滩狭长的水渍,像是细长物融化留下的',
      clue: { id: 'e_weapon', description: '壁炉前有一小滩水渍,形状狭长,像是什么细长物融化后留下的。' },
    },
    disposal: {
      factId: 'f_disposal',
      factText: '地窖冰窖里的冰被人凿过,少了一块可磨成冰锥的冰',
      clue: {
        id: 'e_disposal',
        location: '地窖',
        description: '冰窖里的冰面有新鲜的凿痕,少了一块长条形的冰;墙边靠着一把还沾着冰碴的凿子。',
      },
    },
    route: {
      factId: 'f_route',
      factText: '死者书桌抽屉里的备用钥匙被人动过',
      clue: {
        id: 'e_route',
        location: '书房',
        description: '书桌抽屉里的备用钥匙摆放位置与死者的习惯不同,钥匙圈上还沾着一点冰水。',
      },
    },
    lieTail: '声称从未下过地窖,也没碰过书房的书桌。',
    ambience: {
      id: 'e_glass',
      description: '窗边有一小片碎玻璃,像是花瓶碎了。',
      redHerring: '碎玻璃让人以为有人破窗而入,其实是猫打翻花瓶的障眼法',
    },
    hint: '凶器凭空消失了?冰能杀人,也能自己消失。',
  },
]

// ── 模板:动机(秘密事实 + 证据线索 + 认罪短语) ────────────────────────────────

interface MotiveTemplate {
  id: string
  motiveText: string
  fact: { id: string; text: string }
  clue: { id: string; location: string; description: string }
  confession: string
  hint: string
  /** 该动机与哪些嫌疑人原型相配(空 = 任意);防止"年轻继承人当过二十年前银行职员"这类违和。 */
  fits?: string[]
}

const MOTIVES: MotiveTemplate[] = [
  {
    id: 'hidden-identity',
    motiveText: '死者发现凶手就是多年前卷款潜逃的旧案罪犯,打算将其揭发',
    fact: { id: 'f_motive', text: '凶手年轻时曾卷款潜逃,死者最近查到了这条旧案,掌握着关键证据' },
    clue: {
      id: 'e_motive',
      location: '书房',
      description: '死者书桌暗格里有一封二十年前的旧信,提到一名职员卷款潜逃,还附着一张年轻职员的合影。',
    },
    confession: '承认自己就是当年卷款潜逃的旧案罪犯',
    hint: '动机藏在死者的私人文件里——去书房翻一翻,查查每个人的过去。',
    fits: ['butler', 'partner', 'guest', 'doctor', 'writer', 'gardener'],
  },
  {
    id: 'inheritance',
    motiveText: '死者已改写遗嘱,将凶手应得的遗产份额全部取消',
    fact: { id: 'f_motive', text: '死者上周改写了遗嘱,把凶手的继承份额整段划去' },
    clue: {
      id: 'e_motive',
      location: '卧室',
      description: '保险柜里放着新遗嘱的副本,落款是上周,其中一人的继承份额被整段划去。',
    },
    confession: '承认自己因遗产被夺而怀恨在心',
    hint: '钱会让人动杀心。去卧室看看死者的身后安排。',
    fits: ['heir', 'partner', 'guest'],
  },
  {
    id: 'revenge',
    motiveText: '死者当年害死了凶手唯一的亲人,凶手改名换姓潜伏多年只为复仇',
    fact: { id: 'f_motive', text: '凶手唯一的亲人当年因死者的背叛而死,凶手为此改名换姓接近死者' },
    clue: {
      id: 'e_motive',
      location: '卧室',
      description: '一只旧皮箱的夹层里有一张泛黄的合影与剪报,照片上是少年时的某人,与死者的旧识面容相似。',
    },
    confession: '承认自己潜伏多年,就是为了让死者偿命',
    hint: '仇恨是长线的。查一查每个人的来历,也许有人根本不是现在的名字。',
  },
  {
    id: 'blackmail',
    motiveText: '死者长期勒索凶手,凶手已到绝路',
    fact: { id: 'f_motive', text: '死者长期以旧把柄勒索凶手,账目记在私人日记里' },
    clue: {
      id: 'e_motive',
      location: '书房',
      description: '死者日记的夹页里记着多年的勒索账目,收款人代号指向某一位相关人士。',
    },
    confession: '承认自己被勒索多年,走投无路',
    hint: '有人欠死者的不止是钱。看看死者日记里记的账。',
  },
  {
    id: 'jealousy',
    motiveText: '凶手发现死者与自己最亲近的人有私情,妒火中烧',
    fact: { id: 'f_motive', text: '凶手最近发现死者与自己最亲近的人有私情' },
    clue: {
      id: 'e_motive',
      location: '卧室',
      description: '死者怀表里藏着一张小照,是死者与一位相关人士至亲的合影,背面写着情话。',
    },
    confession: '承认自己因妒恨而杀人',
    hint: '感情纠纷最容易失控。检查死者的贴身之物。',
    fits: ['heir', 'writer', 'partner', 'guest', 'doctor'],
  },
]

// ── 模板:嫌疑人原型 ───────────────────────────────────────────────────────────

interface Archetype {
  id: string
  role: string
  names: string[]
  gender: 'm' | 'f'
  bio: (name: string) => string
  persona: string
}

const ARCHETYPES: Archetype[] = [
  {
    id: 'butler',
    role: '管家',
    names: ['周叔', '福伯', '老彭'],
    gender: 'm',
    bio: (n) => `${n}是府里服侍多年的老管家,沉稳寡言,今晚负责晚宴服侍。`,
    persona: '老派管家,措辞恭敬而缓慢;被逼问时眼神会不自觉地躲闪。',
  },
  {
    id: 'heir',
    role: '继承人',
    names: ['沈佩兰', '顾清和', '陆明薇'],
    gender: 'f',
    bio: (n) => `${n}是死者的继承人,最近因家产分配与死者多次争吵。`,
    persona: '大小姐脾气,紧张时语速变快,手指绞着衣角。',
  },
  {
    id: 'doctor',
    role: '家庭医生',
    names: ['白修远', '秦砚秋', '姜述怀'],
    gender: 'm',
    bio: (n) => `${n}是死者的家庭医生,每周来两次为死者检查身体,今晚留宿。`,
    persona: '冷静克制,满口医学术语,对时间点很敏感。',
  },
  {
    id: 'writer',
    role: '远亲(作家)',
    names: ['楚云舒', '苏晚晴', '江采苹'],
    gender: 'f',
    bio: (n) => `${n}是死者的远房表亲,小说家,为采风暂住府上,案发时在沙龙写作。`,
    persona: '观察力强,语带机锋,喜欢复述别人话里的矛盾。',
  },
  {
    id: 'gardener',
    role: '园丁',
    names: ['老赵', '阿贵', '石伯'],
    gender: 'm',
    bio: (n) => `${n}负责温室与庭院,沉默寡言。`,
    persona: '沉默寡言,有戒心,被冤枉时会突然激动。',
  },
  {
    id: 'partner',
    role: '生意伙伴',
    names: ['马元龙', '郑伯衡', '韩世昌'],
    gender: 'm',
    bio: (n) => `${n}是死者的生意合伙人,近日因账目问题与死者不欢而散,今晚却登门拜访。`,
    persona: '商人做派,说话滴水不漏,喜欢反问。',
  },
  {
    id: 'guest',
    role: '多年老友',
    names: ['方砚秋', '杜若飞', '罗文轩'],
    gender: 'm',
    bio: (n) => `${n}是死者多年的老友,专程前来小住叙旧。`,
    persona: '温和圆滑,爱打哈哈,被追问时顾左右而言他。',
  },
]

const VICTIM_NAMES = ['沈伯年', '顾维桢', '陆绍棠', '贺云台', '温庭兰']

interface Setting {
  era: string
  place: string
  season: string
}

const SETTINGS: Setting[] = [
  { era: '1920 年代的伦敦郊外', place: '雾谷庄园', season: '冬夜,大雪封路' },
  { era: '民国十七年的上海', place: '沈公馆', season: '梅雨季,连绵阴雨' },
  { era: '九十年代的海滨小城', place: '听潮别墅', season: '台风夜,暴雨如注' },
  { era: '深冬的北方', place: '雪松山庄', season: '暴雪封山' },
]

// ── 模板:不在场证明(排除证据) ────────────────────────────────────────────────

interface AlibiTemplate {
  place: string
  activity: string
  witness: string
  /** 适用性别(空 = 任意);用于避免"大小姐在柴房劈柴"这类违和。 */
  genders?: ('m' | 'f')[]
}

const ALIBIS: AlibiTemplate[] = [
  { place: '客厅', activity: '与众人玩牌', witness: '女仆' },
  { place: '温室', activity: '侍弄花草', witness: '厨娘' },
  { place: '厨房', activity: '帮忙准备夜宵', witness: '厨娘' },
  { place: '沙龙', activity: '独自写作', witness: '女仆' },
  { place: '柴房', activity: '劈柴', witness: '门房', genders: ['m'] },
  { place: '客房', activity: '整理药箱', witness: '女仆' },
]

// ── 模板:红鲱鱼秘密(非凶手嫌疑人隐瞒的事,与命案无关但有罪感) ──────────────────

interface SecretTemplate {
  id: string
  fact: (name: string) => string
  clue: { location: string; description: (name: string) => string }
  liePolicy: string
}

const SECRETS: SecretTemplate[] = [
  {
    id: 'burned-letter',
    fact: (n) => `${n}在温室烧掉了一封写给死者的信`,
    clue: { location: '温室', description: (n) => `炭盆里有烧剩的纸角,隐约可辨"抱歉"二字——${n}说只是烧了些废纸。` },
    liePolicy: '先否认烧过任何东西;被纸灰证据戳穿后改口"只是烧了自己的私信,与命案无关"。',
  },
  {
    id: 'past-record',
    fact: (n) => `${n}年轻时坐过牢,一直瞒着所有人`,
    clue: { location: '卧室', description: (n) => `客房床底压着一份旧报纸,上面是一则旧案报道,照片与年轻时的${n}有几分相像。` },
    liePolicy: '绝口不提自己的过去;被旧报纸戳穿后承认坐过牢,但咬定"那都是二十年前的事了"。',
  },
  {
    id: 'quarrel',
    fact: (n) => `${n}案发当天下午与死者激烈争吵`,
    clue: { location: '门厅', description: (n) => `门房作证:案发当天下午,书房里传出${n}与死者的争吵声,最后${n}摔门而去。` },
    liePolicy: '先轻描淡写"只是谈了谈家事";被门房证词戳穿后承认吵过架,但坚持"吵完我就走了,再没见过他"。',
  },
  {
    id: 'visited-scene',
    fact: (n) => `${n}案发当天傍晚到过书房门口,鬼鬼祟祟`,
    clue: { location: '走廊', description: (n) => `走廊转角的花瓶被挪动过,女仆说案发当天傍晚看见${n}在书房门口徘徊,神色慌张。` },
    liePolicy: '先声称整天没靠近过书房;被女仆证词戳穿后改口"只是路过,听见没动静就走了"。',
  },
  {
    id: 'debt',
    fact: (n) => `${n}欠下巨额赌债,债主已经上门催过两次`,
    clue: { location: '卧室', description: (n) => `客房行李里有一叠借据与债主的催债信,日期就在案发前一周。` },
    liePolicy: '矢口否认欠债;被借据戳穿后承认手头紧,但辩解"欠债不等于杀人"。',
  },
]

// ── 组装 ──────────────────────────────────────────────────────────────────────

interface CaseOptions {
  seed: number
  difficulty: number
}

export function generateCase(seed: number, difficulty: number): DetectiveCase {
  const level = difficulty >= 1 && difficulty <= 3 ? difficulty : 2
  const rng = mulberry32(seed)
  const suspectCount = 3 + level // 4 / 5 / 6
  const redHerringCount = level // 1 / 2 / 3

  const means = pick(rng, MEANS)
  const setting = pick(rng, SETTINGS)
  const victimName = pick(rng, VICTIM_NAMES)

  // 嫌疑人原型(打乱后取足数量,原型不同名池不同,姓名天然不撞)
  const chosen = shuffle(rng, ARCHETYPES).slice(0, suspectCount)
  const usedNames = new Set<string>([victimName])
  const suspectNames: string[] = []
  for (const arch of chosen) {
    const name = arch.names.find((n) => !usedNames.has(n)) ?? arch.names[0]
    usedNames.add(name)
    suspectNames.push(name)
  }
  const suspects = chosen.map((arch, i) => ({
    id: `s_${arch.id}`,
    name: suspectNames[i],
    role: arch.role,
    bio: arch.bio(suspectNames[i]),
  }))

  // 凶手(先定凶手,再按凶手原型筛动机,防止人设违和)
  const murdererIndex = Math.floor(rng() * suspectCount)
  const murderer = suspects[murdererIndex]
  const fitMotives = MOTIVES.filter((m) => !m.fits || m.fits.includes(chosen[murdererIndex].id))
  const motive = pick(rng, fitMotives.length > 0 ? fitMotives : MOTIVES)

  // 事实与线索收集器
  const facts: CaseFact[] = []
  const clues: CaseClue[] = []
  const addFact = (f: CaseFact): string => {
    facts.push(f)
    return f.id
  }
  const addClue = (c: CaseClue): string => {
    clues.push(c)
    return c.id
  }

  // 手段三事实(凶器迹象 / 决定性 / 路线)+ 现场线索
  const weaponFactId = addFact({ id: means.weaponSign.factId, type: 'physical', text: means.weaponSign.factText })
  addClue({ id: means.weaponSign.clue.id, location: means.scene, description: means.weaponSign.clue.description, reveals: [weaponFactId] })
  const disposalFactId = addFact({ id: means.disposal.factId, type: 'physical', text: means.disposal.factText })
  addClue({ id: means.disposal.clue.id, location: means.disposal.clue.location, description: means.disposal.clue.description, reveals: [disposalFactId] })
  const routeFactId = addFact({ id: means.route.factId, type: 'physical', text: means.route.factText })
  addClue({ id: means.route.clue.id, location: means.route.clue.location, description: means.route.clue.description, reveals: [routeFactId] })
  // 死亡时间事实
  const timeFactId = addFact({ id: 'f_time', type: 'timeline', text: '死亡时间约 21:47,由死者的怀表确定' })
  addClue({ id: 'e_clock', location: means.scene, description: '死者的怀表摔碎在地,指针停在 21:47。', reveals: [timeFactId] })
  // 现场障眼法
  addClue({
    id: means.ambience.id,
    location: means.scene,
    description: means.ambience.description,
    reveals: [],
    redHerring: means.ambience.redHerring,
  })

  // 动机事实 + 关键证据线索
  const motiveFactId = addFact({ id: motive.fact.id, type: 'motive', text: motive.fact.text })
  addClue({ id: motive.clue.id, location: motive.clue.location, description: motive.clue.description, reveals: [motiveFactId] })

  // 每名非凶手嫌疑人:不在场证明(排除证据)+ 可选红鲱鱼秘密
  const redHerringPool = shuffle(rng, SECRETS)
  const alibiPool = shuffle(rng, ALIBIS)
  const usedAlibiPlaces = new Set<string>()
  const pickAlibi = (gender: 'm' | 'f'): AlibiTemplate =>
    alibiPool.find((a) => !usedAlibiPlaces.has(a.place) && (a.genders === undefined || a.genders.includes(gender))) ??
    alibiPool.find((a) => !usedAlibiPlaces.has(a.place)) ??
    alibiPool[0]
  const npc: Record<string, NpcScript> = {}
  let secretIdx = 0
  for (let i = 0; i < suspects.length; i++) {
    const suspect = suspects[i]
    if (suspect.id === murderer.id) continue
    const arch = chosen[i]
    const isRedHerring = secretIdx < redHerringCount
    const alibi = pickAlibi(arch.gender)
    usedAlibiPlaces.add(alibi.place)
    const alibiFactId = addFact({
      id: `f_alibi_${suspect.id}`,
      type: 'timeline',
      text: `${suspect.name}案发时间段(21:40-22:00)一直在${alibi.place}${alibi.activity}`,
      excludes: [suspect.id],
    })
    addClue({
      id: `e_alibi_${suspect.id}`,
      location: alibi.place,
      description: `${alibi.witness}作证:案发当晚 21:40 到 22:00,${suspect.name}一直在${alibi.place}${alibi.activity}。`,
      reveals: [alibiFactId],
    })
    if (isRedHerring) {
      const secret = redHerringPool[secretIdx]
      secretIdx += 1
      const secretFactId = addFact({ id: `f_secret_${suspect.id}`, type: 'testimony', text: secret.fact(suspect.name) })
      addClue({
        id: `e_secret_${suspect.id}`,
        location: secret.clue.location,
        description: secret.clue.description(suspect.name),
        reveals: [secretFactId],
        misleadsTo: [suspect.id],
      })
      npc[suspect.id] = {
        persona: arch.persona,
        knowledge: [secretFactId, alibiFactId],
        mustNotAdmit: [secretFactId],
        liePolicy: `${secret.liePolicy}`,
      }
    } else {
      npc[suspect.id] = {
        persona: arch.persona,
        knowledge: [alibiFactId],
        mustNotAdmit: [],
        liePolicy: '基本如实回答,只是话不多;对没有把握的推测不置可否。',
      }
    }
  }

  // 凶手脚本(凶器迹象是现场可见信息,不列入"必须隐瞒";动机/处置/路线是核心秘密)
  const murdererAlibi = pickAlibi(chosen[murdererIndex].gender)
  npc[murderer.id] = {
    persona: chosen[murdererIndex].persona,
    knowledge: [motiveFactId, weaponFactId, disposalFactId, routeFactId],
    mustNotAdmit: [motiveFactId, disposalFactId, routeFactId],
    liePolicy: `声称案发时间段一直在${murdererAlibi.place}${murdererAlibi.activity}。${means.lieTail}`,
    guilt: `你杀了${victimName}:${means.meansText}。${means.opportunityText}。你必须伪装无辜。`,
    collapse: `当玩家出示关键铁证后,你崩溃并部分认罪:${motive.confession},但辩称"是他先逼我的"。`,
  }

  // 关键线索:动机证据 + 决定性线索(+ 路线线索,难度 2 以上)
  const keyClueIds = [motive.clue.id, means.disposal.clue.id]
  const solutionFactIds = [motiveFactId, disposalFactId]
  if (level >= 2) {
    keyClueIds.push(means.route.clue.id)
    solutionFactIds.push(routeFactId)
  }

  // 地点表:按出现顺序去重
  const locations: string[] = []
  const seen = new Set<string>()
  const pushLoc = (loc: string): void => {
    if (!seen.has(loc)) {
      seen.add(loc)
      locations.push(loc)
    }
  }
  pushLoc(means.scene)
  for (const c of clues) pushLoc(c.location)

  const suspectList = suspects.map((s) => `${s.name}(${s.role})`).join('、')
  const opening = `${setting.place}的主人${victimName}被发现死在${means.scene}:${means.deathBrief}。死亡时间约在 21:40 至 22:00。你是应邀而来的侦探,${setting.place}内有 ${suspects.length} 名相关人士:${suspectList}。`

  return {
    caseId: `gen-${seed}-d${level}`,
    title: setting.place,
    difficulty: level,
    setting: `${setting.era},${setting.place},${setting.season}。`,
    opening,
    victim: { name: victimName, role: `${setting.place}主人`, death: `${means.deathBrief},约 21:47` },
    locations,
    suspects,
    murderer: murderer.id,
    solution: { means: means.meansText, motive: motive.motiveText, opportunity: means.opportunityText },
    facts,
    clues,
    keyClueIds,
    solutionFactIds,
    npc,
    hints: [
      '把每个人的不在场证明对齐死亡时间(21:40-22:00),证词之间、证词与物证之间必有出入。',
      means.hint,
      motive.hint,
    ],
  }
}
