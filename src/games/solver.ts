/**
 * 可解性求解器:程序化生成案件与手工招牌案件的"硬门禁"。
 *
 * 依据策划文档 docs/01-detective.md §5.2 的四项验证:
 *   1. 可达性:关键线索都能通过勘查动作获得(其地点在 locations 中,且分散在两个以上地点);
 *   2. 充分性:关键线索集合覆盖解法事实,且拿走任一关键线索解法事实就不再完整(唯一解回溯);
 *   3. 一致性:所有引用可解析、地点/线索/事实/嫌疑人无重复、谎言与事实不冲突(结构层面);
 *   4. 红鲱鱼:每条误导线索的指向对象都有"排除"证据(可被洗清)。
 *
 * 排除语义用显式注解表达(对生成案件为硬门禁,对手工案件为兼容警告):
 *   - CaseFact.excludes: 该事实排除某嫌疑人(如不在场证明);
 *   - CaseClue.exonerates: 该线索本身即可排除某嫌疑人;
 *   - CaseClue.misleadsTo: 该线索是误导线索,指向某嫌疑人(该嫌疑人必须有排除证据);
 *   - DetectiveCase.solutionFactIds: 解法核心事实,必须由关键线索揭示。
 */

import type { CaseClue, CaseFact, DetectiveCase } from './detective.js'

export interface SolveCheck {
  name: string
  pass: boolean
  detail: string
}

export interface SolveReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  checks: SolveCheck[]
}

/** 该线索(经其 reveals)直接揭示的事实 id 集合。 */
function revealsFacts(clue: CaseClue): Set<string> {
  return new Set(clue.reveals)
}

