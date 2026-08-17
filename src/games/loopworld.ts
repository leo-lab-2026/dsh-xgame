/**
 * 时间循环程序化时间表生成(方案五 M4,docs/05-time-loop.md §7.2)。
 *
 * 与 loopgen.ts(骨架 × 皮肤换名)不同:这里生成**新因果拓扑**——
 * 2 套场景(望海灯塔/黑石矿镇)× 3 种悲剧因果链形状:
 *  - wreck(事故/灾变):主线"事实+道具"、副线"深查链(先知道才拿得到)"双独立边;
 *  - collapse(崩塌/灾变):两线并进,每条边都是"直接观测事实 + 直接拾取道具";
 *  - poison(命案):链式前置——切断第一边的行动产出的事实,是切断第二边的知识门槛。
 *
 * 全部为纯函数、种子确定性;每个生成物都必须通过 ScheduleSolver(solveLoop)
 * 硬门禁才会进入剧本池;求解器返回的排程计划可供测试回放黄金路径。
 */

import type { LoopScript, LoopEvent, LoopAction, LoopNpc } from './loop.js'
import type { CaseFact, NpcScript } from './detective.js'

const SLICES = 8
const SLICE_NAMES = ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']

// ── 场景包(结构 + 人名单池) ───────────────────────────────────────────────────

interface NpcTemplate {
  id: string
  names: [string, string]
  role: string
  bio: string
  home: string
  roam?: { slice: number; location: string }
  actions: string[]
}

interface WorldSetting {
  id: string
  title: string
  locations: { id: string; name: string; desc: string }[]
  npcs: NpcTemplate[]
}

const HARBOR: WorldSetting = {
  id: 'harbor',
  title: '望海灯塔',
  locations: [
    { id: 'dock', name: '码头栈桥', desc: '灯塔脚下的码头栈桥,缆桩上缠着粗麻绳,浪头一下下拍着礁石。' },
    { id: 'store', name: '灯塔仓库', desc: '堆满油桶与备件的仓库,墙角立着工具架,空气里有股机油味。' },
    { id: 'tower', name: '灯塔顶端', desc: '灯塔顶端,巨大的灯盏与绞盘静静立着,从这里能望见整片海湾。' },
    { id: 'plaza', name: '港务广场', desc: '港务广场,旗杆高耸,巡港卫队每天傍晚列队经过。' },
  ],
  npcs: [
    {
      id: 'n_keeper',
      names: ['老岑', '岑伯'],
      role: '守塔人',
      bio: '守了三十年灯塔的老人,烟斗不离手,对塔上每一颗铆钉都了如指掌。',
      home: 'tower',
      actions: ['擦拭灯盏', '眺望海面', '给绞盘上油', '抽烟斗', '记录灯位', '擦灯盏', '望海', '哼小调'],
    },
    {
      id: 'n_bosun',
      names: ['阿海', '海爷'],
      role: '货轮大副',
      bio: '常驻港口的货轮大副,近来总往仓库跑,见了人就堆笑。',
      home: 'dock',
      actions: ['清点货物', '指挥卸货', '在仓库进进出出', '核对货单', '系缆绳', '清点货物', '张罗接风宴', '宴席上劝酒'],
    },
    {
      id: 'n_officer',
      names: ['卫队长', '老耿'],
      role: '巡港卫队长',
      bio: '巡港卫队长,嗓门大,办案只认白纸黑字的证据。',
      home: 'plaza',
      roam: { slice: 5, location: 'dock' },
      actions: ['巡港', '巡港', '查货单', '巡港', '张贴告示', '巡港', '巡港', '吹集合哨'],
    },
  ],
}

const MINE: WorldSetting = {
  id: 'mine',
  title: '黑石矿镇',
  locations: [
    { id: 'shaft', name: '矿洞口', desc: '黑石矿的矿洞口,支护木梁吱呀作响,洞内黑黢黢不见底。' },
    { id: 'winch', name: '绞盘房', desc: '绞盘房,铁链与绞盘静静停着,墙上挂着一排工具。' },
    { id: 'ridge', name: '后山山脊', desc: '矿镇后的山脊,能俯瞰整个矿区,山风猎猎。' },
    { id: 'camp', name: '矿工营地', desc: '矿工营地,帐篷连片,巡检员每天傍晚经过这里。' },
  ],
  npcs: [
    {
      id: 'n_miner',
      names: ['老石', '石叔'],
      role: '老矿工',
      bio: '在矿里干了三十年的老矿工,每一根梁木的脾气他都门儿清。',
      home: 'shaft',
      actions: ['敲敲梁木', '推矿车', '抽烟歇脚', '检查支护', '擦矿灯', '敲梁木', '念叨矿洞', '哼山歌'],
    },
    {
      id: 'n_owner',
      names: ['石矿主', '石老板'],
      role: '矿主',
      bio: '黑石矿矿主,近来急于出矿,对巡检的事遮遮掩掩。',
      home: 'winch',
      actions: ['拨算盘', '催促出货', '翻账本', '训斥工头', '盯着绞盘', '拨算盘', '摆接风酒', '席间劝酒'],
    },
    {
      id: 'n_inspector',
      names: ['巡检员', '老韩'],
      role: '巡检员',
      bio: '矿区巡检员,一丝不苟,本子从不离手。',
      home: 'camp',
      roam: { slice: 5, location: 'shaft' },
      actions: ['记巡检日志', '查矿灯', '量支护', '查通风扇', '写报告', '巡矿', '巡矿', '吹哨集合'],
    },
  ],
}

