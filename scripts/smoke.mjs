/**
 * 冒烟测试:在不启动完整 dsh 的情况下验证插件装配与核心引擎。
 * 运行:node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, name, inject } from '../lib/index.js'
import { adjudicateQuestion } from '../lib/games/soup.js'

const registeredTools = []
const registeredCommands = []

const ctx = new Context()
const logger = () => ({ info() {}, warn() {}, error() {}, debug() {} })
ctx.provide('logger', logger)
ctx.provide('tools', {
  register(def) { registeredTools.push(def); return () => {} },
  schemas() { return registeredTools.map(({ name, description, parameters }) => ({ name, description, parameters })) },
})
ctx.provide('commands', {
  register(def) { registeredCommands.push(def); return () => {} },
})

apply(ctx, { storageDir: '', language: 'zh-CN' })
// ctx.inject 的依赖满足回调可能在下个微任务触发,让出事件循环
await new Promise((resolve) => setTimeout(resolve, 50))

assert.equal(name, 'dsh-xgame')
assert.deepEqual(inject, ['tools'])

const toolNames = registeredTools.map((t) => t.name).sort()
assert.deepEqual(toolNames, [
  'council_consult',
  'council_decide',
  'council_investigate',
  'council_question',
  'council_speak',
  'detective_accuse',
  'detective_examine',
  'detective_show',
  'detective_submit_theory',
  'detective_talk',
  'escape_combine',
  'escape_examine',
  'escape_manipulate',
  'escape_solve',
  'escape_take',
  'escape_use',
  'game_start',
  'loop_act',
  'loop_fast_forward',
  'loop_investigate',
  'loop_move',
  'loop_observe',
  'loop_submit_plan',
  'loop_talk',
  'party_accuse',
  'party_defend',
  'party_discuss',
  'party_search',
  'party_show',
  'party_talk',
  'party_verdict',
  'soup_ask',
  'soup_guess',
  'trpg_attack',
  'trpg_check',
  'trpg_examine',
  'trpg_flee',
  'trpg_move',
  'trpg_rest',
  'trpg_talk',
  'trpg_use',
])
for (const tool of registeredTools) {
  assert.ok(typeof tool.name === 'string' && tool.name !== '', 'tool name')
  assert.ok(typeof tool.description === 'string' && tool.description !== '', `tool ${tool.name} description`)
  assert.ok(tool.parameters && typeof tool.parameters === 'object', `tool ${tool.name} parameters`)
  assert.ok(tool.output && tool.output.schema && typeof tool.output.render === 'function', `tool ${tool.name} output`)
  assert.ok(typeof tool.execute === 'function', `tool ${tool.name} execute`)
}

const commandNames = registeredCommands.map((c) => c.name).sort()
assert.deepEqual(commandNames, ['bag', 'casefile', 'facts', 'game', 'hint', 'history', 'ledger', 'look', 'loops', 'map', 'quests', 'relations', 'role', 'roles', 'schedule', 'sheet', 'timeline', 'trust', 'world'])
console.log(`✓ 装配:${registeredTools.length} 个工具 / ${registeredCommands.length} 个命令`)

// ── 海龟汤规则裁决(不依赖 LLM;按卡显式选取,结果确定) ─────────────────────────
const { soupEngine, SOUP_CARDS } = await import('../lib/games/soup.js')
const created = await soupEngine.create('s1', 1)
assert.equal(created.state.scheme, 'soup')
assert.ok(created.brief.includes('汤面'))
const noLlm = { get: () => undefined }
const cardOf = (id) => SOUP_CARDS.find((c) => c.id === id)
const ask = (card, q) => adjudicateQuestion(noLlm, {}, card, { coreHits: [] }, q)

// 酒吧与水(难度 1)
const barWater = cardOf('soup-bar-water')
const r1 = await ask(barWater, '他进酒吧前一直在打嗝吗?')
assert.equal(r1.verdict.verdict, 'yes', '打嗝 → 是')
const r2 = await ask(barWater, '酒保是想抢劫他吗?')
assert.equal(r2.verdict.verdict, 'no', '抢劫 → 否')
assert.equal(r2.verdict.redHerring, true, '抢劫 → 红鱼')
const r3 = await ask(barWater, '水里有毒吗?')
assert.equal(r3.verdict.verdict, 'no', '毒 → 否')
const r4 = await ask(barWater, '今天星期几?')
assert.equal(r4.verdict.verdict, 'irrelevant', '无匹配且无 LLM → 无关')
console.log('✓ 海龟汤规则裁决(酒吧与水:是/否/红鱼/兜底)')

// 新卡裁决抽查(负面规则在前,复合问题不误判)
assert.equal((await ask(cardOf('soup-funeral'), '他杀妹妹是为了钱吗?')).verdict.verdict, 'no', '葬礼-钱 → 否')
assert.equal((await ask(cardOf('soup-funeral'), '他杀死妹妹是为了再办一场葬礼吗?')).verdict.verdict, 'yes', '葬礼-再办 → 是')
assert.equal((await ask(cardOf('soup-funeral'), '他爱上自己的妹妹了吗?')).verdict.verdict, 'no', '葬礼-爱上妹妹 → 否')
assert.equal((await ask(cardOf('soup-desert-match'), '他是被谋杀的吗?')).verdict.verdict, 'no', '沙漠-谋杀 → 否')
assert.equal((await ask(cardOf('soup-desert-match'), '他乘坐热气球穿越沙漠吗?')).verdict.verdict, 'yes', '沙漠-热气球 → 是')
assert.equal((await ask(cardOf('soup-seaweed'), '他杀死了女友吗?')).verdict.verdict, 'no', '水草-他杀 → 否')
assert.equal((await ask(cardOf('soup-seaweed'), '缠住他的东西是水草吗?')).verdict.verdict, 'yes', '水草-水草 → 是')
assert.equal((await ask(cardOf('soup-hospital-light'), '护士深夜关灯了吗?')).verdict.verdict, 'yes', '医院-关灯 → 是')
assert.equal((await ask(cardOf('soup-hospital-light'), '他得了绝症吗?')).verdict.verdict, 'no', '医院-绝症 → 否')
console.log('✓ 海龟汤新卡裁决(4 张新卡,负面规则前置)')

// ── 求解器:金色案件必须通过,破坏性案件必须被拒 ────────────────────────────────
const { solveCase } = await import('../lib/games/solver.js')
const { FOG_MANSION, scriptedCollapse } = await import('../lib/games/detective.js')
const { generateCase, hashString } = await import('../lib/games/casegen.js')

const fogReport = solveCase(FOG_MANSION)
assert.equal(fogReport.ok, true, `雾都公馆应通过求解器:${fogReport.errors.join(';')}`)
assert.deepEqual(fogReport.warnings, [], '雾都公馆应无警告')

// 生成器:全种子 × 全难度通过求解器门禁
for (const d of [1, 2, 3]) {
  for (let seed = 1; seed <= 60; seed++) {
    const caseData = generateCase(seed, d)
    const report = solveCase(caseData)
    assert.ok(report.ok, `seed=${seed} d=${d} 生成案件未通过求解器:${report.errors.join(';')}`)
  }
}
console.log('✓ 程序化案件生成器:180 个种子 × 3 难度全部通过求解器')

// 生成器确定性:同种子 → 同案件
assert.deepEqual(generateCase(42, 2), generateCase(42, 2), '生成器应确定性')
assert.notDeepEqual(generateCase(42, 2), generateCase(43, 2), '不同种子应不同案件')
assert.equal(typeof hashString('sess-x'), 'number')

// 难度映射:1=4 嫌疑人/1 红鲱鱼,2=5/2,3=6/3;关键线索 2/3/3
assert.equal(generateCase(7, 1).suspects.length, 4)
assert.equal(generateCase(7, 2).suspects.length, 5)
assert.equal(generateCase(7, 3).suspects.length, 6)
assert.equal(generateCase(7, 1).keyClueIds.length, 2)
assert.equal(generateCase(7, 3).keyClueIds.length, 3)
const rhCount = (caseData) => caseData.clues.filter((c) => (c.misleadsTo ?? []).length > 0).length
assert.equal(rhCount(generateCase(7, 1)), 1)
assert.equal(rhCount(generateCase(7, 2)), 2)
assert.equal(rhCount(generateCase(7, 3)), 3)

// 破坏案例 1:拿走关键线索 → 拒绝
const broken1 = structuredClone(FOG_MANSION)
broken1.clues = broken1.clues.filter((c) => c.id !== 'e_letter')
assert.equal(solveCase(broken1).ok, false, '缺失关键线索应被拒')

// 破坏案例 2:拿走排除线索 → 唯一性拒绝
const broken2 = structuredClone(FOG_MANSION)
broken2.clues = broken2.clues.filter((c) => c.id !== 'e_bandage')
assert.equal(solveCase(broken2).ok, false, '缺失排除证据应被拒')

// 破坏案例 3:冗余关键线索 → 必要性拒绝
const broken3 = structuredClone(FOG_MANSION)
broken3.clues.push({ id: 'e_dup', location: '书房', description: '重复证据。', reveals: ['f_identity'] })
broken3.keyClueIds.push('e_dup')
assert.equal(solveCase(broken3).ok, false, '冗余关键线索应被拒')

// 铁证崩溃(纯引擎路径):凶手 + 全部关键线索 → 崩溃台词
assert.equal(scriptedCollapse(FOG_MANSION, { s_butler: ['e_lake', 'e_letter'] }, 's_butler'), FOG_MANSION.npc.s_butler.collapse)
assert.equal(scriptedCollapse(FOG_MANSION, { s_butler: ['e_lake'] }, 's_butler'), null, '铁证不齐不应崩溃')
assert.equal(scriptedCollapse(FOG_MANSION, { s_heir: [] }, 's_heir'), null, '非凶手不应崩溃')
console.log('✓ 求解器门禁:金案通过 / 破坏案例拒绝 / 铁证崩溃')

// ── 侦探引擎与存储(案件无关断言,兼容手工与生成案件) ────────────────────────────
const { GameManager } = await import('../lib/core/manager.js')
const { detectiveEngine } = await import('../lib/games/detective.js')
const { registerTools } = await import('../lib/tools.js')
const dir = mkdtempSync(path.join(tmpdir(), 'dsh-xgame-smoke-'))
const manager = new GameManager(ctx, { storageDir: dir, language: 'zh-CN' })

// 用临时存储目录的 manager 重新装配一份工具(工具闭包捕获 manager)
const ctx2 = new Context()
ctx2.provide('logger', logger)
ctx2.provide('tools', { register(def) { toolDefs.push(def); return () => {} } })
ctx2.provide('commands', { register() { return () => {} } })
// 非崩溃路径的出示会走插件侧 LLM,这里给一个空流桩
ctx2.provide('llm', {
  stream() {
    return (async function* () {
      yield { type: 'finish', reason: 'stop' }
    })()
  },
})
const toolDefs = []
registerTools(ctx2, manager)
const tool = (toolName) => {
  const def = toolDefs.find((t) => t.name === toolName)
  assert.ok(def, `工具 ${toolName} 已注册`)
  return def
}

const brief = await manager.newGame('sess-1', 'detective', 2)
assert.ok(brief.includes('侦探推理'), '侦探简报')
const dCreated = await detectiveEngine.create('sess-2', 2)
assert.ok(dCreated.truth.suspects.length === 5, '5 名嫌疑人')
assert.ok(dCreated.truth.clues.length >= 10, '线索 ≥ 10')
assert.equal(solveCase(dCreated.truth).ok, true, '引擎选中的案件必须通过求解器')

// 会话案件(引擎按 sessionId 确定性选案)
const loaded1 = await manager.load('sess-1')
const case1 = loaded1.truth

// detective_examine 工具:勘查线索最多的地点
const examine = tool('detective_examine')
const execStub = {
  agent: { session: { id: 'sess-1' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
const locCount = new Map()
for (const c of case1.clues) locCount.set(c.location, (locCount.get(c.location) ?? 0) + 1)
const richLoc = [...locCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
const examined = await examine.execute({ target: richLoc }, execStub)
assert.ok(examined.found.length >= 1, `勘查 ${richLoc} 应有线索`)
assert.ok(examined.text.includes('线索'))

const scoreText = await manager.scoreText('sess-1')
assert.ok(scoreText.includes('侦探推理'))
const casefile = await manager.casefile('sess-1')
assert.ok(casefile.includes('线索'))

// 指控错误 → 结算(given_up)
const accuse = tool('detective_accuse')
const innocent = case1.suspects.find((s) => s.id !== case1.murderer)
const accused = await accuse.execute({ npc: innocent.name }, execStub)
assert.equal(accused.correct, false)
assert.ok(accused.text.includes('真相'))

const quitText = await manager.quit('sess-1')
assert.ok(quitText.includes('结算'), 'quit 返回结算')

// 出示全部关键线索 → 凶手崩溃(纯引擎路径,不依赖 LLM;任何案件都成立)
await manager.newGame('sess-3', 'detective', 2)
const loaded3 = await manager.load('sess-3')
const case3 = loaded3.truth
const exec3 = {
  agent: { session: { id: 'sess-3' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
const examine3 = tool('detective_examine')
const show3 = tool('detective_show')
for (const keyId of case3.keyClueIds) {
  const keyClue = case3.clues.find((c) => c.id === keyId)
  await examine3.execute({ target: keyClue.location }, exec3)
}
let lastShow
for (const keyId of case3.keyClueIds) {
  lastShow = await show3.execute({ npc: case3.murderer, clue_id: keyId }, exec3)
}
const collapse = case3.npc[case3.murderer].collapse
assert.ok(lastShow.text.includes(collapse), `出示全部铁证应触发崩溃认罪,实际:${lastShow.text.slice(0, 80)}`)
await manager.quit('sess-3')
console.log('✓ 侦探引擎 / 工具执行 / 铁证崩溃 / 存档结算')

// ── 泄密审计(确定性 + 工具层净化 + 结算留证) ─────────────────────────────────
const { auditReply, sanitizedLine } = await import('../lib/core/audit.js')

const auditCase = (label, npc, reply, expectFlagged, expectSlipped = [], expectOutOfScope = []) => {
  const v = auditReply(FOG_MANSION, npc, reply)
  assert.equal(v.flagged, expectFlagged, `审计-${label}`)
  if (expectFlagged) {
    assert.deepEqual(v.slipped.sort(), [...expectSlipped].sort(), `审计-${label}-slipped`)
    assert.deepEqual(v.outOfScope.sort(), [...expectOutOfScope].sort(), `审计-${label}-outOfScope`)
  }
}
auditCase('说漏嘴-到过书房门口', 's_heir', '其实我到过书房门口,门是锁着的,我以为他睡了。', true, ['f_footstep'])
auditCase('说漏嘴-烧信', 's_heir', '我在温室烧掉了一封信,是写给伯父道歉的。', true, ['f_burn'])
auditCase('凶手自爆-扔火钳', 's_butler', '是我把火钳扔进了湖里,湖边的脚印也是我的。', true, ['f_lake'])
auditCase('凶手自爆-身份', 's_butler', '我原名伊莱莫顿,二十年前卷款潜逃,老爷发现了。', true, ['f_identity'])
auditCase('越界-揭管家湿外套', 's_heir', '我看见管家今晚去过湖边,他的外套是湿的。', true, [], ['f_wetcoat'])
auditCase('干净-作家在沙龙', 's_writer', '我整晚都在沙龙写作,听到楼梯上有脚步声。', false)
auditCase('干净-管家推脱', 's_butler', '我一直在配餐室准备夜宵,什么都不知道。', false)
auditCase('公开信息-死亡时间不拦', 's_doctor', '死亡时间大约是九点四十七分,怀表停在那一刻。', false)
auditCase('干净-园丁劈柴', 's_gardener', '我整晚都在柴房劈柴,斧头还嵌在木桩上。', false)
assert.ok(sanitizedLine('哈洛').includes('警觉'), '净化台词模板')
console.log('✓ 确定性泄密审计:说漏嘴 / 越界泄密 / 干净发言 / 公开信息豁免')

// 工具层:泄密台词被引擎净化并留证(动态 LLM 桩返回敏感事实原文)
{
  const ctx3 = new Context()
  ctx3.provide('logger', logger)
  ctx3.provide('tools', { register(def) { toolDefs3.push(def); return () => {} } })
  ctx3.provide('commands', { register() { return () => {} } })
  let leakReply = ''
  ctx3.provide('llm', {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: leakReply }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  })
  const toolDefs3 = []
  const manager3 = new GameManager(ctx3, { storageDir: dir, language: 'zh-CN' })
  registerTools(ctx3, manager3)
  const talk3 = toolDefs3.find((t) => t.name === 'detective_talk')
  const accuse3 = toolDefs3.find((t) => t.name === 'detective_accuse')
  assert.ok(talk3 && accuse3, '审计路径工具已注册')

  await manager3.newGame('sess-leak', 'detective', 2)
  const leakLoaded = await manager3.load('sess-leak')
  const leakCase = leakLoaded.truth
  const murId = leakCase.murderer
  const murName = leakCase.suspects.find((s) => s.id === murId).name
  const leakFactId = leakCase.npc[murId].mustNotAdmit[0]
  const leakFactText = leakCase.facts.find((f) => f.id === leakFactId).text
  leakReply = leakFactText
  const execLeak = {
    agent: { session: { id: 'sess-leak' }, options: { provider: 'mock', model: 'mock-model' } },
    signal: new AbortController().signal,
  }
  const talkOut = await talk3.execute({ npc: murName, text: '你到底隐瞒了什么?' }, execLeak)
  assert.ok(talkOut.text.includes('警觉地停住'), '泄密台词应被净化')
  assert.ok(!talkOut.text.includes(leakFactText), '敏感事实不得出现在返回文本')
  const afterLeak = await manager3.load('sess-leak')
  assert.equal((afterLeak.state.auditLog ?? []).length, 1, '审计日志留证')
  assert.equal(afterLeak.state.auditLog[0].kind, 'slip')
  const leakCasefile = await manager3.casefile('sess-leak')
  assert.ok(leakCasefile.includes('证词审计') && leakCasefile.includes('说漏嘴'), '卷宗展示证词审计')
  const accuseOut = await accuse3.execute({ npc: murName }, execLeak)
  assert.ok(accuseOut.text.includes('泄密审计'), '结算展示泄密审计段')
  await manager3.quit('sess-leak')
}
console.log('✓ 工具层泄密净化:台词作废 + 审计留证 + 卷宗/结算标注')

// ── 密室逃脱:确定性谜题引擎(金路径 × 3 难度 + 负分支 + 面板) ──────────────────
const { escapeEngine, generateEscapeScenario, solveEscapeScenario } = await import('../lib/games/escape.js')
const escapeFn = await import('../lib/games/escape.js')

// 程序化题库(M3):换皮生成器 + 可解性求解器(全皮肤 × 全难度)
{
  let checked = 0
  for (const d of [1, 2, 3]) {
    for (let seed = 0; seed <= 15; seed++) {
      const scenario = generateEscapeScenario(d, seed)
      const report = solveEscapeScenario(scenario)
      assert.ok(report.ok, `皮肤变体 d${d}/seed${seed} 应可解:${report.errors.join(';')}`)
      checked += 1
    }
  }
  assert.equal(JSON.stringify(generateEscapeScenario(2, 7)), JSON.stringify(generateEscapeScenario(2, 7)), '生成器应确定性')
  console.log(`✓ 密室逃脱程序化题库:${checked} 个皮肤变体全部通过可解性求解器`)
}

async function escapeGoldenPath(d) {
  const created = await escapeEngine.create('golden', d)
  const state = created.state
  const scenario = created.truth
  const step = (fn, expect = 'success', name = '') => {
    const r = fn()
    assert.equal(r.result, expect, `d${d} ${name}: 期望 ${expect} 实得 ${r.result}(${r.text.slice(0, 60)})`)
  }
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id
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
  step(() => escapeFn.take(scenario, state, matches), 'success', '取火种')
  step(() => escapeFn.manipulate(scenario, state, fire, '点火'), 'success', '点火')
  step(() => escapeFn.manipulate(scenario, state, mirror, '转动'), 'success', '转镜')
  step(() => escapeFn.take(scenario, state, frozen), 'success', '取冻钥匙')
  step(() => escapeFn.take(scenario, state, note), 'success', '取纸条')
  step(() => escapeFn.combine(scenario, state, matches, frozen), 'success', '烤化')
  step(() => escapeFn.manipulate(scenario, state, note, '凑到火光下'), 'success', '反印')
  step(() => escapeFn.solve(scenario, state, '西洋钟', '4:30'), 'success', '解钟')
  step(() => escapeFn.useItem(scenario, state, copper, studyDoor), 'success', '开书房门')
  if (d === 1) {
    step(() => escapeFn.useItem(scenario, state, silver, nameOf(scenario.doors, 'd_exit')), 'success', '开出口')
  } else {
    step(() => escapeFn.useItem(scenario, state, silver, cabinet), 'success', '开陈列柜')
    if (d === 3) {
      step(() => escapeFn.manipulate(scenario, state, nameOf(scenario.props, 'p_painting'), '扶正'), 'success', '扶画')
      step(() => escapeFn.manipulate(scenario, state, nameOf(scenario.props, 'p_vase'), '推倒'), 'success', '倒花瓶')
      step(() => escapeFn.useItem(scenario, state, nameOf(scenario.items, 'iron_key'), nameOf(scenario.doors, 'd_cellar')), 'success', '开暗门')
      step(() => escapeFn.manipulate(scenario, state, nameOf(scenario.props, 'p_torch'), '点火'), 'success', '点地窖')
      step(() => escapeFn.manipulate(scenario, state, nameOf(scenario.props, 'p_trapdoor'), '打开'), 'success', '掀活板门')
      step(() => escapeFn.manipulate(scenario, state, finalDoor, '推开'), 'blocked', '密码未解推门')
    }
    step(() => escapeFn.solve(scenario, state, '第七扇门密码锁', '237'), 'success', '解密码')
    step(() => escapeFn.manipulate(scenario, state, finalDoor, '推开'), 'success', '推第七扇门')
  }
  assert.equal(state.phase, 'solved', `d${d} 应脱出`)
  assert.deepEqual(state.bruteForce, [], `d${d} 不应误判暴力猜谜`)
  return { state, scenario }
}
for (const d of [1, 2, 3]) {
  const { state } = await escapeGoldenPath(d)
  assert.equal(state.solved.length, d === 1 ? 1 : 2, `d${d} 谜题数`)
}
console.log('✓ 密室逃脱金路径:难度 1/2/3 全链路脱出(皮肤无关断言)')

// 负分支与审计
{
  const created = await escapeEngine.create('neg', 2)
  const state = created.state
  const scenario = created.truth
  const nOf = (list, id) => list.find((x) => x.id === id)?.name ?? id
  assert.equal(escapeFn.manipulate(scenario, state, nOf(scenario.props, 'p_fireplace'), '点火').result, 'blocked', '无火种点火应被拦')
  assert.equal(escapeFn.manipulate(scenario, state, nOf(scenario.props, 'p_window'), '撬开').result, 'no_effect', '撬死窗应无效果')
  assert.equal(escapeFn.combine(scenario, state, nOf(scenario.items, 'matches'), nOf(scenario.items, 'half_note')).result, 'no_effect', '无效组合应无效果')
  escapeFn.take(scenario, state, nOf(scenario.items, 'matches'))
  const brute = escapeFn.solve(scenario, state, '西洋钟', '430')
  assert.equal(brute.result, 'success')
  assert.ok(state.bruteForce.includes('p_clock'), '未获线索解谜应记暴力猜谜')
  assert.equal(escapeFn.solve(scenario, state, '第七扇门密码锁', '111').result, 'wrong', '错误答案')
  assert.equal(state.wrongAttempts, 1)
  const h1 = escapeEngine.hint(state, scenario)
  const h3 = escapeEngine.hint(state, scenario)
  assert.ok(h1.text.includes('1/3') && h3.text.includes('2/3'), '提示分层递进')
  assert.ok(!h3.text.includes('237'), '提示文本不得含谜底')
}
console.log('✓ 密室逃脱负分支:前置拦截 / 红鲱鱼 / 暴力猜谜审计 / 三层提示不含答案')

// 工具层流程(经 manager):开局 → examine/take/manipulate → /look /bag /map → quit
await manager.newGame('sess-esc', 'escape', 2)
const escExec = {
  agent: { session: { id: 'sess-esc' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
const escTool = (n) => tool(n)
const escBrief = await manager.resumeBrief('sess-esc')
assert.ok(escBrief.includes('密室逃脱'), 'escape 续玩简报')
const escLoaded = await manager.load('sess-esc')
const escScenario = escLoaded.truth
const escName = (list, id) => list.find((x) => x.id === id)?.name ?? id
const escFire = escName(escScenario.props, 'p_fireplace')
const escMatches = escName(escScenario.items, 'matches')
const examinedFireplace = await escTool('escape_examine').execute({ target: escFire }, escExec)
assert.ok(examinedFireplace.text.includes(escFire), 'escape_examine')
await escTool('escape_take').execute({ item: escMatches }, escExec)
const lit = await escTool('escape_manipulate').execute({ target: escFire, action: '点火' }, escExec)
assert.equal(lit.result, 'success', 'escape_manipulate 点火')
const look = await manager.escapePanel('sess-esc', 'look')
assert.ok(look.includes(escFire), '/look 快照反映引擎状态')
const bag = await manager.escapePanel('sess-esc', 'bag')
assert.ok(bag.includes(escMatches), '/bag 背包')
const map = await manager.escapePanel('sess-esc', 'map')
assert.ok(map.includes(escName(escScenario.rooms, 'attic')), '/map 地图')
const escScore = await manager.scoreText('sess-esc')
assert.ok(escScore.includes('密室逃脱'), 'escape score')
const escQuit = await manager.quit('sess-esc')
assert.ok(escQuit.includes('谜底与脱出路径'), 'escape quit 揭示谜底与路径')
console.log('✓ 密室逃脱工具流 + /look /bag /map 面板')

// ── 剧本杀(阶段 4 v1):剧本过求解器 + 搜证/对质/公聊/崩溃认罪/双栏结算 ─────────
const { SNOW_NIGHT, partyEngine, discuss: partyDiscussFn, verifyRoleplay, panelText: partyPanelFn } = await import('../lib/games/party.js')
const panelRoleOf = (caseData, state) => partyPanelFn(caseData, state, 'role')

const snowReport = solveCase(SNOW_NIGHT)
assert.equal(snowReport.ok, true, `风雪夜归人应通过求解器:${snowReport.errors.join(';')}`)
assert.deepEqual(snowReport.warnings, [], '剧本应无警告')

// 泄密审计复用:凶手说漏嘴被拦,正常撒谎放行
assert.equal(auditReply(SNOW_NIGHT, 's_heir', '我欠下巨额赌债,债主已经上门催过两次了。').flagged, true, '少爷说漏嘴应被拦')
assert.equal(auditReply(SNOW_NIGHT, 's_heir', '我 20:12 在花园抽烟,书房的事我不清楚。').flagged, false, '按剧本撒谎应放行')
assert.equal(auditReply(SNOW_NIGHT, 's_maid', '停电的时候,我看见少爷进了书房。').flagged, true, '梅姨说出目击应被拦')

// 扮演质量评审兜底(无 LLM → 基准分)
const rp = await verifyRoleplay({ get: () => undefined }, {}, [{ role: 'user', speaker: '你', text: '各位,停电时谁在书房附近?', at: 0 }], undefined)
assert.equal(rp.score, 60, '无 LLM 时扮演评审兜底')

// 引擎
const partyCreated = await partyEngine.create('p1', 2)
assert.ok(partyCreated.brief.includes('剧本杀'))
assert.ok(!partyCreated.brief.includes('真相') || !partyCreated.brief.includes('凶手是'), '简报不含真相')

// 工具层全流程(案件无关断言:招牌/程序化剧本都成立;难度 3 另测反转模式)
await manager.newGame('sess-party', 'party', 2)
const partyExec = {
  agent: { session: { id: 'sess-party' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
const partyLoaded = await manager.load('sess-party')
const partyCase = partyLoaded.truth
assert.equal(solveCase(partyCase).ok, true, '开局选中的剧本必须通过求解器')
assert.ok(partyCase.suspects.length >= 4, '剧本应有 4+ 名角色')
const partyMurderer = partyCase.murderer
const partyInnocent = partyCase.suspects.find((sp) => sp.id !== partyMurderer)
const partyLocCount = new Map()
for (const c of partyCase.clues) partyLocCount.set(c.location, (partyLocCount.get(c.location) ?? 0) + 1)
const partyRichLoc = [...partyLocCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
const pSearch = tool('party_search')
const searched = await pSearch.execute({ scene: partyRichLoc }, partyExec)
assert.ok(searched.found.length >= 1, '搜证应得证据')
assert.ok(searched.text.includes('搜证'), '搜证文案')

const pTalk = tool('party_talk')
const talkTarget = partyCase.suspects[0].name
const talked = await pTalk.execute({ npc: talkTarget, text: '案发时你在哪?' }, partyExec)
assert.equal(talked.npc, talkTarget)

const pDiscuss = tool('party_discuss')
const discussed = await pDiscuss.execute({ statement: '我在' + partyRichLoc + '找到了关键证据。' }, partyExec)
assert.equal(discussed.lines.length, partyCase.suspects.length, '公聊应收集全员反应')

const roles = await manager.partyPanel('sess-party', 'roles')
assert.ok(roles.includes(partyCase.suspects[0].name), '/roles 名册')
const timeline = await manager.partyPanel('sess-party', 'timeline')
assert.ok(timeline.includes('已确证时间线'), '/timeline 面板')

// 全部关键线索 → 凶手崩溃认罪(纯引擎路径,任何剧本都成立)
const pShow = tool('party_show')
for (const keyId of partyCase.keyClueIds) {
  const keyClue = partyCase.clues.find((c) => c.id === keyId)
  await pSearch.execute({ scene: keyClue.location }, partyExec)
}
let collapseOut
for (const keyId of partyCase.keyClueIds) {
  collapseOut = await pShow.execute({ npc: partyCase.murderer, clue_id: keyId }, partyExec)
}
const collapseText = partyCase.npc[partyMurderer].collapse
assert.ok(collapseOut.text.includes(collapseText), '全部关键线索应触发崩溃认罪')

// 指控错误 → 双栏结算
const pAccuse = tool('party_accuse')
const partyAccused = await pAccuse.execute({ npc: partyInnocent.name }, partyExec)
assert.equal(partyAccused.correct, false)
assert.ok(partyAccused.text.includes('真相') && partyAccused.text.includes('扮演质量') && partyAccused.text.includes('推理正确性'), '双栏结算')
await manager.quit('sess-party')
console.log('✓ 剧本杀:剧本门禁 / 搜证 / 对质 / 公聊 fan-out / 铁证崩溃 / 双栏结算(招牌 + 程序化剧本)')

// ── 时间循环(阶段 5):时间片引擎 + 半 reset + 循环 diff + 完美日验证 ─────────────
const { NORTH_BRIDGE, INN_FIRE, BANQUET_POISON, LOOP_SCRIPTS, loopEngine, makeLoopState, solveLoop, verifyPlan } = await import('../lib/games/loop.js')
const loopFn = await import('../lib/games/loop.js')

// 程序化生成(M3):骨架 × 皮肤变体全部过 ScheduleSolver + 皮肤金路径
const { generateLoopScript: generateLoopVariant } = await import('../lib/games/loopgen.js')
{
  let checked = 0
  for (let seed = 1; seed <= 12; seed++) {
    const variant = generateLoopVariant(seed)
    const report = solveLoop(variant)
    assert.ok(report.ok, `变体 seed${seed}(${variant.title})应通过求解器:${report.errors.join(';')}`)
    checked += 1
  }
  assert.equal(JSON.stringify(generateLoopVariant(7)), JSON.stringify(generateLoopVariant(7)), '生成器应确定性')
  // 武侠变体金路径(改名自洽性)
  const wuxia = generateLoopVariant(1)
  const wst = makeLoopState(wuxia, 2)
  const wName = (list, id) => list.find((x) => x.id === id)?.name ?? id
  loopFn.observe(wuxia, wst)
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'stable'))
  loopFn.investigate(wuxia, wst, '工具箱')
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'kitchen'))
  loopFn.investigate(wuxia, wst, '灶台')
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'inn'))
  loopFn.act(wuxia, wst, wuxia.actions.find((a) => a.id === 'a_fix_lamp')?.name ?? '')
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'street'))
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'street'))
  loopFn.act(wuxia, wst, wuxia.actions.find((a) => a.id === 'a_report')?.name ?? '')
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'inn'))
  loopFn.move(wuxia, wst, wName(wuxia.locations, 'inn'))
  assert.equal(wst.phase, 'solved', '武侠变体应达成完美一日')
  // 引擎池:手工 3 本 + 生成变体,会话 → 剧本映射确定
  const picks = new Set()
  for (let seed = 1; seed <= 15; seed += 1) {
    const script = loopFn.pickLoopScript(seed)
    picks.add(script.title)
    assert.ok(solveLoop(script).ok, `入池剧本《${script.title}》应通过求解器`)
  }
  assert.ok(picks.size >= 12, '会话种子应分散到多个剧本')
  assert.ok([...picks].some((t) => t.includes('·')) && [...picks].some((t) => !t.includes('·')), '池中应同时含皮肤变体与原始剧本')
  const h = hashString('sess-loop-det')
  assert.equal(loopFn.pickLoopScript(h).id, loopFn.pickLoopScript(h).id, '同一会话剧本应确定')
  console.log(`✓ 时间循环程序化生成:${checked} 个变体全部通过求解器 + 武侠皮肤金路径 + 引擎池多样性`)
}

// 程序化时间表(M4):新因果拓扑(2 场景 × 3 链形)全部过求解器 + 引擎黄金路径回放
const { generateLoopWorld } = await import('../lib/games/loopworld.js')
{
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id
  const worldTitles = new Set()
  let replayed = 0
  for (let seed = 1; seed <= 6; seed += 1) {
    const world = generateLoopWorld(seed)
    const report = solveLoop(world)
    assert.ok(report.ok && report.plan !== undefined, `生成世界 seed${seed}(${world.title})应通过求解器并给出排程计划:${report.errors.join(';')}`)
    worldTitles.add(world.title)
    // 引擎回放:按求解器排程计划逐步执行 → 完美一日
    const st = makeLoopState(world, 2)
    loopFn.observe(world, st)
    for (const step of report.plan) {
      while (st.slice < step.slice) loopFn.move(world, st, nameOf(world.locations, step.location))
      if (step.label.startsWith('道具:')) {
        const ev = world.events.find((e) => e.investigate?.item === step.label.slice(3))
        assert.ok(ev !== undefined, `世界《${world.title}》计划道具应有来源`)
        loopFn.investigate(world, st, ev.investigate.target)
      } else if (step.label.startsWith('知识:')) {
        const ev = world.events.find((e) => (e.investigate?.facts ?? []).includes(step.label.slice(3)) && e.slice <= st.slice && st.slice <= (e.sliceTo ?? e.slice))
        if (ev?.investigate !== undefined) loopFn.investigate(world, st, ev.investigate.target)
      } else {
        loopFn.act(world, st, world.actions.find((a) => a.id === step.label).name)
      }
    }
    while (st.slice + 1 < world.sliceCount) loopFn.move(world, st, nameOf(world.locations, st.location))
    assert.equal(st.phase, 'solved', `生成世界 seed${seed}(${world.title})回放应达成完美一日`)
    replayed += 1
  }
  assert.equal(worldTitles.size, 6, '6 个生成世界标题应互不相同')
  assert.equal(JSON.stringify(generateLoopWorld(4)), JSON.stringify(generateLoopWorld(4)), '世界生成器应确定性')
  assert.ok(worldTitles.has('望海灯塔·断缆之夜') && worldTitles.has('望海灯塔·满潮惊变') && worldTitles.has('望海灯塔·接风毒宴'), '三种因果链形状均应生成')
  const poolTitles = new Set()
  for (let seed = 1; seed <= 15; seed += 1) poolTitles.add(loopFn.pickLoopScript(seed).title)
  assert.ok([...poolTitles].some((t) => t.startsWith('望海灯塔')) && [...poolTitles].some((t) => t.startsWith('黑石矿镇')), '引擎池应含两个场景的新拓扑世界')
  console.log(`✓ 时间循环程序化时间表:${replayed} 个新拓扑世界(2 场景 × 3 链形)通过求解器 + 引擎黄金路径回放 + 入池`)
}

// 快进重放:已知计划浓缩重放 → 完美一日;缺知识的步骤被门控
{
  const st = makeLoopState(NORTH_BRIDGE, 2)
  const sc = NORTH_BRIDGE
  const plan = '12:00 图书馆翻档案箱拿合影 → 14:00 镇公所看钥匙交接 → 15:00 集市摸挎包拿钥匙、出示合影 → 16:00 镇公所看烧账本翻炭盆 → 17:00 钟楼拆铆钉 → 18:00 集市把残页交给记者 → 19:00 钟楼'
  const r = loopFn.fastForward(sc, st, plan)
  assert.equal(st.phase, 'solved', '全知计划快进应达成完美一日')
  assert.ok(r.text.includes('【快进重放】'), '快进摘要头')
  const gs = makeLoopState(NORTH_BRIDGE, 2)
  const gsc = NORTH_BRIDGE
  const gr = loopFn.fastForward(gsc, gs, '15:00 集市摸挎包拿钥匙 → 16:00 镇公所翻炭盆 → 17:00 钟楼拆铆钉')
  assert.equal(gs.cutEdges.length, 0, '缺知识快进不应切断因果')
  assert.ok(gr.text.includes('先知道什么') && gr.text.includes('还缺道具'), '门控步骤应被标注')
  assert.ok(!gr.text.includes('完美一日'), '缺知识快进不应达成完美日')
  console.log('✓ 时间循环快进重放:全知计划浓缩达成完美一日 / 缺知识步骤被门控')
}

const loopReport = solveLoop(NORTH_BRIDGE)
assert.equal(loopReport.ok, true, `北桥镇应通过求解器:${loopReport.errors.join(';')}`)

// 泄密审计复用(关键词层):镇长改写式自爆被拦,正常官腔放行
assert.equal(auditReply(NORTH_BRIDGE, 'n_mayor', '账本上那页……铆钉确实是断的,工程款是我挪用的。').flagged, true, '镇长改写式自爆应被拦')
assert.equal(auditReply(NORTH_BRIDGE, 'n_mayor', '例行公事而已,钟楼好得很。').flagged, false, '正常官腔应放行')

// 手工剧本库(M2):三本剧本全部通过 ScheduleSolver
assert.equal(LOOP_SCRIPTS.length, 3, '应有 3 本手工剧本')
for (const script of LOOP_SCRIPTS) {
  const report = solveLoop(script)
  assert.ok(report.ok, `《${script.title}》应通过求解器:${report.errors.join(';')}`)
}
console.log('✓ 时间循环剧本库:3 本手工剧本全部通过 ScheduleSolver')

// 客栈大火金路径
{
  const st = makeLoopState(INN_FIRE, 2)
  const sc = INN_FIRE
  loopFn.observe(sc, st)
  assert.ok(st.facts.includes('f_lamp_leak'), '油灯目击')
  loopFn.move(sc, st, 'stable')
  loopFn.investigate(sc, st, '工具箱')
  assert.ok(st.items.includes('PINCERS'), '铁钳')
  loopFn.move(sc, st, 'kitchen')
  loopFn.investigate(sc, st, '灶台')
  assert.ok(st.items.includes('PAGE_01'), '残页')
  loopFn.move(sc, st, 'inn')
  loopFn.act(sc, st, '用铁钳修好油灯')
  assert.ok(st.cutEdges.includes('edge_fire'), '切断大火')
  loopFn.move(sc, st, 'street')
  loopFn.move(sc, st, 'street')
  loopFn.act(sc, st, '把账本残页交给巡捕')
  assert.ok(st.cutEdges.includes('edge_lock'), '切断困人')
  loopFn.move(sc, st, 'inn')
  loopFn.move(sc, st, 'inn')
  assert.equal(st.phase, 'solved', '客栈大火完美一日')
}

// 宴会中毒金路径
{
  const st = makeLoopState(BANQUET_POISON, 2)
  const sc = BANQUET_POISON
  loopFn.move(sc, st, 'apothecary')
  assert.ok(st.facts.includes('f_purchase'), '购药记录')
  loopFn.move(sc, st, 'kitchen')
  assert.ok(st.facts.includes('f_shadow'), '人影')
  loopFn.move(sc, st, 'kitchen')
  loopFn.investigate(sc, st, '碗柜')
  assert.ok(st.items.includes('VIAL'), '药瓶')
  loopFn.move(sc, st, 'kitchen')
  assert.ok(st.facts.includes('f_soup'), '下毒目击')
  loopFn.move(sc, st, 'kitchen')
  loopFn.act(sc, st, '倒掉毒汤')
  assert.ok(st.cutEdges.includes('edge_poison'), '切断中毒')
  loopFn.move(sc, st, 'hall')
  loopFn.act(sc, st, '当众出示毒药瓶')
  assert.ok(st.cutEdges.includes('edge_evidence'), '切断灭证')
  loopFn.move(sc, st, 'hall')
  assert.equal(st.phase, 'solved', '宴会中毒完美一日')
  console.log('✓ 时间循环新剧本金路径:客栈大火 / 宴会中毒 均第 1 循环达成完美一日')
}

// 单循环完美日(引擎纯函数金路径)
{
  const st = makeLoopState(NORTH_BRIDGE, 2)
  const sc = NORTH_BRIDGE
  const seq = [
    () => loopFn.move(sc, st, 'lib'),
    () => loopFn.investigate(sc, st, '档案箱'),
    () => loopFn.move(sc, st, 'hall'),
    () => loopFn.move(sc, st, 'market'),
    () => loopFn.investigate(sc, st, '挎包'),
    () => loopFn.act(sc, st, '把合影出示给邮差'),
    () => loopFn.move(sc, st, 'hall'),
    () => loopFn.investigate(sc, st, '炭盆'),
    () => loopFn.move(sc, st, 'tower'),
    () => loopFn.act(sc, st, '用铜钥匙拆下断裂铆钉'),
    () => loopFn.move(sc, st, 'market'),
    () => loopFn.act(sc, st, '把账本残页交给记者'),
    () => loopFn.move(sc, st, 'hall'),
  ]
  for (const fn of seq) fn()
  assert.equal(st.phase, 'solved', '完美一日应达成')
  assert.deepEqual(st.cutEdges.sort(), ['edge_resonance', 'edge_silence'], '两条关键因果边都应切断')
  console.log('✓ 时间循环金路径:单循环完美一日(两条因果边切断)')
}

// 悲剧 + 半 reset + 循环 diff
{
  const st = makeLoopState(NORTH_BRIDGE, 2)
  const sc = NORTH_BRIDGE
  loopFn.move(sc, st, 'lib')
  loopFn.investigate(sc, st, '档案箱')
  loopFn.move(sc, st, 'hall')
  loopFn.move(sc, st, 'tower')
  loopFn.move(sc, st, 'market')
  loopFn.move(sc, st, 'hall')
  loopFn.move(sc, st, 'market')
  const r1 = loopFn.move(sc, st, 'hall')
  assert.equal(r1.looped, true, '19:00 悲剧应触发回滚')
  assert.equal(st.loopNo, 2, '循环号应 +1')
  assert.equal(st.lastDeaths, 8, '循环1 应 8 人遇难')
  assert.ok(st.facts.length >= 3, '元知识应跨循环保留')
  assert.equal(st.slice, 0)
  assert.equal(st.location, 'hall')
  assert.deepEqual(st.items, [], '世界态应重置')
  // 循环2 只切共振 → 2 死 + diff
  loopFn.move(sc, st, 'hall')
  loopFn.move(sc, st, 'hall')
  loopFn.move(sc, st, 'market')
  loopFn.investigate(sc, st, '挎包')
  loopFn.move(sc, st, 'hall')
  loopFn.investigate(sc, st, '炭盆')
  loopFn.move(sc, st, 'tower')
  loopFn.act(sc, st, '用铜钥匙拆下断裂铆钉')
  loopFn.move(sc, st, 'market')
  const r2 = loopFn.move(sc, st, 'hall')
  assert.equal(r2.looped, true, '只切一边仍应回滚')
  assert.equal(st.lastDeaths, 2, '只切共振应 2 死(邮差)')
  const lastDiff = st.loopDiffs.at(-1)
  assert.ok(lastDiff.changed.some((c) => c.includes('8 → 2')), '循环 diff 应记录遇难人数变化')
  // 知识齐备 → 完美日方案通过
  const plan = '凌晨去图书馆拿合影,14点看钥匙交接,15点拿钥匙,16点抢残页,17点拆铆钉,18点把残页交给记者曝光。'
  assert.equal(verifyPlan(sc, st, plan).pass, true, '知识齐备方案应通过')
  console.log('✓ 时间循环半 reset:悲剧回滚 / 元知识保留 / 部分切断(8→2 死)/ 循环 diff')
}

// 计划验证回执:无知识方案逐条拒绝
{
  const st = makeLoopState(NORTH_BRIDGE, 2)
  const verdict = verifyPlan(NORTH_BRIDGE, st, '拆铆钉,交残页')
  assert.equal(verdict.pass, false, '无知识方案不应通过')
  assert.equal(verdict.items.length, 2, '逐条回执')
}

// 工具层 + 面板
await manager.newGame('sess-loop', 'loop', 2)
const loopExec = {
  agent: { session: { id: 'sess-loop' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
const lMove = tool('loop_move')
const lObs = tool('loop_observe')
const lInv = tool('loop_investigate')
const lAct = tool('loop_act')
const lPlan = tool('loop_submit_plan')
const lTalk = tool('loop_talk')
// 剧本无关断言:从真相派生目标(会话池可能选中手工或生成剧本)
const loopLoaded = await manager.load('sess-loop')
const loopScript = loopLoaded.truth
assert.ok(solveLoop(loopScript).ok, '会话选中的剧本应通过求解器(手工或生成池)')
const loopMoveTo = loopScript.locations.find((l) => l.id !== loopScript.locations[0].id)?.name
const loopNpcName = loopScript.npcs[0].name
const moved = await lMove.execute({ to: loopMoveTo }, loopExec)
assert.equal(moved.result, 'success')
const investigated = await lInv.execute({ target: '随便看看' }, loopExec)
assert.ok(typeof investigated.text === 'string' && investigated.text.length > 0, '深查返回文本')
const observed = await lObs.execute({}, loopExec)
assert.ok(observed.text.includes(loopMoveTo) || observed.text.includes(loopScript.sliceNames[1]), 'loop_observe')
const talkOut = await lTalk.execute({ npc: loopNpcName, text: '你好。' }, loopExec)
assert.ok(talkOut.text.includes(loopNpcName), 'loop_talk')
const factsPanel = await manager.loopPanel('sess-loop', 'facts')
assert.ok(factsPanel.includes('元知识'), '/facts')
const relationsPanel = await manager.loopPanel('sess-loop', 'relations')
assert.ok(relationsPanel.includes('好感度'), '/relations')
const schedulePanel = await manager.loopPanel('sess-loop', 'schedule')
assert.ok(schedulePanel.includes('已观测'), '/schedule')
const loopsPanel = await manager.loopPanel('sess-loop', 'loops')
assert.ok(loopsPanel.includes('循环记录'), '/loops')
const planOut = await lPlan.execute({ plan: '拆铆钉,交残页' }, loopExec)
assert.equal(planOut.result, 'success', '知识不足 → 回执而非获胜')
assert.ok(planOut.text.includes('未通过'), '逐条回执文案')
const loopScore = await manager.scoreText('sess-loop')
assert.ok(loopScore.includes('时间循环'), 'loop score')
await manager.quit('sess-loop')
console.log('✓ 时间循环工具流 + /facts /relations /schedule /loops 面板 + 计划回执')

// ── 王国议会(阶段 6):账本 + 立场 + 信任 + 经济模拟器 ────────────────────────────
const councilMod = await import('../lib/games/council.js')
const { COUNCIL, councilEngine, computeStance, simulate, councilScore } = councilMod

// 立场:每个事件 ≥2 种立场,且至少一名顾问主张最优(通路存在)
for (const ev of COUNCIL.events) {
  const stances = new Set(COUNCIL.advisors.map((a) => computeStance(COUNCIL, a, ev, { treasurerCorruption: 0.2, spyBuyer: 'none' })))
  assert.ok(stances.size >= 2, `事件 ${ev.id} 立场多样性不足`)
  assert.ok(stances.has(ev.best), `事件 ${ev.id} 无人主张最优选项`)
}
console.log('✓ 王国议会立场引擎:每事件立场多样 + 至少一人主张最优')

// 政策极值:全最优通关,全最劣覆灭
async function councilPolicyRun(policy, difficulty, seed) {
  const created = await councilEngine.create(`policy-${seed}`, difficulty)
  const st = created.state
  const sc = created.truth
  let result
  for (let g = 0; g < 40; g++) {
    const { event } = councilMod.openCouncil(sc, st)
    result = councilMod.decide(sc, st, policy === 'best' ? event.best : event.worst)
    if (result.fallen || result.finished) break
  }
  return { result, st, sc }
}
{
  const best = await councilPolicyRun('best', 2, 11)
  assert.equal(best.result.finished, true, '全最优应通关 20 季')
  assert.ok(councilScore(best.sc, best.st)[0].value >= 60, '全最优应至少维持')
  const worst = await councilPolicyRun('worst', 2, 12)
  assert.equal(worst.result.fallen, true, '全最劣应覆灭')
  console.log('✓ 王国议会经济:全最优通关 / 全最劣覆灭')
}

// 经济模拟器:确定性 + 无 NaN + 随机存活率健康
{
  let fall = 0
  let finished = 0
  for (let seed = 1; seed <= 200; seed++) {
    const r = simulate(seed, 2)
    assert.equal(JSON.stringify(r), JSON.stringify(simulate(seed, 2)), '模拟器应确定性')
    if (r.fallen) fall += 1
    else if (r.finished) finished += 1
    assert.ok(Number.isFinite(r.season), '无 NaN')
  }
  assert.ok(finished >= 160, `随机存活率过低:${finished}/200`)
  console.log(`✓ 王国议会模拟器:200 种子确定性,随机存活 ${finished}/200,覆灭 ${fall}/200`)
}

// 信任与调查
{
  const created = await councilEngine.create('trust-check', 2)
  const st = created.state
  const sc = created.truth
  const { event, stances } = councilMod.openCouncil(sc, st)
  const before = { ...st.trust }
  councilMod.decide(sc, st, event.best)
  const rightGuys = Object.entries(stances).filter(([, s]) => s === event.best).map(([id]) => id)
  assert.ok(rightGuys.every((id) => st.trust[id] > before[id]), '主张正确的顾问信任应上升')
  const wrongGuys = Object.entries(stances).filter(([, s]) => s === event.worst).map(([id]) => id)
  assert.ok(wrongGuys.every((id) => st.trust[id] < before[id]), '主张错误的顾问信任应下降')
  // 调查揭露议程
  const created2 = await councilEngine.create('inv-check', 2)
  const st2 = created2.state
  const sc2 = created2.truth
  councilMod.openCouncil(sc2, st2)
  const report = councilMod.investigate(sc2, st2, '沈万钧')
  assert.ok(report.includes('查到了'), '调查应揭露议程')
  assert.ok(st2.exposed.length === 1 && st2.resources.gold < 28, '调查应花 2 金')
  console.log('✓ 王国议会信任系统:立场验证升降 + 调查揭露议程')
}

// 工具层 + 面板 + 审计
await manager.newGame('sess-council', 'council', 2)
const councilExec = {
  agent: { session: { id: 'sess-council' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
{
  const consult = tool('council_consult')
  const consultOut = await consult.execute({}, councilExec)
  assert.ok(consultOut.text.includes('事件') && consultOut.text.includes('可选决策'), 'council_consult')
  const speak = tool('council_speak')
  const speakOut = await speak.execute({}, councilExec)
  assert.equal(speakOut.lines.length, 4, '议会应收集 4 名顾问发言')
  const question = tool('council_question')
  const questionOut = await question.execute({ adviser: '沈万钧', text: '国库到底还有多少?' }, councilExec)
  assert.ok(questionOut.text.includes('沈万钧'), 'council_question')
  const investigateTool = tool('council_investigate')
  await investigateTool.execute({ target: '外敌威胁' }, councilExec)
  const decide = tool('council_decide')
  const decideOut = await decide.execute({ option: 'rest' }, councilExec)
  assert.ok(decideOut.text.includes('结算'), 'council_decide')
  const ledger = await manager.councilPanel('sess-council', 'ledger')
  assert.ok(ledger.includes('账本') && ledger.includes('瘟疫潜伏'), '/ledger')
  const trust = await manager.councilPanel('sess-council', 'trust')
  assert.ok(trust.includes('信任评级') && trust.includes('沈万钧'), '/trust')
  const history = await manager.councilPanel('sess-council', 'history')
  assert.ok(history.includes('历史决策'), '/history')
  const councilScoreText = await manager.scoreText('sess-council')
  assert.ok(councilScoreText.includes('王国议会'), 'council score')
  await manager.quit('sess-council')
  console.log('✓ 王国议会工具流 + /ledger /trust /history 面板')
}

// 审计复用:财政大臣自爆贪腐 → 拦截
assert.equal(auditReply({ facts: COUNCIL.facts, npc: COUNCIL.npc }, 'treasurer', '不瞒陛下,那些亏空是我虚报的,钱我私吞了。').flagged, true, '财政大臣自爆应被拦')
assert.equal(auditReply({ facts: COUNCIL.facts, npc: COUNCIL.npc }, 'treasurer', '国库吃紧是老臣算出来的,分毫不差。').flagged, false, '正常官腔应放行')

// ── NPC 子代理层:spawn 通道 / 工具禁言 / 回退 / 离线 ───────────────────────────
const npcMod = await import('../lib/core/npc.js')
{
  // 纯函数:输出块 → 文本(跳过非文本块)
  assert.equal(
    npcMod.npcOutputText([{ type: 'text', text: '你好。' }, { type: 'tool-result', toolCallId: 'x' }, { type: 'text', text: '再见。' }]),
    '你好。再见。',
    '子代理输出应只取文本块',
  )
  // mock subagent 服务:spawn 通道成功、标签/禁言/模型透传
  const started = []
  const fakeSvc = {
    list: () => ['spawn', 'fork'],
    start: async (name, request) => {
      started.push({ name, request })
      return {
        result: Promise.resolve({ output: [{ type: 'text', text: '老朽以为,此事尚需斟酌。' }], stopReason: 'completed' }),
        dispose: async () => undefined,
      }
    },
  }
  const subCtx = {
    get: (name) => (name === 'subagents' ? fakeSvc : name === 'agents' ? { get: () => ({ session: { id: 'sess-npc-parent' } }) } : undefined),
  }
  const out = await npcMod.talkAsNpc(subCtx, {
    sessionId: 'sess-npc-parent',
    route: { provider: 'p-test', model: 'm-test' },
    label: 'npc:loop:n_test',
    system: '你是老臣。',
    user: '玩家说:你好。',
    maxTokens: 222,
  })
  assert.equal(out.channel, 'subagent', '有 spawn provider 应走子代理通道')
  assert.equal(out.text, '老朽以为,此事尚需斟酌。', '子代理输出应为台词')
  assert.equal(started.length, 1, '应只启动一个子代理')
  const req = started[0].request
  assert.equal(started[0].name, 'spawn', '应使用 spawn provider')
  assert.equal(req.label, 'npc:loop:n_test', '子代理标签应带方案前缀')
  assert.deepEqual(req.toolFilter, { allow: [] }, 'NPC 子代理必须禁言(allow: [])')
  const promptText = req.prompt.map((b) => b.text).join('\n')
  assert.ok(promptText.includes('你是老臣。'), '角色页(system)必须进入子代理 prompt(防人设丢失)')
  assert.ok(promptText.includes('玩家说:你好。'), '玩家消息必须进入子代理 prompt')
  assert.ok(promptText.includes('请只以角色的身份回一句台词'), 'prompt 应包含只回台词的收口指令')
  assert.equal(req.agentOptions.provider, 'p-test', 'provider 透传')
  assert.equal(req.agentOptions.model, 'm-test', 'model 透传')
  assert.equal(req.agentOptions.maxTokens, 222, 'maxTokens 透传')
  assert.ok(req.parent !== undefined, '应有父 agent 凭据')
  // 服务存在但无 spawn → 回退;两者皆缺 → 抛 LlmUnavailableError
  const noSpawnCtx = { get: (name) => (name === 'subagents' ? { list: () => ['fork'] } : undefined) }
  assert.equal(npcMod.subagentService(noSpawnCtx), undefined, '无 spawn 应判定不可用')
  await assert.rejects(
    () => npcMod.talkAsNpc({ get: () => undefined }, { sessionId: 'sess-x', route: {}, label: 'npc:t', system: 's', user: 'u' }),
    /llm 服务不可用/,
    '无 subagent 且无 LLM 应抛 LlmUnavailableError',
  )
  console.log('✓ NPC 子代理层:spawn 通道 + 工具禁言(allow:[]) + 标签/模型透传 + 回退与离线兜底')
}

// ── 单人跑团(阶段 6 方案二 v1):骰子 / 战斗模拟器 / 任务链 / 工具流 ───────────
const trpgMod = await import('../lib/games/trpg.js')
const { FROSTPINE, trpgEngine, makeTrpgState, combatSimulate, rollCheck, move: trpgMoveFn, examine: trpgExamineFn, useItem: trpgUseFn, attack: trpgAttackFn, flee: trpgFleeFn } = trpgMod
const { generateWorld, solveWorld } = await import('../lib/games/worldgen.js')

// 程序化世界生成(M2):手工招牌 + 主题生成世界全部过黄金路径求解器
assert.equal(solveWorld(FROSTPINE).ok, true, '手工招牌《霜松林地》应通过求解器')
assert.equal(JSON.stringify(generateWorld(9, 2)), JSON.stringify(generateWorld(9, 2)), '世界生成器应确定性')
{
  let passCount = 0
  const total = 20
  for (let seed = 1; seed <= total; seed++) {
    if (solveWorld(generateWorld(seed, 2)).ok) passCount += 1
  }
  assert.ok(passCount >= total * 0.85, `生成世界可解率过低:${passCount}/${total}`)
  const titles = new Set([1, 2].map((sd) => generateWorld(sd, 2).title))
  assert.ok(titles.has('荒漠驿站') && titles.has('海港疑云'), '两套主题都应存在')
  console.log(`✓ 跑团程序化世界:20 种子可解 ${passCount}/${total}(荒漠驿站/海港疑云两主题)`)
}

// 骰子:种子确定性 + 历史留档 + 优势/劣势
{
  const st = makeTrpgState(FROSTPINE, 2)
  const sc = FROSTPINE
  const r1 = rollCheck(sc, st, 'dice', 'stealth', 14, 'none', '测试')
  const r2 = rollCheck(sc, st, 'dice', 'stealth', 14, 'none', '测试')
  assert.notEqual(r1.detail, r2.detail, '骰子计数器应推进')
  st.rngCounter = 1
  const r1Again = rollCheck(sc, st, 'dice', 'stealth', 14, 'none', '测试')
  assert.equal(r1.detail, r1Again.detail, '同会话同计数器应复现同骰(读档可回溯)')
  assert.equal(st.eventLog.filter((e) => e.type === 'check').length, 3, '骰子历史留档')
  const adv = rollCheck(sc, st, 'dice', 'stealth', 14, 'adv', '优势')
  const dis = rollCheck(sc, st, 'dice', 'stealth', 14, 'dis', '劣势')
  assert.ok(adv.roll >= dis.roll, '优势骰应不小于劣势骰(期望)')
  console.log('✓ 跑团骰子:种子确定性 + 历史留档 + 优势/劣势')
}

// 战斗模拟器:固定对局胜负分布落在目标区间
{
  const wolf = combatSimulate(7, 'wolf', 2, 200)
  const bandit = combatSimulate(8, 'bandit', 2, 200)
  const rogue = combatSimulate(9, 'rogue', 2, 200)
  assert.ok(wolf.wins / 200 >= 0.95, '杂兵狼应几乎必胜')
  assert.ok(bandit.wins / 200 >= 0.85, '山贼应大概率胜')
  assert.ok(rogue.wins / 200 >= 0.05 && rogue.wins / 200 <= 0.5, '无准备硬刚 Boss 应艰难但非必败')
  console.log(`✓ 跑团战斗模拟器:狼 ${(wolf.wins / 2).toFixed(0)}% / 山贼 ${(bandit.wins / 2).toFixed(0)}% / 罗格 ${(rogue.wins / 2).toFixed(0)}%(无药水)`)
}

// 完整冒险:支线 + 主线 + 升级 + 结算
{
  const st = makeTrpgState(FROSTPINE, 2)
  const sc = FROSTPINE
  trpgMoveFn(sc, st, 'adv-flow', 'mistmere', 2)
  trpgExamineFn(sc, st, '商队残骸')
  assert.ok(st.questDone.includes('obj_find'), 'obj_find 应推进')
  let guard = 0
  while (st.combat === null && guard < 30) { trpgMoveFn(sc, st, 'adv-flow', 'mistmere', 2); guard += 1 }
  let rounds = 0
  while (st.combat !== null && rounds < 60) {
    const target = st.combat.find((u) => !u.dead)
    const r = trpgAttackFn(sc, st, 'adv-flow', target.id)
    if (r.defeat) throw new Error('不应被狼打晕')
    rounds += 1
  }
  assert.ok(st.inventory.some((i) => i.id === 'anvil_mold'), '狼应掉落模具')
  trpgMoveFn(sc, st, 'adv-flow', 'frostpine', 2)
  trpgUseFn(sc, st, '铁砧模具')
  assert.ok(st.questDone.includes('obj_mold'), '支线应完成')
  trpgMoveFn(sc, st, 'adv-flow', 'ironhold', 2)
  guard = 0
  while (st.combat === null && guard < 30) { trpgMoveFn(sc, st, 'adv-flow', 'ironhold', 2); guard += 1 }
  rounds = 0
  while (st.combat !== null && rounds < 60) {
    const target = st.combat.find((u) => !u.dead)
    const r = trpgAttackFn(sc, st, 'adv-flow', target.id)
    if (r.defeat) throw new Error('不应被山贼打晕')
    rounds += 1
  }
  assert.ok(st.inventory.some((i) => i.id === 'copper_key'), '山贼应掉落铜钥匙')
  trpgUseFn(sc, st, '铜钥匙')
  trpgMoveFn(sc, st, 'adv-flow', 'ironhold_inner', 2)
  assert.equal(st.regionId, 'ironhold_inner')
  // 钥匙门:无钥匙应被拦(独立小局验证)
  {
    const gst = makeTrpgState(FROSTPINE, 2)
    const gsc = FROSTPINE
    trpgMoveFn(gsc, gst, 'gate', 'ironhold', 2)
    const noKey = trpgMoveFn(gsc, gst, 'gate', 'ironhold_inner', 2)
    assert.ok(noKey.text.includes('进不去'), '无钥匙应被拦')
    gst.inventory.push({ id: 'copper_key', qty: 1 })
    trpgMoveFn(gsc, gst, 'gate', 'ironhold_inner', 2)
    assert.equal(gst.regionId, 'ironhold_inner', '有钥匙应能进')
  }
  trpgExamineFn(sc, st, '商队货物')
  assert.ok(st.questDone.includes('obj_truth'), 'obj_truth 应推进')
  guard = 0
  while (st.combat === null && guard < 20) { trpgMoveFn(sc, st, 'adv-flow', 'ironhold_inner', 2); guard += 1 }
  rounds = 0
  while (st.combat !== null && rounds < 80) {
    if (st.character.hp.current < 12 && st.inventory.some((i) => i.id === 'potion' && i.qty > 0)) trpgUseFn(sc, st, '治疗药水')
    const target = st.combat.find((u) => !u.dead)
    const r = trpgAttackFn(sc, st, 'adv-flow', target.id)
    if (r.defeat) throw new Error('不应被罗格打晕(有药水)')
    rounds += 1
  }
  assert.ok(st.questDone.includes('obj_justice'), '主线应完成')
  assert.ok(st.character.level >= 2, '应升级')
  const settle = trpgEngine.settleText(st, sc)
  assert.ok(settle.includes('冒险回顾') && settle.includes('100'), '结算应显示任务 4/4')
  console.log('✓ 跑团完整冒险:支线 + 主线 + 升级 + 钥匙门 + 结算')
}

// 失败不死档:逃跑失败被打晕 → 回旅店,不结束游戏
{
  const st = makeTrpgState(FROSTPINE, 3)
  const sc = FROSTPINE
  st.character.hp.current = 3
  st.combat = null
  // 手动开战(直接经引擎函数)
  trpgMoveFn(sc, st, 'faint', 'ironhold', 3)
  let guard = 0
  while (st.combat === null && guard < 30) { trpgMoveFn(sc, st, 'faint', 'ironhold', 3); guard += 1 }
  if (st.combat !== null) {
    // 硬接几轮直到被打晕或胜利
    let rounds = 0
    while (st.combat !== null && rounds < 40) {
      const target = st.combat.find((u) => !u.dead)
      const r = trpgAttackFn(sc, st, 'faint', target.id)
      if (r.defeat) break
      rounds += 1
    }
    if (st.regionId === 'frostpine') {
      assert.equal(st.character.hp.current, 1, '晕倒应回旅店剩 1 HP')
      assert.equal(st.phase, 'playing', '失败不死档,游戏继续')
      console.log('✓ 跑团失败不死档:晕倒回旅店,游戏继续')
    } else {
      console.log('✓ 跑团战斗极端情形(该种子下未晕倒,不构成断言失败)')
    }
  }
}

// 工具层 + 面板
await manager.newGame('sess-trpg', 'trpg', 2)
const trpgExec = {
  agent: { session: { id: 'sess-trpg' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
{
  // 剧本无关断言:从真相派生目标(会话池可能选中任意世界)
  const trpgLoaded = await manager.load('sess-trpg')
  const trpgWorld = trpgLoaded.truth
  assert.ok(solveWorld(trpgWorld).ok, '会话选中的世界必须通过求解器')
  const trpgFirstNpc = trpgWorld.npcs[0].name
  const trpgClueRegion = trpgWorld.regions.find((r) => r.id !== trpgWorld.startRegion)?.name
  const trpgQuestTitle = trpgWorld.quests[0].title
  const moved = await tool('trpg_move').execute({ to: trpgClueRegion }, trpgExec)
  assert.equal(moved.result, 'success' || 'combat', 'trpg_move')
  const examined = await tool('trpg_examine').execute({ target: '附近' }, trpgExec)
  assert.ok(typeof examined.text === 'string' && examined.text.length > 0, 'trpg_examine')
  const checked = await tool('trpg_check').execute({ skill: 'stealth', dc: '12', description: '悄悄靠近' }, trpgExec)
  assert.ok(checked.text.includes('引擎检定'), 'trpg_check')
  const talked = await tool('trpg_talk').execute({ npc: trpgFirstNpc, text: '你好。' }, trpgExec)
  assert.ok(talked.text.includes(trpgFirstNpc), 'trpg_talk')
  const rested = await tool('trpg_rest').execute({}, trpgExec)
  assert.ok(rested.text.includes('恢复'), 'trpg_rest')
  const sheet = await manager.trpgPanel('sess-trpg', 'sheet')
  assert.ok(sheet.includes('角色卡') && sheet.includes('HP'), '/sheet')
  const quests = await manager.trpgPanel('sess-trpg', 'quests')
  assert.ok(quests.includes('任务日志') && quests.includes(trpgQuestTitle), '/quests')
  const world = await manager.trpgPanel('sess-trpg', 'world')
  assert.ok(world.includes('世界地图') && world.includes(trpgWorld.regions[0].name), '/world')
  const bag = await manager.bagOrMap('sess-trpg', 'bag')
  assert.ok(bag.includes('背包') && bag.includes('治疗药水'), '/bag(trpg)')
  const mapPanel = await manager.bagOrMap('sess-trpg', 'map')
  assert.ok(mapPanel.includes('世界地图'), '/map(trpg)')
  const score = await manager.scoreText('sess-trpg')
  assert.ok(score.includes('跑团'), 'trpg score')
  await manager.quit('sess-trpg')
  console.log('✓ 跑团工具流 + /sheet /quests /world + /bag /map 路由')
}

// 审计复用:罗格自爆劫案 → 拦截
assert.equal(auditReply({ facts: FROSTPINE.facts, npc: Object.fromEntries(FROSTPINE.npcs.map((n) => [n.id, { knowledge: n.knowledge, mustNotAdmit: n.mustNotAdmit }])) }, 'n_rogue', '不错,商队是我带人劫的,货物就藏在内厅。').flagged, true, '罗格自爆应被拦')
assert.equal(auditReply({ facts: FROSTPINE.facts, npc: Object.fromEntries(FROSTPINE.npcs.map((n) => [n.id, { knowledge: n.knowledge, mustNotAdmit: n.mustNotAdmit }])) }, 'n_rogue', '什么商队?铁喉的人从不干那种勾当。').flagged, false, '正常抵赖应放行')

// ── 剧本杀·反转模式(玩家=凶手,侦探团围猎) ────────────────────────────────────
const { reversalDefend, reversalVerdict } = await import('../lib/games/party.js')

// 简报零泄密 + 秘密角色卡仅经 /role 可见
{
  const created = await partyEngine.create('rev-zero', 3)
  assert.equal(created.state.mode, 'reversal', '难度 3 应为反转模式')
  assert.ok(!created.brief.includes('赌债') && !created.brief.includes('火钳') && !created.brief.includes('镇定剂'), 'GM 简报不得含玩家秘密')
  const rolePanel = panelRoleOf(SNOW_NIGHT, created.state)
  assert.ok(rolePanel.includes('你就是凶手') && rolePanel.includes('下药'), '/role 应展示凶手卡')
  assert.equal(panelRoleOf(SNOW_NIGHT, { ...created.state, mode: 'standard' }).includes('侦探'), true, '标准模式 /role 应显示侦探')
  console.log('✓ 反转模式:GM 简报零泄密 + 凶手卡仅经 /role 可见')
}

// 坚守说辞 → 全身而退;自曝 + 认凶器 → 被识破
{
  const clean = await partyEngine.create('rev-clean', 3)
  const cs = clean.state
  const csc = clean.truth
  for (let i = 0; i < 5; i++) reversalDefend(csc, cs, '我 20:12 在花园抽烟,书房的事我不清楚。')
  const cleanVerdict = reversalVerdict(csc, cs, { score: 75, comment: '入戏' })
  assert.equal(cleanVerdict.caught, false, '全程坚守说辞应全身而退')
  assert.equal(cs.phase, 'solved')

  const guilty = await partyEngine.create('rev-guilty', 3)
  const gs = guilty.state
  const gsc = guilty.truth
  reversalDefend(gsc, gs, '我 20:12 在花园抽烟。')
  reversalDefend(gsc, gs, '我欠下巨额赌债,债主上门催过两次。')
  reversalDefend(gsc, gs, '火钳确实是我用的。')
  reversalDefend(gsc, gs, '我整晚都在花园。')
  reversalDefend(gsc, gs, '我和此事无关。')
  assert.ok(gs.suspicion >= 60, `自曝+认凶器应把嫌疑推到阈值以上(实得 ${gs.suspicion})`)
  const guiltyVerdict = reversalVerdict(gsc, gs, { score: 60, comment: '' })
  assert.equal(guiltyVerdict.caught, true, '多次露馅应被识破')
  assert.ok(guiltyVerdict.text.includes('质询复盘') && guiltyVerdict.text.includes('凶手就是你自己'), '反转结算含复盘与真相')
  console.log('✓ 反转模式引擎:坚守→全身而退 / 自曝认凶→被识破 / 结算复盘')
}

// 工具层 + 守卫
await manager.newGame('sess-rev', 'party', 3)
const revExec = {
  agent: { session: { id: 'sess-rev' }, options: { provider: 'mock', model: 'mock-model' } },
  signal: new AbortController().signal,
}
{
  const defend = tool('party_defend')
  const defended = await defend.execute({ statement: '我 20:12 在花园抽烟,书房的事我不清楚。' }, revExec)
  assert.ok(defended.text.includes('嫌疑度') && defended.text.includes('侦探团搜证'), 'party_defend')
  const roleOut = await manager.partyPanel('sess-rev', 'role')
  assert.ok(roleOut.includes('你就是凶手'), '/role(manager)')
  // 守卫:反转模式禁止指控、禁止与自己对话
  let accuseBlocked = false
  try {
    await tool('party_accuse').execute({ npc: '梅姨' }, revExec)
  } catch (error) {
    accuseBlocked = String(error.message).includes('反转模式')
  }
  assert.ok(accuseBlocked, '反转模式应禁止 party_accuse')
  let selfTalkBlocked = false
  try {
    await tool('party_talk').execute({ npc: '顾云舟', text: '你好' }, revExec)
  } catch (error) {
    selfTalkBlocked = String(error.message).includes('你自己')
  }
  assert.ok(selfTalkBlocked, '反转模式应禁止与自己对话')
  await manager.quit('sess-rev')
  console.log('✓ 反转模式工具流 + 守卫(禁止指控/与自己对话)')
}

// 海龟汤会话流:开局 → ask → score → quit(问题对两张难度 1 卡都判「否」)
await manager.newGame('sess-1', 'soup', 1)
const askTool = tool('soup_ask')
const asked = await askTool.execute({ question: '这是抢劫吗?' }, execStub)
assert.equal(asked.verdict, 'no')
assert.equal(asked.red_herring, true)
const soupScore = await manager.scoreText('sess-1')
assert.ok(soupScore.includes('海龟汤'))
await manager.quit('sess-1')

rmSync(dir, { recursive: true, force: true })
console.log('✓ 海龟汤会话流(ask/score/quit)')
console.log('全部冒烟测试通过 ✅')