export function solveCase(caseData: DetectiveCase): SolveReport {
  const errors: string[] = []
  const warnings: string[] = []
  const checks: SolveCheck[] = []
  const check = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail })
    if (!pass) errors.push(`[${name}] ${detail}`)
  }
  const warn = (name: string, detail: string): void => {
    warnings.push(`[${name}] ${detail}`)
  }

  const factIds = new Set(caseData.facts.map((f) => f.id))
  const clueIds = new Set(caseData.clues.map((c) => c.id))
  const suspectIds = new Set(caseData.suspects.map((s) => s.id))
  const locationSet = new Set(caseData.locations)
  const clueById = new Map(caseData.clues.map((c) => [c.id, c]))
  const factById = new Map(caseData.facts.map((f) => [f.id, f]))

  // ── 1. 结构一致性 ──────────────────────────────────────────────────────────
  const dupIds = (ids: string[]): string[] => {
    const seen = new Set<string>()
    const dup: string[] = []
    for (const id of ids) {
      if (seen.has(id)) dup.push(id)
      seen.add(id)
    }
    return dup
  }
  const dupFacts = dupIds(caseData.facts.map((f) => f.id))
  const dupClues = dupIds(caseData.clues.map((c) => c.id))
  const dupSuspects = dupIds(caseData.suspects.map((s) => s.id))
  const dupLocations = dupIds(caseData.locations)
  check('结构-事实id唯一', dupFacts.length === 0, `重复:${dupFacts.join(',')}`)
  check('结构-线索id唯一', dupClues.length === 0, `重复:${dupClues.join(',')}`)
  check('结构-嫌疑人id唯一', dupSuspects.length === 0, `重复:${dupSuspects.join(',')}`)
  check('结构-地点唯一且非空', dupLocations.length === 0 && locationSet.size > 0, `地点 ${caseData.locations.length} 个`)
  check('结构-凶手是嫌疑人', suspectIds.has(caseData.murderer), `murderer=${caseData.murderer}`)
  check('结构-关键线索', caseData.keyClueIds.length >= 2 && caseData.keyClueIds.every((k) => clueIds.has(k)), `keys=${caseData.keyClueIds.join(',')}`)
  check('结构-线索地点有效', caseData.clues.every((c) => locationSet.has(c.location)), '有线索指向未知地点')
  check(
    '结构-引用可解析',
    caseData.clues.every((c) => c.reveals.every((f) => factIds.has(f))) &&
      Object.values(caseData.npc).every((script) =>
        [...(script.knowledge ?? []), ...(script.mustNotAdmit ?? [])].every((f) => factIds.has(f)),
      ),
    'reveals/knowledge/mustNotAdmit 引用了不存在的事实',
  )
  check('结构-全员角色脚本', caseData.suspects.every((s) => caseData.npc[s.id] !== undefined), '有嫌疑人缺 npc 脚本')
  check('结构-提示数量', Array.isArray(caseData.hints) && caseData.hints.length === 3, 'hints 须为 3 条')

  // ── 2. 可达性 ──────────────────────────────────────────────────────────────
  const keyClues = caseData.keyClueIds.map((id) => clueById.get(id)).filter((c): c is CaseClue => c !== undefined)
  const keyLocations = new Set(keyClues.map((c) => c.location))
  check('可达-关键线索可勘查', keyClues.every((c) => locationSet.has(c.location)), '关键线索地点不在勘查列表')
  check('可达-关键线索分散', keyLocations.size >= 2, `关键线索集中在 ${keyLocations.size} 个地点(须 ≥2)`)

  // ── 3. 覆盖与必要性(唯一解回溯) ─────────────────────────────────────────────
  const allRevealed = new Set<string>()
  for (const c of caseData.clues) for (const f of c.reveals) allRevealed.add(f)
  const keyRevealed = new Set<string>()
  for (const c of keyClues) for (const f of c.reveals) keyRevealed.add(f)

  const solutionFacts = caseData.solutionFactIds ?? []
  const incriminating = caseData.npc[caseData.murderer]?.mustNotAdmit ?? []
  if (solutionFacts.length > 0) {
    check(
      '覆盖-解法事实由关键线索揭示',
      solutionFacts.every((f) => keyRevealed.has(f) && factIds.has(f)),
      `未被关键线索覆盖:${solutionFacts.filter((f) => !keyRevealed.has(f) || !factIds.has(f)).join(',')}`,
    )
    // 必要性:拿走任一关键线索,解法事实集不再完整(否则该线索冗余,存在"第二解"路径)
    const missing: string[] = []
    for (const k of keyClues) {
      const without = new Set<string>()
      for (const c of keyClues) {
        if (c.id === k.id) continue
        for (const f of c.reveals) without.add(f)
      }
      const lost = solutionFacts.filter((f) => !without.has(f))
      if (lost.length === 0) missing.push(k.id)
    }
    check('必要性-每条关键线索不可缺失', missing.length === 0, `冗余关键线索:${missing.join(',')}`)
  } else {
    check(
      '覆盖-凶手口供事实可达',
      incriminating.every((f) => allRevealed.has(f)),
      `未被任何线索揭示:${incriminating.filter((f) => !allRevealed.has(f)).join(',')}`,
    )
  }
  check(
    '覆盖-凶手不可承认的事实可达',
    incriminating.length > 0 && incriminating.every((f) => allRevealed.has(f)),
    `凶手 mustNotAdmit 未被线索揭示:${incriminating.filter((f) => !allRevealed.has(f)).join(',')}`,
  )

  // ── 4. 唯一性:每名非凶手嫌疑人都有排除证据 ──────────────────────────────────
  const hasAnnotations =
    caseData.clues.some((c) => (c.exonerates?.length ?? 0) > 0) ||
    caseData.facts.some((f) => (f.excludes?.length ?? 0) > 0)
  const excluded = (suspectId: string): string[] => {
    const reasons: string[] = []
    for (const c of caseData.clues) {
      if ((c.exonerates ?? []).includes(suspectId)) reasons.push(`线索 ${c.id} 直接排除`)
      for (const f of c.reveals) {
        const fact = factById.get(f)
        if (fact?.excludes?.includes(suspectId)) reasons.push(`事实 ${fact.id} 排除(经线索 ${c.id})`)
      }
    }
    return reasons
  }
  const otherSuspects = caseData.suspects.filter((s) => s.id !== caseData.murderer)
  const unexcluded: string[] = []
  for (const s of otherSuspects) {
    if (excluded(s.id).length === 0) unexcluded.push(s.id)
  }
  if (hasAnnotations) {
    check('唯一性-每名嫌疑人可被排除', unexcluded.length === 0, `无排除证据:${unexcluded.join(',')}`)
  } else if (unexcluded.length > 0) {
    warn('唯一性-未程序化验证', `案件无 exonerates/excludes 注解,以下嫌疑人依赖人工验证:${unexcluded.join(',')}`)
  }

  // ── 5. 红鲱鱼可洗清 ─────────────────────────────────────────────────────────
  for (const c of caseData.clues) {
    for (const target of c.misleadsTo ?? []) {
      const valid = suspectIds.has(target) && target !== caseData.murderer
      const reasons = excluded(target)
      check(
        '红鲱鱼-可被洗清',
        valid && reasons.length > 0,
        `线索 ${c.id} 指向 ${target}:${valid ? `无排除证据` : '目标无效(不是嫌疑人或指向凶手)'}`,
      )
    }
  }

  // ── 6. 可玩性下限 ──────────────────────────────────────────────────────────
  check('可玩性-内容规模', caseData.clues.length >= 10 && caseData.facts.length >= 9 && caseData.suspects.length >= 4, `线索 ${caseData.clues.length} · 事实 ${caseData.facts.length} · 嫌疑人 ${caseData.suspects.length}`)
  check('可玩性-凶手可定罪', incriminating.length >= 1, '凶手没有必须隐瞒的事实,无法定罪')

  return { ok: errors.length === 0, errors, warnings, checks }
}