const SETTINGS: WorldSetting[] = [HARBOR, MINE]

/** 按种子取第 i 位(0/1)决定 NPC 用名池里的哪个名字。 */
function bit(seed: number, i: number): number {
  return Math.floor(Math.abs(seed) / 2 ** i) % 2
}

function buildNpcs(s: WorldSetting, seed: number): LoopNpc[] {
  return s.npcs.map((tpl, i) => {
    const name = tpl.names[bit(seed, i)]
    return {
      id: tpl.id,
      name,
      role: tpl.role,
      bio: tpl.bio,
      schedule: Array.from({ length: SLICES }, (_, slice) => ({
        slice,
        location: tpl.roam?.slice === slice ? tpl.roam.location : tpl.home,
        action: tpl.actions[slice % tpl.actions.length] ?? tpl.role,
      })),
    }
  })
}

function fact(id: string, type: CaseFact['type'], text: string, auditKeywords?: string[]): CaseFact {
  return auditKeywords === undefined ? { id, type, text } : { id, type, text, auditKeywords }
}

// ── 因果链形状 1:事故(主线事实+道具 / 副线深查链) ────────────────────────────

interface WreckWords {
  intro: string
  tragedyName: string
  collapseText: string
  lockedText: string
  winText: string
  fA: string
  fAKeywords: string[]
  e1Name: string
  e1Observe: string
  e2Name: string
  e2Observe: string
  e2Target: string
  e2Investigate: string
  toolName: string
  toolDesc: string
  e3Name: string
  e3Observe: string
  fB: string
  fBKeywords: string[]
  e4Name: string
  e4Observe: string
  e4Target: string
  e4Investigate: string
  fC: string
  a1Name: string
  a1Keywords: string[]
  a1Text: string
  a2Name: string
  a2Keywords: string[]
  a2Text: string
  edgeMain: string
  edgeRescue: string
  npcKnowledge: [string[], string[], string[]]
  npcLiePolicy: [string, string, string]
}

const WRECK_WORDS: Record<'harbor' | 'mine', WreckWords> = {
  harbor: {
    intro: '你是借宿灯塔的旅人。今晚,一场风暴将扑向海湾——主缆崩断、驳船倾覆,五名卸货工落海,三名守夜人被断缆砸中。而你记得明天。',
    tragedyName: '断缆之夜',
    collapseText: '19:00,风暴扑来,一声闷响——主缆崩断,缆桩飞起,泊在栈桥边的驳船倾覆,卸货工们落进浪里。',
    lockedText: '断缆扫过灯塔,灯盏熄灭,三个守夜人被砸在塔顶,再没人能发出求救信号。',
    winText: '【19:00 · 完美一日】风暴如期而至,主缆却纹丝不动;你把记录亮给众人,卫队长吹响集合哨——港口封停,无人出海。这一夜,无人遇难。',
    fA: '码头主缆已经断了两股,夜里风浪一大就会崩断。',
    fAKeywords: ['主缆', '断了两股', '崩断', '风浪'],
    e1Name: '绷断的主缆',
    e1Observe: '栈桥边的主缆断了两股,缆桩被拽得吱呀作响——夜里风浪一大,它就会崩断。',
    e2Name: '工具架',
    e2Observe: '仓库的墙边立着一只工具架,上面挂着缆钳。',
    e2Target: '工具架',
    e2Investigate: '你从工具架上取下一把缆钳——用它能把断股重新绞紧。',
    toolName: '缆钳',
    toolDesc: '一把沉甸甸的缆钳。',
    e3Name: '涂改的检修记录',
    e3Observe: '守塔人把一本检修记录塞进抽屉,几页被撕掉重写——三个月来,主缆一次都没检修过。',
    fB: '守塔人手里的检修记录被涂改过,主缆三个月没检修。',
    fBKeywords: ['检修记录', '涂改', '三个月', '没检修'],
    e4Name: '上锁的木箱',
    e4Observe: '广场公告栏背后靠着一只上锁的木箱,箱角有被撬过的痕迹。',
    e4Target: '木箱',
    e4Investigate: '你撬开木箱:里面是另一本没被涂改的记录——主缆早该更换,报修单却被港务官压下了。',
    fC: '另一本检修记录:主缆早该更换,报修单被港务官压下了。',
    a1Name: '用缆钳绞紧主缆',
    a1Keywords: ['缆钳', '绞紧', '主缆', '修', '加固'],
    a1Text: '你用缆钳把断股重新绞紧,又缠上麻绳——风暴再大,这根主缆也崩不断了。',
    a2Name: '把检修记录交给卫队长',
    a2Keywords: ['记录', '卫队长', '交', '报', '揭'],
    a2Text: '卫队长看完两本记录,脸色铁青:"封港!全港船只回泊!"驳船撤空,守夜人全部下塔。',
    edgeMain: '主缆断裂 + 风暴 → 驳船倾覆、卸货工落海',
    edgeRescue: '无人报修 + 灯塔失联 → 守夜人被困塔顶遇难',
    npcKnowledge: [['f_a', 'f_b'], ['f_a'], []],
    npcLiePolicy: ['如实相告,但不愿多谈报修。', '矢口否认与主缆有关,把检修记录说成"例行公事"。', '公事公办,只认证据。'],
  },
  mine: {
    intro: '你是矿上借宿的过客。今晚,一场地动将震塌矿洞——承重矿柱断裂,五名矿工被埋,三名夜班工被困在风井里。而你记得明天。',
    tragedyName: '塌方之前',
    collapseText: '19:00,地动传来,一声脆响——承重矿柱断裂,矿道轰然塌落,作业队被埋在了深处。',
    lockedText: '塌方堵死了风井,三个夜班工被困在井底,再没人知道他们还活着。',
    winText: '【19:00 · 完美一日】地动如期而至,矿柱却纹丝不动;你把巡检本子亮给众人,巡检员吹响哨子——矿洞清空,风井畅通。这一夜,无人遇难。',
    fA: '洞口那根承重矿柱裂到了根,再受一次震动就会崩断。',
    fAKeywords: ['矿柱', '裂', '崩断', '震动'],
    e1Name: '开裂的矿柱',
    e1Observe: '洞口那根承重矿柱裂到了根,裂缝里能塞进一个拳头——再受一次震动,它就会崩断。',
    e2Name: '工具墙',
    e2Observe: '绞盘房的墙上挂着一排工具,最上层放着木楔和锤子。',
    e2Target: '工具墙',
    e2Investigate: '你从墙上取下一把木楔和锤子——用它们能把开裂的矿柱重新撑紧。',
    toolName: '木楔',
    toolDesc: '一把削好的硬木楔。',
    e3Name: '撕毁的巡检单',
    e3Observe: '矿主蹲在山脊背风处,把一沓巡检单塞进火堆,灰里还剩半张。',
    fB: '矿主在山脊烧毁了巡检单——三个月来,矿柱一次都没查过。',
    fBKeywords: ['巡检单', '烧', '三个月', '没查'],
    e4Name: '锁着的柜子',
    e4Observe: '营地里巡检员的铁皮柜锁着,锁孔里有新划痕。',
    e4Target: '柜子',
    e4Investigate: '你撬开铁皮柜:里面是巡检员的本子——那根矿柱三个月前就该换了,换柱申请被矿主扣下。',
    fC: '巡检员的本子:矿柱早该更换,换柱申请被矿主扣下。',
    a1Name: '用木楔撑紧开裂矿柱',
    a1Keywords: ['木楔', '撑', '矿柱', '加固', '修'],
    a1Text: '你把木楔钉进裂缝,又绑上铁链——地动再大,这根矿柱也撑得住。',
    a2Name: '把巡检本子交给巡检员',
    a2Keywords: ['本子', '巡检员', '交', '报', '揭'],
    a2Text: '巡检员翻完本子,勃然大怒:"停工!撤人!"矿洞清空,夜班工全部撤回营地。',
    edgeMain: '矿柱断裂 + 地动 → 矿道塌方、作业队被埋',
    edgeRescue: '无人报险 + 风井堵死 → 夜班工被困遇难',
    npcKnowledge: [['f_a'], ['f_b'], []],
    npcLiePolicy: ['如实相告,但不愿多谈换柱。', '矢口否认与矿柱有关,把巡检单说成"作废草稿"。', '公事公办,只认本子。'],
  },
}

