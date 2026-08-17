/**
 * 泄密审计(阶段 3 的 verifier 第一道护栏,docs/01-detective.md §5.1/§5.3/§5.5)。
 *
 * 两层:
 *   1. 确定性审计(本文件):对 NPC 的每句 LLM 台词做 shingle 重叠匹配,
 *      检测是否提及"敏感事实"(全体 NPC 的 mustNotAdmit 并集):
 *        - 提及自己必须隐瞒的事实 → "说漏嘴"(slip);
 *        - 提及自己知识范围之外的事实 → "越界泄密"(leak);
 *      命中即由调用方作废该句台词并记录审计日志,保证被泄露内容到不了玩家。
 *   2. LLM 抽查审计(detective.ts):每 4 轮对台词做一次语义级复核。
 *
 * 纯函数、无副作用,可单测。
 */

/** 审计所需的案卷结构视图(侦探案卷/剧本杀剧本/时间循环剧本都满足)。 */
export interface AuditCaseView {
  facts: { id: string; text: string; auditKeywords?: string[] }[]
  npc: Record<string, { knowledge?: string[]; mustNotAdmit?: string[] }>
}

export interface AuditVerdict {
  flagged: boolean
  /** 台词疑似提及的敏感事实 id。 */
  referencedSensitive: string[]
  /** 提及了知识范围之外的事实(泄密)。 */
  outOfScope: string[]
  /** 提及了自己必须隐瞒的事实(说漏嘴)。 */
  slipped: string[]
}

export interface AuditEntry {
  npcId: string
  at: number
  kind: 'leak' | 'slip'
  factIds: string[]
  /** 被作废的台词(存档留证)。 */
  snippet: string
}

/** 归一化:去空白与常见标点。 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s?？!！,，。.、;；::“”"''‘’()[\]（）【】]/g, '')
}

/** 双字滑窗。 */
function shingles(text: string): string[] {
  const norm = normalizeText(text)
  const out: string[] = []
  for (let i = 0; i < norm.length - 1; i++) out.push(norm.slice(i, i + 2))
  return out
}

/** 事实文本与台词的重叠度:命中的事实滑窗 / 事实滑窗总数(0-1)。 */
function overlapScore(factText: string, reply: string): number {
  const fs = shingles(factText)
  if (fs.length === 0) return 0
  const replyNorm = normalizeText(reply)
  if (replyNorm.includes(normalizeText(factText))) return 1
  const rs = new Set(shingles(replyNorm))
  let hit = 0
  for (const s of fs) if (rs.has(s)) hit += 1
  return hit / fs.length
}

/** 最长公共子串长度(归一化后)。 */
function longestCommonSubstring(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let best = 0
  const dp = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    let prev = 0
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0
      prev = tmp
      if (dp[j] > best) best = dp[j]
    }
  }
  return best
}

/**
 * 判定台词是否提及某事实:① 审计关键词命中 ≥2 个(防改写漏网);
 * ② 滑窗重叠达到阈值;③ 存在 ≥5 字的公共子串。
 */
function references(fact: { text: string; auditKeywords?: string[] }, reply: string): boolean {
  if ((fact.auditKeywords ?? []).length > 0) {
    const replyNorm = normalizeText(reply)
    const hits = (fact.auditKeywords ?? []).filter((k) => replyNorm.includes(normalizeText(k)))
    if (hits.length >= 2) return true
  }
  const score = overlapScore(fact.text, reply)
  if (score >= 0.4) return true
  if (score >= 0.2) {
    const lcs = longestCommonSubstring(normalizeText(fact.text), normalizeText(reply))
    if (lcs >= 5) return true
  }
  return false
}

/** 全体 NPC 的 mustNotAdmit 并集 = 敏感事实集。 */
export function sensitiveFacts(caseData: AuditCaseView): Set<string> {
  const out = new Set<string>()
  for (const script of Object.values(caseData.npc)) {
    for (const f of script.mustNotAdmit ?? []) out.add(f)
  }
  return out
}

/**
 * 确定性审计一句 NPC 台词。
 * 脚本化台词(铁证崩溃等)不应送入本函数——那是引擎安排的合法坦白。
 */
export function auditReply(caseData: AuditCaseView, npcId: string, reply: string): AuditVerdict {
  const sensitive = sensitiveFacts(caseData)
  const script = caseData.npc[npcId]
  const knowledge = new Set(script?.knowledge ?? [])
  const mustNotAdmit = new Set(script?.mustNotAdmit ?? [])
  const referencedSensitive: string[] = []
  for (const fact of caseData.facts) {
    if (!sensitive.has(fact.id)) continue
    if (fact.text.trim() === '') continue
    if (references(fact, reply)) referencedSensitive.push(fact.id)
  }
  const outOfScope = referencedSensitive.filter((f) => !knowledge.has(f))
  const slipped = referencedSensitive.filter((f) => mustNotAdmit.has(f))
  return { flagged: outOfScope.length > 0 || slipped.length > 0, referencedSensitive, outOfScope, slipped }
}

/** 被审计拦截时的净化台词(由调用方决定措辞)。 */
export function sanitizedLine(npcName: string): string {
  return `「${npcName}」话说到一半,突然警觉地停住了,只是摇了摇头。`
}