// ── 因果链形状 2:崩塌(两线并进,各自事实+道具) ────────────────────────────────

interface CollapseWords {
  intro: string
  tragedyName: string
  collapseText: string
  lockedText: string
  winText: string
  fA: string
  fAKeywords: string[]
  e1Name: string
  e1Observe: string
  e2Name: string
  e2Observe: string
  e2Target: string
  e2Investigate: string
  toolName: string
  toolDesc: string
  e3Name: string
  e3Observe: string
  fB: string
  fBKeywords: string[]
  e4Name: string
  e4Observe: string
  e4Target: string
  e4Investigate: string
  proofName: string
  proofDesc: string
  a1Name: string
  a1Keywords: string[]
  a1Text: string
  a2Name: string
  a2Keywords: string[]
  a2Text: string
  edgeMain: string
  edgeRescue: string
  npcKnowledge: [string[], string[], string[]]
  npcLiePolicy: [string, string, string]
}

const COLLAPSE_WORDS: Record<'harbor' | 'mine', CollapseWords> = {
  harbor: {
    intro: '你是港口借宿的旅人。今晚,满潮将吞没泊位——绞盘棘轮卡死,货轮系不住缆,五名装卸工随船撞上礁石,三名巡夜人被困在雾里。而你记得明天。',
    tragedyName: '满潮惊变',
    collapseText: '19:00,满潮汹涌,货轮的系缆突然一松——绞盘棘轮卡死,货轮失控撞向礁石,装卸工们被甩进海里。',
    lockedText: '浓雾漫上港口,雾钟没人敲响,三个巡夜人迷失在栈桥尽头,再没能回来。',
    winText: '【19:00 · 完美一日】满潮如期而至,绞盘却咬得死紧;雾钟长鸣,封港令传遍广场——货轮回泊,无人出海。这一夜,无人遇难。',
    fA: '码头绞盘的棘轮卡死,夜里满潮时货轮将无法系缆。',
    fAKeywords: ['绞盘', '棘轮', '卡死', '系缆'],
    e1Name: '卡死的绞盘',
    e1Observe: '绞盘的棘轮卡死了,手柄摇不动——夜里满潮,货轮系不住缆就会被潮水拖走。',
    e2Name: '备件架',
    e2Observe: '仓库的备件架上,一只崭新的棘爪闪着油光。',
    e2Target: '备件架',
    e2Investigate: '你从备件架上取下一只新棘爪——换上它,绞盘就能重新咬合。',
    toolName: '新棘爪',
    toolDesc: '一只崭新的绞盘棘爪。',
    e3Name: '压下的封港令',
    e3Observe: '港务官把一张封港令折好塞进抽屉,又叮嘱手下"今夜照常作业"。',
    fB: '港务官压下封港令,强令今夜照常作业。',
    fBKeywords: ['封港令', '压下', '照常', '港务官'],
    e4Name: '公告栏背后',
    e4Observe: '广场公告栏背后,胶水还没干透,像是刚被人撕走了什么。',
    e4Target: '公告栏',
    e4Investigate: '你揭开公告栏背板:里面粘着封港令的副本——今夜有大潮,全港本该封停。',
    proofName: '封港令副本',
    proofDesc: '一张盖着港务章的大潮封港令副本。',
    a1Name: '给绞盘换上棘爪',
    a1Keywords: ['棘爪', '绞盘', '换', '修', '装'],
    a1Text: '你撬下卡死的旧棘爪,换上新的——绞盘重新咬合,货轮的系缆稳如磐石。',
    a2Name: '敲响雾钟宣读封港令',
    a2Keywords: ['雾钟', '封港令', '敲', '宣读', '示警'],
    a2Text: '你爬上塔顶敲响雾钟,又当众宣读封港令——港务官面如死灰,船只纷纷回泊,巡夜人循着钟声归队。',
    edgeMain: '绞盘卡死 + 满潮 → 货轮失控、装卸工遇难',
    edgeRescue: '封港令被压 + 无人示警 → 巡夜人迷失遇难',
    npcKnowledge: [['f_b'], ['f_a'], []],
    npcLiePolicy: ['如实相告,但不愿多谈检修。', '矢口否认压下封港令,说"只是例行提醒"。', '公事公办,只认白纸黑字。'],
  },
  mine: {
    intro: '你是矿上借宿的过客。今晚,瓦斯将充满矿道——通风扇停转,五名矿工中毒倒下,三名夜班工被困在井口铁闸外。而你记得明天。',
    tragedyName: '瓦斯之夜',
    collapseText: '19:00,矿道深处传来闷响——通风扇彻底停转,瓦斯无声无息地漫开,作业队一个接一个倒下。',
    lockedText: '井口的铁闸锈死,三个夜班工砸不开门,瓦斯从门缝里渗出来。',
    winText: '【19:00 · 完美一日】夜风灌进矿道,风扇重新转起;警钟长鸣,停工令传遍营地——矿洞清空,铁闸洞开。这一夜,无人遇难。',
    fA: '矿洞的通风扇停转,夜里瓦斯就会在矿道里积聚。',
    fAKeywords: ['通风扇', '停转', '瓦斯', '积聚'],
    e1Name: '停转的通风扇',
    e1Observe: '洞口的通风扇停转了,扇叶锈得发红——夜里瓦斯会在矿道里积聚。',
    e2Name: '工具墙',
    e2Observe: '绞盘房的工具墙上,一副新扇叶挂在最显眼处。',
    e2Target: '工具墙',
    e2Investigate: '你从工具墙上取下一副新扇叶——换上它,通风扇就能重新转起来。',
    toolName: '新扇叶',
    toolDesc: '一副崭新的通风扇扇叶。',
    e3Name: '揣起的停工令',
    e3Observe: '矿主把一张停工令揣进怀里,转身又对工头说"今夜照常下矿"。',
    fB: '矿主把停工令揣进怀里,强令今夜照常下矿。',
    fBKeywords: ['停工令', '揣', '照常', '矿主'],
    e4Name: '布告牌背面',
    e4Observe: '营地的布告牌背面,一角纸边露在外面,像是被谁匆匆贴住。',
    e4Target: '布告牌',
    e4Investigate: '你撕开布告牌背面的糊纸:里面是停工令的副本——今夜有瓦斯风险,全矿本该停工。',
    proofName: '停工令副本',
    proofDesc: '一张盖着矿务章的瓦斯停工令副本。',
    a1Name: '给通风扇换上扇叶',
    a1Keywords: ['扇叶', '通风扇', '换', '修', '装'],
    a1Text: '你拆下锈死的旧扇叶,换上新扇叶——通风扇重新转起,夜风灌进矿道。',
    a2Name: '敲响警钟宣读停工令',
    a2Keywords: ['警钟', '停工令', '敲', '宣读', '示警'],
    a2Text: '你爬上后山敲响警钟,又当众宣读停工令——矿主脸色煞白,矿工们撤出矿洞,夜班工砸开了井口铁闸。',
    edgeMain: '通风扇停转 + 瓦斯积聚 → 矿工中毒遇难',
    edgeRescue: '停工令被藏 + 无人示警 → 夜班工被困遇难',
    npcKnowledge: [['f_b'], ['f_a'], []],
    npcLiePolicy: ['如实相告,但不愿多谈检修。', '矢口否认藏起停工令,说"只是没来得及贴"。', '公事公办,只认白纸黑字。'],
  },
}

// ── 因果链形状 3:命案(链式前置:切第一边的行动产出第二边所需事实) ───────────

interface PoisonWords {
  intro: string
  tragedyName: string
  collapseText: string
  lockedText: string
  winText: string
  fA: string
  fAKeywords: string[]
  e1Name: string
  e1Observe: string
  e2Name: string
  e2Observe: string
  e2Target: string
  e2Investigate: string
  toolName: string
  toolDesc: string
  e3Name: string
  e3Observe: string
  fB: string
  fBKeywords: string[]
  a1Name: string
  a1Keywords: string[]
  a1Text: string
  fC: string
  a2Name: string
  a2Keywords: string[]
  a2Text: string
  edgeMain: string
  edgeRescue: string
  npcKnowledge: [string[], string[], string[]]
  npcLiePolicy: [string, string, string]
}

const POISON_WORDS: Record<'harbor' | 'mine', PoisonWords> = {
  harbor: {
    intro: '你是搭货轮借宿的旅人。今晚,大副张罗的接风宴上,一壶酒将夺走五条人命;混乱中证据被毁,三个证人再不敢开口。而你记得明天。',
    tragedyName: '接风毒宴',
    collapseText: '19:00,接风宴开席,大副亲手斟酒——船员们举杯,随即一个个捂住喉咙倒下。',
    lockedText: '混乱中,药包被丢进海里,三个知情的船员被"照顾"进了底舱,再没能上来。',
    winText: '【19:00 · 完美一日】酒壶早已被你掉包,宾客尽欢;你当众亮出药包,卫队长摁住了大副。这一夜,无人中毒。',
    fA: '大副昨夜从仓库取走一包"防鼠药",包装上的封蜡被拆开过。',
    fAKeywords: ['防鼠药', '仓库', '取走', '大副', '封蜡'],
    e1Name: '动过的药柜',
    e1Observe: '你看见大副昨夜动过仓库的药柜,一包"防鼠药"不翼而飞——封蜡碎在地上。',
    e2Name: '药柜暗格',
    e2Observe: '仓库的药柜虚掩着,暗格处有新鲜的翻动痕迹。',
    e2Target: '药柜',
    e2Investigate: '你拉开药柜暗格:里面是那包"防鼠药",封蜡被拆开过——这就是那壶酒的来历。',
    toolName: '防鼠药包',
    toolDesc: '一包封蜡破损的"防鼠药"。',
    e3Name: '带上船的酒壶',
    e3Observe: '守塔人指着海面:他看见大副把一壶酒提上了货轮,还特意换了只新壶嘴。',
    fB: '守塔人看见大副把一壶酒提上货轮,换过壶嘴。',
    fBKeywords: ['酒壶', '货轮', '壶嘴', '大副'],
    a1Name: '把宴席上的酒壶掉包',
    a1Keywords: ['酒壶', '掉包', '换', '调换', '偷换'],
    a1Text: '你趁大副招呼客人,把宴席上的酒壶换成清水——毒酒到了你手里,这就是铁证。',
    fC: '毒酒壶已在你手中,是宴会投毒的铁证。',
    a2Name: '当众亮出毒酒与药包',
    a2Keywords: ['毒酒', '药包', '当众', '亮出', '揭穿', '指认'],
    a2Text: '你把毒酒和药包拍在桌上,请守塔人当众作证——大副瘫坐在地,卫队长直接给他上了铐。',
    edgeMain: '毒酒上桌 → 船员中毒遇难',
    edgeRescue: '证据被毁 + 证人沉默 → 真凶逍遥、证人枉死',
    npcKnowledge: [['f_b'], ['f_a'], []],
    npcLiePolicy: ['矢口否认取药,说"是替库房清点"。', '支支吾吾,把酒说成"接风惯例"。', '如实相告,只说自己看见的。'],
  },
  mine: {
    intro: '你是矿上借宿的过客。今晚,矿主摆的接风宴上,一坛酒将夺走五条人命;混乱中证据被毁,三个证人再不敢开口。而你记得明天。',
    tragedyName: '断魂接风宴',
    collapseText: '19:00,接风宴开席,矿主亲手开封——宾客们举碗,随即一个个捂住喉咙倒下。',
    lockedText: '混乱中,药包被丢进矿洞深处,三个知情的矿工被"派去"了塌方区,再没能回来。',
    winText: '【19:00 · 完美一日】酒坛早已被你掉包,宾主尽欢;你当众亮出药包,巡检员摁住了矿主。这一夜,无人中毒。',
    fA: '矿主昨夜从绞盘房取走一包砒霜,包装上的封蜡被拆开过。',
    fAKeywords: ['砒霜', '绞盘房', '取走', '矿主', '封蜡'],
    e1Name: '动过的工具暗格',
    e1Observe: '你看见矿主昨夜动过绞盘房的工具暗格,一包砒霜不翼而飞——封蜡碎在地上。',
    e2Name: '暗格药包',
    e2Observe: '绞盘房的工具暗格虚掩着,暗格处有新鲜的翻动痕迹。',
    e2Target: '工具暗格',
    e2Investigate: '你拉开工具暗格:里面是那包砒霜,封蜡被拆开过——这就是那坛酒的来历。',
    toolName: '砒霜药包',
    toolDesc: '一包封蜡破损的砒霜。',
    e3Name: '搬进营地的酒坛',
    e3Observe: '老矿工指着营地:他看见矿主把一坛酒搬进帐篷,还特意换了只新坛塞。',
    fB: '老矿工看见矿主把一坛酒搬进营地,换过坛塞。',
    fBKeywords: ['酒坛', '营地', '坛塞', '矿主'],
    a1Name: '把宴席上的酒坛掉包',
    a1Keywords: ['酒坛', '掉包', '换', '调换', '偷换'],
    a1Text: '你趁矿主招呼客人,把宴席上的酒坛换成清水——毒酒到了你手里,这就是铁证。',
    fC: '毒酒坛已在你手中,是宴会投毒的铁证。',
    a2Name: '当众亮出毒酒与药包',
    a2Keywords: ['毒酒', '药包', '当众', '亮出', '揭穿', '指认'],
    a2Text: '你把毒酒和药包拍在桌上,请老矿工当众作证——矿主瘫坐在地,巡检员直接给他上了铐。',
    edgeMain: '毒酒上桌 → 宾客中毒遇难',
    edgeRescue: '证据被毁 + 证人沉默 → 真凶逍遥、证人枉死',
    npcKnowledge: [['f_b'], ['f_a'], []],
    npcLiePolicy: ['矢口否认取药,说"是替库房清点"。', '支支吾吾,把酒说成"接风惯例"。', '如实相告,只说自己看见的。'],
  },
}

// ── 组装 ──────────────────────────────────────────────────────────────────────

function npcScripts(
  s: WorldSetting,
  knowledge: [string[], string[], string[]],
  liePolicy: [string, string, string],
): Record<string, NpcScript> {
  const personas: Record<string, string[]> = {
    harbor: ['嗓门沙哑,烟斗不离手。', '满脸堆笑,眼神却躲闪。', '声如洪钟,只认白纸黑字。'],
    mine: ['话不多,句句在点子上。', '皮笑肉不笑,爱拍胸脯。', '一丝不苟,本子不离手。'],
  }
  return Object.fromEntries(
    s.npcs.map((npc, i) => [
      npc.id,
      { persona: personas[s.id][i], knowledge: knowledge[i], mustNotAdmit: knowledge[i], liePolicy: liePolicy[i] },
    ]),
  )
}

function common(s: WorldSetting, seed: number, words: { intro: string; tragedyName: string }): {
  npcs: LoopNpc[]
  intro: string
  sliceCount: number
  sliceNames: string[]
  difficulty: number
} {
  return {
    npcs: buildNpcs(s, seed),
    intro: words.intro,
    sliceCount: SLICES,
    sliceNames: SLICE_NAMES,
    difficulty: 2,
  }
}

function buildWreck(s: WorldSetting, seed: number): LoopScript {
  const w = WRECK_WORDS[s.id as 'harbor' | 'mine']
  const [L0, L1, L2, L3] = s.locations
  const facts: CaseFact[] = [
    fact('f_a', 'physical', w.fA, w.fAKeywords),
    fact('f_b', 'timeline', w.fB, w.fBKeywords),
    fact('f_c', 'physical', w.fC),
  ]
  const events: LoopEvent[] = [
    { id: 'g_e_hazard', slice: 0, location: L0.id, name: w.e1Name, observe: w.e1Observe, reveals: ['f_a'] },
    { id: 'g_e_tool', slice: 1, sliceTo: 2, location: L1.id, name: w.e2Name, observe: w.e2Observe, reveals: [], investigate: { target: w.e2Target, requires: [], item: 'G_TOOL', text: w.e2Investigate } },
    { id: 'g_e_record', slice: 2, location: L2.id, name: w.e3Name, observe: w.e3Observe, reveals: ['f_b'] },
    { id: 'g_e_witness', slice: 3, sliceTo: 4, location: L3.id, name: w.e4Name, observe: w.e4Observe, reveals: [], investigate: { target: w.e4Target, requires: ['f_b'], facts: ['f_c'], text: w.e4Investigate } },
  ]
  const actions: LoopAction[] = [
    { id: 'g_a_fix', name: w.a1Name, sliceFrom: 4, location: L0.id, keywords: w.a1Keywords, requires: { facts: ['f_a'], items: ['G_TOOL'] }, effect: { cutEdge: 'g_edge_main', text: w.a1Text } },
    { id: 'g_a_evac', name: w.a2Name, sliceFrom: 5, location: L2.id, keywords: w.a2Keywords, requires: { facts: ['f_b', 'f_c'], items: [] }, effect: { cutEdge: 'g_edge_rescue', text: w.a2Text } },
  ]
  const edgeNotes = { g_edge_main: w.edgeMain, g_edge_rescue: w.edgeRescue }
  const winPath = [
    `① 12:00 ${L0.name}:观察「${w.e1Name}」,记下隐患;`,
    `② 13:00 ${L1.name}:从${w.e2Target}取${w.toolName}(G_TOOL);`,
    `③ 14:00 ${L2.name}:目睹「${w.e3Name}」;`,
    `④ 15:00 ${L3.name}:深查${w.e4Target},拿到另一本记录;`,
    `⑤ 16:00 ${L0.name}:${w.a1Name}(切断${w.edgeMain});`,
    `⑥ 17:00 ${L2.name}:${w.a2Name}(切断${w.edgeRescue});`,
    '⑦ 19:00:灾祸没有发生——无人遇难,完美一日。',
  ]
  return {
    id: `${s.id}-wreck-v${bit(seed, 0) + 2 * bit(seed, 1) + 4 * bit(seed, 2)}`,
    title: `${s.title}·${w.tragedyName}`,
    ...common(s, seed, w),
    locations: s.locations,
    facts,
    npc: npcScripts(s, w.npcKnowledge, w.npcLiePolicy),
    events,
    actions,
    items: [{ id: 'G_TOOL', name: w.toolName, desc: w.toolDesc }],
    tragedy: {
      slice: 7,
      name: w.tragedyName,
      collapseDeaths: 5,
      lockedDeaths: 3,
      collapseText: w.collapseText,
      lockedText: w.lockedText,
    },
    keyEdges: ['g_edge_main', 'g_edge_rescue'],
    edgeNotes,
    winPath,
    causalEdges: [
      { from: 'g_e_hazard', to: 'g_edge_main', note: '隐患 → 灾祸' },
      { from: 'g_e_tool', to: 'g_edge_main', note: '工具 → 修复' },
      { from: 'g_e_record', to: 'g_edge_rescue', note: '隐瞒 → 无人示警' },
      { from: 'g_e_witness', to: 'g_edge_rescue', note: '实证 → 揭露' },
      { from: 'g_edge_main', to: 'tragedy', note: '灾祸 → 遇难' },
      { from: 'g_edge_rescue', to: 'tragedy', note: '被困 → 遇难' },
    ],
    hints: [
      `先把每个时间点"谁在哪儿、做了什么"记下来——尤其 12:00 的${L0.name}。`,
      `有些东西要"先知道,才拿得到":${L3.name}的${w.e4Target}需要先有 14:00 的目击。`,
      `要改写结局,${w.a1Name}与${w.a2Name}缺一不可。`,
    ],
    winText: w.winText,
  }
}

function buildCollapse(s: WorldSetting, seed: number): LoopScript {
  const w = COLLAPSE_WORDS[s.id as 'harbor' | 'mine']
  const [L0, L1, L2, L3] = s.locations
  const facts: CaseFact[] = [
    fact('f_a', 'physical', w.fA, w.fAKeywords),
    fact('f_b', 'timeline', w.fB, w.fBKeywords),
  ]
  const events: LoopEvent[] = [
    { id: 'g_e_hazard', slice: 0, location: L0.id, name: w.e1Name, observe: w.e1Observe, reveals: ['f_a'] },
    { id: 'g_e_tool', slice: 1, sliceTo: 2, location: L1.id, name: w.e2Name, observe: w.e2Observe, reveals: [], investigate: { target: w.e2Target, requires: [], item: 'G_TOOL', text: w.e2Investigate } },
    { id: 'g_e_order', slice: 2, sliceTo: 3, location: L2.id, name: w.e3Name, observe: w.e3Observe, reveals: ['f_b'] },
    { id: 'g_e_proof', slice: 3, sliceTo: 4, location: L3.id, name: w.e4Name, observe: w.e4Observe, reveals: [], investigate: { target: w.e4Target, requires: [], item: 'G_PROOF', text: w.e4Investigate } },
  ]
  const actions: LoopAction[] = [
    { id: 'g_a_fix', name: w.a1Name, sliceFrom: 4, location: L1.id, keywords: w.a1Keywords, requires: { facts: ['f_a'], items: ['G_TOOL'] }, effect: { cutEdge: 'g_edge_main', text: w.a1Text } },
    { id: 'g_a_alarm', name: w.a2Name, sliceFrom: 5, location: L2.id, keywords: w.a2Keywords, requires: { facts: ['f_b'], items: ['G_PROOF'] }, effect: { cutEdge: 'g_edge_rescue', text: w.a2Text } },
  ]
  const edgeNotes = { g_edge_main: w.edgeMain, g_edge_rescue: w.edgeRescue }
  const winPath = [
    `① 12:00 ${L0.name}:观察「${w.e1Name}」,记下隐患;`,
    `② 13:00 ${L1.name}:从${w.e2Target}取${w.toolName}(G_TOOL);`,
    `③ 14:00 ${L2.name}:目睹「${w.e3Name}」;`,
    `④ 15:00 ${L3.name}:在${w.e4Target}拿到${w.proofName}(G_PROOF);`,
    `⑤ 16:00 ${L1.name}:${w.a1Name}(切断${w.edgeMain});`,
    `⑥ 17:00 ${L2.name}:${w.a2Name}(切断${w.edgeRescue});`,
    '⑦ 19:00:灾祸没有发生——无人遇难,完美一日。',
  ]
  return {
    id: `${s.id}-collapse-v${bit(seed, 0) + 2 * bit(seed, 1) + 4 * bit(seed, 2)}`,
    title: `${s.title}·${w.tragedyName}`,
    ...common(s, seed, w),
    locations: s.locations,
    facts,
    npc: npcScripts(s, w.npcKnowledge, w.npcLiePolicy),
    events,
    actions,
    items: [
      { id: 'G_TOOL', name: w.toolName, desc: w.toolDesc },
      { id: 'G_PROOF', name: w.proofName, desc: w.proofDesc },
    ],
    tragedy: {
      slice: 7,
      name: w.tragedyName,
      collapseDeaths: 5,
      lockedDeaths: 3,
      collapseText: w.collapseText,
      lockedText: w.lockedText,
    },
    keyEdges: ['g_edge_main', 'g_edge_rescue'],
    edgeNotes,
    winPath,
    causalEdges: [
      { from: 'g_e_hazard', to: 'g_edge_main', note: '隐患 → 灾祸' },
      { from: 'g_e_tool', to: 'g_edge_main', note: '备件 → 修复' },
      { from: 'g_e_order', to: 'g_edge_rescue', note: '强令作业 → 无人示警' },
      { from: 'g_e_proof', to: 'g_edge_rescue', note: '公文 → 揭露' },
      { from: 'g_edge_main', to: 'tragedy', note: '灾祸 → 遇难' },
      { from: 'g_edge_rescue', to: 'tragedy', note: '被困 → 遇难' },
    ],
    hints: [
      `先把每个时间点"谁在哪儿、做了什么"记下来——尤其 12:00 的${L0.name}。`,
      `${w.proofName}就藏在${L3.name}的${w.e4Target}——但它只在 15:00 之后才在。`,
      `要改写结局,${w.a1Name}与${w.a2Name}缺一不可。`,
    ],
    winText: w.winText,
  }
}

function buildPoison(s: WorldSetting, seed: number): LoopScript {
  const w = POISON_WORDS[s.id as 'harbor' | 'mine']
  const [L0, L1, L2] = s.locations
  const facts: CaseFact[] = [
    fact('f_a', 'physical', w.fA, w.fAKeywords),
    fact('f_b', 'testimony', w.fB, w.fBKeywords),
    fact('f_c', 'physical', w.fC),
  ]
  const events: LoopEvent[] = [
    { id: 'g_e_pill', slice: 0, location: L0.id, name: w.e1Name, observe: w.e1Observe, reveals: ['f_a'] },
    { id: 'g_e_stash', slice: 1, sliceTo: 2, location: L1.id, name: w.e2Name, observe: w.e2Observe, reveals: [], investigate: { target: w.e2Target, requires: ['f_a'], item: 'G_TOOL', text: w.e2Investigate } },
    { id: 'g_e_wine', slice: 2, sliceTo: 3, location: L2.id, name: w.e3Name, observe: w.e3Observe, reveals: ['f_b'] },
  ]
  const actions: LoopAction[] = [
    { id: 'g_a_swap', name: w.a1Name, sliceFrom: 4, location: L0.id, keywords: w.a1Keywords, requires: { facts: ['f_a'], items: ['G_TOOL'] }, effect: { cutEdge: 'g_edge_main', facts: ['f_c'], text: w.a1Text } },
    { id: 'g_a_expose', name: w.a2Name, sliceFrom: 6, location: L2.id, keywords: w.a2Keywords, requires: { facts: ['f_b', 'f_c'], items: ['G_TOOL'] }, effect: { cutEdge: 'g_edge_rescue', text: w.a2Text } },
  ]
  const edgeNotes = { g_edge_main: w.edgeMain, g_edge_rescue: w.edgeRescue }
  const winPath = [
    `① 12:00 ${L0.name}:观察「${w.e1Name}」,记下毒源;`,
    `② 13:00 ${L1.name}:从${w.e2Target}取${w.toolName}(G_TOOL);`,
    `③ 14:00 ${L2.name}:听目击者说「${w.e3Name}」;`,
    `④ 16:00 ${L0.name}:${w.a1Name}(切断${w.edgeMain},毒酒到手);`,
    `⑤ 18:00 ${L2.name}:${w.a2Name}(切断${w.edgeRescue});`,
    '⑥ 19:00:新酒上桌,宾主尽欢;真凶被当众揭穿——无人中毒,完美一日。',
  ]
  return {
    id: `${s.id}-poison-v${bit(seed, 0) + 2 * bit(seed, 1) + 4 * bit(seed, 2)}`,
    title: `${s.title}·${w.tragedyName}`,
    ...common(s, seed, w),
    locations: s.locations,
    facts,
    npc: npcScripts(s, w.npcKnowledge, w.npcLiePolicy),
    events,
    actions,
    items: [{ id: 'G_TOOL', name: w.toolName, desc: w.toolDesc }],
    tragedy: {
      slice: 7,
      name: w.tragedyName,
      collapseDeaths: 5,
      lockedDeaths: 3,
      collapseText: w.collapseText,
      lockedText: w.lockedText,
    },
    keyEdges: ['g_edge_main', 'g_edge_rescue'],
    edgeNotes,
    winPath,
    causalEdges: [
      { from: 'g_e_pill', to: 'g_edge_main', note: '购毒 → 投毒' },
      { from: 'g_e_stash', to: 'g_edge_main', note: '药包 → 铁证' },
      { from: 'g_e_wine', to: 'g_edge_rescue', note: '目击 → 证词' },
      { from: 'g_edge_main', to: 'g_edge_rescue', note: '掉包毒酒 → 当众揭穿的前提' },
      { from: 'g_edge_main', to: 'tragedy', note: '毒酒 → 中毒' },
      { from: 'g_edge_rescue', to: 'tragedy', note: '灭证 → 枉死' },
    ],
    hints: [
      `先把每个时间点"谁在哪儿、做了什么"记下来——尤其 12:00 的${L0.name}。`,
      `${L1.name}的${w.e2Target}要先知道"毒从哪来"才翻得到。`,
      `要改写结局:先掉包毒酒,再当众揭穿——顺序不能反。`,
    ],
    winText: w.winText,
  }
}

const BUILDERS = [buildWreck, buildCollapse, buildPoison]

/**
 * 程序化时间表生成:种子 → (场景 × 因果链形状),纯函数、确定性。
 * 生成物必须通过 solveLoop 硬门禁才能进入剧本池(见 loop.ts)。
 */
export function generateLoopWorld(seed: number): LoopScript {
  const setting = SETTINGS[Math.abs(seed) % SETTINGS.length]
  const builder = BUILDERS[Math.floor(Math.abs(seed) / SETTINGS.length) % BUILDERS.length]
  return builder(setting, seed)
}
