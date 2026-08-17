/**
 * 玩家动作工具注册。
 * 每个工具先校验当前会话的游戏,再经引擎裁决;需要 LLM 的部分全部走插件侧调用,
 * 真相永不进入主 agent 上下文。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute, GameStateBase, LoadedGame, SchemeId } from './types.js'
import type { GameManager } from './core/manager.js'
import { completeChat, LlmUnavailableError } from './core/llm.js'
import { talkAsNpc } from './core/npc.js'
import { auditReply, sanitizedLine } from './core/audit.js'
import {
  buildNpcSystem,
  factText,
  llmAuditReply,
  scriptedCollapse,
  settleDetective,
  verifyTheory,
  verdictScore,
  type DetectiveCase,
  type DetectiveState,
} from './games/detective.js'
import {
  adjudicateQuestion,
  judgeGuess,
  settleSoup,
  type SoupCard,
  type SoupState,
} from './games/soup.js'
import {
  combine as escapeCombine,
  examine as escapeExamine,
  manipulate as escapeManipulate,
  solve as escapeSolve,
  take as escapeTake,
  useItem as escapeUse,
  type EscapeScenario,
  type EscapeState,
} from './games/escape.js'
import {
  discuss as partyDiscuss,
  partyScoreBars,
  partySettleText,
  reversalDefend,
  reversalVerdict,
  settleParty,
  verifyRoleplay,
  type PartyState,
} from './games/party.js'
import {
  act as loopAct,
  fastForward as loopFastForward,
  investigate as loopInvestigate,
  loopSettleText,
  move as loopMove,
  observe as loopObserve,
  talk as loopTalk,
  verifyPlan as loopVerifyPlan,
  type LoopScript,
  type LoopState,
} from './games/loop.js'
import {
  councilScore,
  decide as councilDecide,
  investigate as councilInvestigate,
  openCouncil,
  question as councilQuestion,
  speak as councilSpeak,
  type CouncilScript,
  type CouncilState,
} from './games/council.js'
import {
  attack as trpgAttack,
  examine as trpgExamine,
  flee as trpgFlee,
  move as trpgMove,
  rest as trpgRest,
  rollCheck as trpgRollCheck,
  talk as trpgTalk,
  useItem as trpgUse,
  type TrpgScript,
  type TrpgState,
} from './games/trpg.js'

function routeOf(agent: { options?: { provider?: string; model?: string; maxTokens?: number } } | undefined): AgentRoute {
  return {
    provider: agent?.options?.provider,
    model: agent?.options?.model,
    maxTokens: agent?.options?.maxTokens,
  }
}

async function requireGame(manager: GameManager, exec: { agent?: { session: { id: string } } | undefined }, scheme: SchemeId): Promise<LoadedGame<GameStateBase, unknown>> {
  const agent = exec.agent
  if (!agent) throw new Error('dsh-xgame:工具需要在会话内调用')
  const game = await manager.load(agent.session.id)
  if (game === null) {
    throw new Error('当前会话没有进行中的游戏。输入 /game new soup 或 /game new detective 开局。')
  }
  if (game.state.scheme !== scheme) {
    throw new Error(`当前进行中的游戏是「${manager.schemeLabel(game.state.scheme)}」,不是本工具所属的游戏。`)
  }
  if (game.state.phase !== 'playing') {
    throw new Error('本局已结束。输入 /game new 开新局,或 /game quit 查看结算。')
  }
  return game
}

/** 按 id 精确、描述子串、双字滑窗重叠度三级匹配线索(仅限已发现);返回全部最佳候选。 */
function findClues(caseData: DetectiveCase, clueKey: string, discovered: string[]): DetectiveCase['clues'][number][] {
  const norm = clueKey.toLowerCase()
  const exact = caseData.clues.find((c) => c.id === norm || norm.includes(c.id.toLowerCase()))
  if (exact && discovered.includes(exact.id)) return [exact]
  const shingles = (key: string) => {
    const out: string[] = []
    for (let i = 0; i < key.length - 1; i++) out.push(key.slice(i, i + 2))
    return out
  }
  const keyShingles = new Set(shingles(norm))
  const scored: { clue: DetectiveCase['clues'][number]; score: number }[] = []
  for (const c of caseData.clues) {
    if (!discovered.includes(c.id)) continue
    const desc = c.description.toLowerCase()
    let score = 0
    for (const sh of keyShingles) if (desc.includes(sh)) score++
    if (norm !== '' && desc.includes(norm)) score += 100
    if (score > 0) scored.push({ clue: c, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const bestScore = scored[0]?.score ?? 0
  return scored.filter((item) => item.score === bestScore).map((item) => item.clue)
}

function renderText(_args: unknown, value: JsonValue): ContentBlock[] {
  const record = value as Record<string, unknown> | null
  const text = record !== null && typeof record.text === 'string' ? record.text : JSON.stringify(value)
  return [{ type: 'text', text }]
}

function textOnly(text: string): Record<string, unknown> {
  return { text }
}

/** 泄密审计:确定性拦截 + 周期 LLM 复核;越界/说漏嘴的台词作废并留证。 */
async function auditedReply(
  ctx: Context,
  exec: { agent?: { options?: { provider?: string; model?: string } } | undefined; signal?: AbortSignal },
  caseData: DetectiveCase,
  state: Pick<DetectiveState, 'conversations' | 'auditLog'>,
  suspect: { id: string; name: string },
  reply: string,
): Promise<{ reply: string; flagged: boolean }> {
  const deterministic = auditReply(caseData, suspect.id, reply)
  const turnCount = (state.conversations[suspect.id] ?? []).length
  let llmLeak = false
  if (!deterministic.flagged && turnCount % 4 === 3) {
    // 每 4 轮抽查一次,语义级复核
    const result = await llmAuditReply(ctx, routeOf(exec.agent), caseData, suspect.id, reply, exec.signal)
    llmLeak = result.leak
  }
  if (deterministic.flagged || llmLeak) {
    const factIds = [...deterministic.outOfScope, ...deterministic.slipped]
    state.auditLog = [
      ...(state.auditLog ?? []),
      {
        npcId: suspect.id,
        at: Date.now(),
        kind: deterministic.slipped.length > 0 ? 'slip' : 'leak',
        factIds,
        snippet: reply,
      },
    ]
    return { reply: sanitizedLine(suspect.name), flagged: true }
  }
  return { reply, flagged: false }
}

const VERDICT_LABEL: Record<string, string> = { yes: '是', no: '否', irrelevant: '无关' }
const VERDICT_INSTRUCTION: Record<string, string> = {
  yes: '用自然语言确认玩家问到的这一点(可以用自己的话轻微展开,但仅限于裁决为"是"的范围)',
  no: '礼貌否定玩家的猜测,可以纠正方向,但不要说出任何汤底细节',
  irrelevant: '告诉玩家这个问题与汤底无关(或你无法据此判断),引导他换个角度',
}

export function registerTools(ctx: Context, manager: GameManager): void {
  // ── 开局(自然语言入口;/game new 是等价的命令入口) ──────────────────────────
  ctx.tools.register({
    ...defineTool({
      name: 'game_start',
      description:
        '游戏:用户想玩游戏时,开始一局新游戏。scheme 取值:soup(海龟汤)、detective(侦探推理)、escape(密室逃脱)、party(剧本杀)、loop(时间循环)、council(王国议会)、trpg(单人跑团)。已有进行中的游戏会被拒绝。工具返回开局简报,你按简报以主持人身份开场。',
      parameters: {
        scheme: { type: 'string', required: true, description: '游戏类型:soup / detective / escape / party / loop / council / trpg' },
        difficulty: { type: 'number', description: '难度 1-3,默认 1' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scheme: { type: 'string', required: true },
            difficulty: { type: 'number', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const agent = exec.agent
        if (!agent) throw new Error('dsh-xgame:工具需要在会话内调用')
        const scheme = String((args as { scheme: unknown }).scheme ?? '')
        if (scheme !== 'soup' && scheme !== 'detective' && scheme !== 'escape' && scheme !== 'party' && scheme !== 'loop' && scheme !== 'council' && scheme !== 'trpg') {
          throw new Error('scheme 须为 soup、detective、escape、party、loop、council 或 trpg')
        }
        const rawDifficulty = (args as { difficulty?: unknown }).difficulty
        const difficulty = rawDifficulty === undefined ? 1 : Number(rawDifficulty)
        if (!Number.isFinite(difficulty) || difficulty < 1 || difficulty > 3) {
          throw new Error('难度须为 1-3 的整数')
        }
        const brief = await manager.newGame(agent.session.id, scheme, Math.round(difficulty))
        return { scheme, difficulty: Math.round(difficulty), text: brief }
      },
    }),
    timeoutMs: 30_000,
  })

  // ── 海龟汤 ────────────────────────────────────────────────────────────────
  ctx.tools.register({
    ...defineTool({
      name: 'soup_ask',
      description:
        '海龟汤:玩家提出一个问题后,把问题原文传入此工具,引擎返回裁决(是/否/无关)与措辞提示。你必须严格按裁决回答,严禁自行判断或透露汤底。',
      parameters: {
        question: { type: 'string', required: true, description: '玩家问题的原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true },
            note: { type: 'string', required: true },
            red_herring: { type: 'boolean', required: true },
            questions_used: { type: 'number', required: true },
            questions_left: { type: 'number', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'soup')
        const state = game.state as SoupState
        const card = game.truth as SoupCard
        const question = String((args as { question: unknown }).question ?? '').trim()
        if (question === '') throw new Error('问题不能为空')
        const { verdict } = await adjudicateQuestion(ctx, routeOf(exec.agent), card, state, question, exec.signal)
        state.turns += 1
        state.questions.push({ q: question, verdict: verdict.verdict, at: Date.now() })
        if (verdict.redHerring) state.redHerrings += 1
        await manager.update(game.sessionId, state)
        const left = Math.max(0, state.maxQuestions - state.questions.length)
        let text = `【引擎裁决】${VERDICT_LABEL[verdict.verdict]}${verdict.note !== '' ? ` — ${verdict.note}` : ''}${verdict.redHerring ? '(玩家在错误方向兜圈子,已记红鱼)' : ''}\n\n`
        text += `主持人守则:你只知道上面的裁决,不知道汤底。请用一两句话以主持人身份回答玩家——${VERDICT_INSTRUCTION[verdict.verdict]}。不要透露任何汤底内容。`
        if (left <= 0) text += '\n\n问题预算已用尽:请提醒玩家直接说出完整答案(调用 soup_guess 提交),或 /game quit 看真相。'
        return {
          verdict: verdict.verdict,
          note: verdict.note,
          red_herring: verdict.redHerring,
          questions_used: state.questions.length,
          questions_left: left,
          text,
        }
      },
    }),
    timeoutMs: 90_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'soup_guess',
      description:
        '海龟汤:玩家给出完整汤底还原时,把他的答案原文传入此工具,引擎会判定是否还原真相并返回结算。未还原时你按提示继续主持。',
      parameters: {
        answer: { type: 'string', required: true, description: '玩家给出的完整答案原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            solved: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'soup')
        const state = game.state as SoupState
        const card = game.truth as SoupCard
        const answer = String((args as { answer: unknown }).answer ?? '').trim()
        if (answer === '') throw new Error('答案不能为空')
        const { solved } = await judgeGuess(ctx, routeOf(exec.agent), card, answer, exec.signal)
        state.turns += 1
        if (solved) {
          const { score, text } = settleSoup(state, true)
          state.phase = 'solved'
          state.score = score
          await manager.update(game.sessionId, state)
          return { solved: true, text }
        }
        await manager.update(game.sessionId, state)
        return {
          solved: false,
          text: '【引擎判定】未还原汤底。主持人守则:鼓励玩家再想想,可以给一个大致方向(比如"想想味道的来源"),但绝不要透露汤底。',
        }
      },
    }),
    timeoutMs: 90_000,
  })

  // ── 侦探推理 ──────────────────────────────────────────────────────────────
  ctx.tools.register({
    ...defineTool({
      name: 'detective_examine',
      description:
        '侦探推理:玩家要求勘查某个地点(或复查某条已发现的线索)时调用。引擎返回该地点新发现的线索描述;引擎没给的信息你绝不能编造。',
      parameters: {
        target: { type: 'string', required: true, description: '地点名(如 书房/温室/湖边)或线索描述关键词' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'array', items: { type: 'string' }, required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'detective')
        const state = game.state as DetectiveState
        const caseData = game.truth as DetectiveCase
        const target = String((args as { target: unknown }).target ?? '').trim()
        if (target === '') throw new Error('勘查目标不能为空')
        const norm = target.toLowerCase()
        const location = caseData.locations.find((loc) => loc.toLowerCase() === norm || norm.includes(loc.toLowerCase()))
        if (location) {
          const fresh = caseData.clues.filter((c) => c.location === location && !state.discoveredClues.includes(c.id))
          state.discoveredClues.push(...fresh.map((c) => c.id))
          state.turns += 1
          await manager.update(game.sessionId, state)
          if (fresh.length === 0) {
            return {
              found: [],
              text: `【勘查 ${location}】没有新的发现。你已把这里翻遍了。\n主持人守则:如实告诉玩家"这里没有新线索",可建议换个地点。可勘查地点:${caseData.locations.filter((l) => l !== location).join('、')}。`,
            }
          }
          const lines = fresh.map((c) => `- ${c.description}`).join('\n')
          return {
            found: fresh.map((c) => c.id),
            text: `【勘查 ${location}】发现 ${fresh.length} 条线索:\n${lines}\n\n主持人守则:把这些线索以侦探助手的口吻呈现给玩家(可以润色语句,但不得增删事实、不得推断含义),并说明已收入卷宗(/casefile 可查)。`,
          }
        }
        const clue = caseData.clues.find((c) => c.id === target || norm.includes(c.id.toLowerCase()))
        if (clue && state.discoveredClues.includes(clue.id)) {
          return {
            found: [clue.id],
            text: `【复查线索】${clue.description}\n主持人守则:复述这条线索给玩家即可。`,
          }
        }
        return {
          found: [],
          text: `没有找到「${target}」。可勘查地点:${caseData.locations.join('、')}。\n主持人守则:如实转告玩家,并列出可勘查地点。`,
        }
      },
    }),
    timeoutMs: 30_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'detective_talk',
      description:
        '侦探推理:玩家要与某位 NPC 交谈/审讯时,把玩家的话原文传入。引擎让该 NPC 以其知识边界与说谎策略回应,返回台词;你转述时保持原意,可加神态描写。',
      parameters: {
        npc: { type: 'string', required: true, description: 'NPC 名字(见开局简报中的相关人士列表)' },
        text: { type: 'string', required: true, description: '玩家对 NPC 说的话原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            npc: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'detective')
        const state = game.state as DetectiveState
        const caseData = game.truth as DetectiveCase
        const npcId = String((args as { npc: unknown }).npc ?? '').trim()
        const text = String((args as { text: unknown }).text ?? '').trim()
        if (text === '') throw new Error('对 NPC 说的话不能为空')
        const suspect = caseData.suspects.find((s) => s.id === npcId || s.name === npcId)
        if (!suspect) {
          throw new Error(`没有这位人士。可选:${caseData.suspects.map((s) => s.name).join('、')}`)
        }
        let reply: string
        try {
          const history = (state.conversations[suspect.id] ?? []).slice(-8)
          reply = (
            await talkAsNpc(ctx, {
              sessionId: exec.agent?.session.id ?? '',
              route: routeOf(exec.agent),
              label: `npc:detective:${suspect.id}`,
              system: buildNpcSystem(caseData, suspect.id),
              user: `玩家说:${text}`,
              history,
              maxTokens: 400,
              signal: exec.signal,
            })
          ).text
        } catch (error) {
          if (error instanceof LlmUnavailableError) throw error
          reply = `${suspect.name}没有回答,只是移开了目光。`
        }
        const audited = await auditedReply(ctx, exec, caseData, state, suspect, reply)
        reply = audited.reply
        state.conversations[suspect.id] = [
          ...(state.conversations[suspect.id] ?? []),
          { role: 'user' as const, text },
          { role: 'assistant' as const, text: reply },
        ].slice(-12)
        state.turns += 1
        await manager.update(game.sessionId, state)
        const auditNote = audited.flagged ? '\n\n⚠ 泄密审计:引擎已作废该 NPC 的原回应(越界或说漏嘴),请只转述上面的净化台词。' : ''
        return {
          npc: suspect.name,
          text: `「${suspect.name}」的回应(转述时保持原意,可加一点神态描写):\n${reply}${auditNote}`,
        }
      },
    }),
    timeoutMs: 120_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'detective_show',
      description:
        '侦探推理:玩家向某位 NPC 出示一条已发现的线索/证据时调用。引擎会让该 NPC 按其人设与说谎边界作出反应(承认、改口或抵赖),返回台词。',
      parameters: {
        npc: { type: 'string', required: true, description: 'NPC 名字' },
        clue_id: { type: 'string', required: true, description: '线索的简短描述关键词(须为已发现的线索)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            npc: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'detective')
        const state = game.state as DetectiveState
        const caseData = game.truth as DetectiveCase
        const npcId = String((args as { npc: unknown }).npc ?? '').trim()
        const clueKey = String((args as { clue_id: unknown }).clue_id ?? '').trim().toLowerCase()
        const suspect = caseData.suspects.find((s) => s.id === npcId || s.name === npcId)
        if (!suspect) throw new Error(`没有这位人士。可选:${caseData.suspects.map((s) => s.name).join('、')}`)
        const candidates = findClues(caseData, clueKey, state.discoveredClues)
        if (candidates.length === 0) {
          throw new Error(`没有识别出这条证据。请用已发现线索的关键词描述。已发现:${state.discoveredClues.map((id) => caseData.clues.find((c) => c.id === id)?.description.slice(0, 24)).join(';')}`)
        }
        if (candidates.length > 1) {
          const list = candidates.map((c, i) => `${i + 1}) [${c.location}] ${c.description}`).join('\n')
          throw new Error(`「${clueKey}」有歧义,匹配到多条证据,请向玩家确认是哪一条:\n${list}`)
        }
        const clue = candidates[0]
        if (!state.discoveredClues.includes(clue.id)) throw new Error('这条证据还没有被发现,不能出示。')
        const shown = state.evidenceShown[suspect.id] ?? []
        if (!shown.includes(clue.id)) shown.push(clue.id)
        state.evidenceShown[suspect.id] = shown
        state.turns += 1
        const scripted = scriptedCollapse(caseData, state.evidenceShown, suspect.id)
        let reaction: string
        if (scripted !== null) {
          reaction = scripted
        } else {
          const revealed = clue.reveals.map((id) => factText(caseData, id))
          try {
            reaction = (
              await talkAsNpc(ctx, {
                sessionId: exec.agent?.session.id ?? '',
                route: routeOf(exec.agent),
                label: `npc:detective:${suspect.id}`,
                system: `${buildNpcSystem(caseData, suspect.id)}\n\n【当前情境】玩家向你出示了证据:「${clue.description}」。${revealed.length > 0 ? `该证据表明:${revealed.join(';')}` : '该证据的具体含义由你按人设理解。'}请按你的说谎边界与性格做出反应,只输出你的台词。`,
                user: '玩家把证据摆在你面前,盯着你。',
                history: (state.conversations[suspect.id] ?? []).slice(-8),
                maxTokens: 400,
                signal: exec.signal,
              })
            ).text
          } catch (error) {
            if (error instanceof LlmUnavailableError) throw error
            reaction = `${suspect.name}盯着证据,嘴唇动了动,什么都没说。`
          }
          const audited = await auditedReply(ctx, exec, caseData, state, suspect, reaction)
          reaction = audited.reply
        }
        state.conversations[suspect.id] = [
          ...(state.conversations[suspect.id] ?? []),
          { role: 'user' as const, text: `[出示证据:${clue.description}]` },
          { role: 'assistant' as const, text: reaction },
        ].slice(-12)
        await manager.update(game.sessionId, state)
        return {
          npc: suspect.name,
          text: `「${suspect.name}」对证据的反应(转述时保持原意,可加神态描写):\n${reaction}`,
        }
      },
    }),
    timeoutMs: 120_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'detective_accuse',
      description:
        '侦探推理:玩家正式指控某人为凶手时调用——这是终局动作,引擎会立即判定对错、揭示全部真相并结算,不可撤销。',
      parameters: {
        npc: { type: 'string', required: true, description: '被指控的 NPC 名字' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            correct: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'detective')
        const state = game.state as DetectiveState
        const caseData = game.truth as DetectiveCase
        const npcId = String((args as { npc: unknown }).npc ?? '').trim()
        const suspect = caseData.suspects.find((s) => s.id === npcId || s.name === npcId)
        if (!suspect) throw new Error(`没有这位人士。可选:${caseData.suspects.map((s) => s.name).join('、')}`)
        const correct = suspect.id === caseData.murderer
        state.accusedId = suspect.id
        state.turns += 1
        state.phase = correct ? 'solved' : 'given_up'
        state.score = [
          {
            label: '结论正确性',
            value: correct ? 100 : 0,
            note: correct ? `指控「${suspect.name}」正确` : `指控「${suspect.name}」错误`,
          },
          { label: '推理质量', value: correct ? 50 : 0, note: '未经推理报告评审,只按指控结论计' },
          { label: '效率', value: Math.max(0, 100 - state.turns * 2 - state.hintsUsed * 15), note: `${state.turns} 次行动 · ${state.hintsUsed} 次提示` },
        ]
        const text = settleDetective(state, caseData)
        await manager.update(game.sessionId, state)
        return { correct, text }
      },
    }),
    timeoutMs: 30_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'detective_submit_theory',
      description:
        '侦探推理:玩家提交完整推理报告(凶手、手法、动机、证据链)时调用——这是终局动作,独立评审会对照真相逐条评分并揭示全部真相。',
      parameters: {
        report: { type: 'string', required: true, description: '玩家的完整推理报告原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            murderer_correct: { type: 'boolean', required: true },
            means_correct: { type: 'boolean', required: true },
            motive_correct: { type: 'boolean', required: true },
            reasoning_score: { type: 'number', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'detective')
        const state = game.state as DetectiveState
        const caseData = game.truth as DetectiveCase
        const report = String((args as { report: unknown }).report ?? '').trim()
        if (report === '') throw new Error('推理报告不能为空')
        const verdict = await verifyTheory(ctx, routeOf(exec.agent), caseData, report, exec.signal)
        state.theoryText = report
        state.verdict = verdict
        state.turns += 1
        state.phase = verdict.murdererCorrect ? 'solved' : 'given_up'
        state.score = verdictScore(state)
        const text = settleDetective(state, caseData)
        await manager.update(game.sessionId, state)
        return {
          murderer_correct: verdict.murdererCorrect,
          means_correct: verdict.meansCorrect,
          motive_correct: verdict.motiveCorrect,
          reasoning_score: verdict.reasoningScore,
          text,
        }
      },
    }),
    timeoutMs: 180_000,
  })

  // ── 密室逃脱(确定性谜题引擎,裁决不依赖 LLM) ─────────────────────────────────
  const escapeTool = (
    toolName: string,
    description: string,
    parameters: Record<string, { type: 'string'; required?: true; description: string }>,
    run: (scenario: EscapeScenario, state: EscapeState, args: Record<string, unknown>) => { result: string; text: string },
  ): void => {
    ctx.tools.register({
      ...defineTool({
        name: toolName,
        description,
        parameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              result: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: renderText,
        },
        execute: async (args: unknown, exec) => {
          const game = await requireGame(manager, exec, 'escape')
          const state = game.state as EscapeState
          const scenario = game.truth as EscapeScenario
          const record = (args ?? {}) as Record<string, unknown>
          const outcome = run(scenario, state, record)
          if (outcome.result !== 'error') await manager.update(game.sessionId, state)
          return { result: outcome.result, text: outcome.text }
        },
      }),
      timeoutMs: 30_000,
    })
  }

  escapeTool(
    'escape_examine',
    '密室逃脱:玩家观察某物品/机关/门时调用。引擎返回该对象的当前描述;引擎没给的信息你绝不能编造。',
    { target: { type: 'string', required: true, description: '物品/机关/门的名称(如 壁炉/镜子/书桌/西洋钟/通往书房的门)' } },
    (scenario, state, args) => escapeExamine(scenario, state, String(args.target ?? '')),
  )

  escapeTool(
    'escape_take',
    '密室逃脱:玩家拾取当前房间里的物品时调用。引擎裁决物品是否可见可拿,成功后进入背包。',
    { item: { type: 'string', required: true, description: '物品名称(如 一盒火柴/冻住的铜钥匙)' } },
    (scenario, state, args) => escapeTake(scenario, state, String(args.item ?? '')),
  )

  escapeTool(
    'escape_use',
    '密室逃脱:玩家把背包物品用在某个机关或门上时调用(如 用铜钥匙开门)。引擎裁决是否匹配。',
    {
      item: { type: 'string', required: true, description: '背包物品名称' },
      on: { type: 'string', required: true, description: '作用目标:机关或门的名称' },
    },
    (scenario, state, args) => escapeUse(scenario, state, String(args.item ?? ''), String(args.on ?? '')),
  )

  escapeTool(
    'escape_combine',
    '密室逃脱:玩家把两件背包物品组合时调用(如 火柴+冻住的铜钥匙)。引擎裁决是否有配方。',
    {
      a: { type: 'string', required: true, description: '第一件物品名称' },
      b: { type: 'string', required: true, description: '第二件物品名称' },
    },
    (scenario, state, args) => escapeCombine(scenario, state, String(args.a ?? ''), String(args.b ?? '')),
  )

  escapeTool(
    'escape_manipulate',
    '密室逃脱:玩家操作某个机关时调用(如 点火/转动/推倒)。引擎跑状态机裁决结果。',
    {
      target: { type: 'string', required: true, description: '机关名称(如 壁炉/镜子/斜窗/第七扇门)' },
      action: { type: 'string', required: true, description: '动作原文(如 点火/转动/撬开/推开)' },
    },
    (scenario, state, args) => escapeManipulate(scenario, state, String(args.target ?? ''), String(args.action ?? '')),
  )

  escapeTool(
    'escape_solve',
    '密室逃脱:玩家提交某个谜题的答案时调用。引擎对照谜底裁决,对错由引擎决定,你绝不能替引擎放水。',
    {
      puzzle: { type: 'string', required: true, description: '谜题名称(如 西洋钟/第七扇门密码锁)' },
      answer: { type: 'string', required: true, description: '玩家提交的答案原文' },
    },
    (scenario, state, args) => escapeSolve(scenario, state, String(args.puzzle ?? ''), String(args.answer ?? '')),
  )

  // ── 剧本杀(真相复用侦探案卷结构,泄密审计同源) ───────────────────────────────
  ctx.tools.register({
    ...defineTool({
      name: 'party_search',
      description:
        '剧本杀:玩家要求搜证某个场景时调用。引擎返回该场景新发现的证据;引擎没给的信息你绝不能编造。',
      parameters: {
        scene: { type: 'string', required: true, description: '场景名(如 书房/餐厅/卧室/走廊/花园)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'array', items: { type: 'string' }, required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        const scene = String((args as { scene: unknown }).scene ?? '').trim()
        if (scene === '') throw new Error('场景不能为空')
        const norm = scene.toLowerCase()
        const location = caseData.locations.find((loc) => loc.toLowerCase() === norm || norm.includes(loc.toLowerCase()))
        if (!location) {
          return {
            found: [],
            text: `没有「${scene}」这个场景。可搜证场景:${caseData.locations.join('、')}。\n主持人守则:如实转告玩家,并列出可搜证场景。`,
          }
        }
        const fresh = caseData.clues.filter((c) => c.location === location && !state.discoveredClues.includes(c.id))
        state.discoveredClues.push(...fresh.map((c) => c.id))
        state.turns += 1
        await manager.update(game.sessionId, state)
        if (fresh.length === 0) {
          return {
            found: [],
            text: `【搜证 ${location}】没有新的发现。这里已经搜过了。\n主持人守则:如实告诉玩家"这里没有新证据",可建议换个场景。`,
          }
        }
        const lines = fresh.map((c) => `- ${c.description}`).join('\n')
        return {
          found: fresh.map((c) => c.id),
          text: `【搜证 ${location}】发现 ${fresh.length} 条证据:\n${lines}\n\n主持人守则:把这些证据以搜证报告的口吻呈现给玩家(可润色语句,但不得增删事实、不得推断含义),并说明已入证据袋(/game score 可查)。`,
        }
      },
    }),
    timeoutMs: 30_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'party_talk',
      description:
        '剧本杀:玩家与某位角色单独对质/深谈时,把玩家的话原文传入。引擎让该角色以其知识边界与说谎策略回应,返回台词;你转述时保持原意,可加神态描写。',
      parameters: {
        npc: { type: 'string', required: true, description: '角色名字(见 /roles 名册)' },
        text: { type: 'string', required: true, description: '玩家对该角色说的话原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            npc: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        const npcId = String((args as { npc: unknown }).npc ?? '').trim()
        const text = String((args as { text: unknown }).text ?? '').trim()
        if (text === '') throw new Error('对角色说的话不能为空')
        const suspect = caseData.suspects.find((s) => s.id === npcId || s.name === npcId)
        if (!suspect) {
          throw new Error(`没有这位人士。可选:${caseData.suspects.map((s) => s.name).join('、')}`)
        }
        if (state.mode === 'reversal' && suspect.id === caseData.murderer) {
          throw new Error('那正是你自己——侦探团的其他成员才是你的审讯者。')
        }
        let reply: string
        try {
          const history = (state.conversations[suspect.id] ?? []).slice(-8)
          reply = (
            await talkAsNpc(ctx, {
              sessionId: exec.agent?.session.id ?? '',
              route: routeOf(exec.agent),
              label: `npc:party:${suspect.id}`,
              system: buildNpcSystem(caseData, suspect.id),
              user: `玩家说:${text}`,
              history,
              maxTokens: 400,
              signal: exec.signal,
            })
          ).text
        } catch (error) {
          if (error instanceof LlmUnavailableError) throw error
          reply = `${suspect.name}没有回答,只是移开了目光。`
        }
        const audited = await auditedReply(ctx, exec, caseData, state, suspect, reply)
        reply = audited.reply
        state.conversations[suspect.id] = [
          ...(state.conversations[suspect.id] ?? []),
          { role: 'user' as const, text },
          { role: 'assistant' as const, text: reply },
        ].slice(-12)
        state.discussion = [...state.discussion, { role: 'user', speaker: '你', text, at: Date.now() }, { role: 'npc', speaker: suspect.name, text: reply, at: Date.now() }]
        state.turns += 1
        await manager.update(game.sessionId, state)
        const auditNote = audited.flagged ? '\n\n⚠ 泄密审计:引擎已作废该角色的原回应(越界或说漏嘴),请只转述上面的净化台词。' : ''
        return {
          npc: suspect.name,
          text: `「${suspect.name}」的回应(转述时保持原意,可加一点神态描写):\n${reply}${auditNote}`,
        }
      },
    }),
    timeoutMs: 120_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'party_discuss',
      description:
        '剧本杀:玩家公开发言(陈述/质问/抛出线索)时调用。引擎并发收集全体角色的反应(每人一句),你按返回顺序呈现,不得替任何角色加戏或改词。',
      parameters: {
        statement: { type: 'string', required: true, description: '玩家的公开发言原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lines: { type: 'array', items: { type: 'string' }, required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        const statement = String((args as { statement: unknown }).statement ?? '').trim()
        if (statement === '') throw new Error('发言不能为空')
        const { lines } = await partyDiscuss(ctx, exec.agent?.session.id ?? '', routeOf(exec.agent), caseData, state, statement, exec.signal)
        state.discussion = [...state.discussion, { role: 'user', speaker: '你', text: statement, at: Date.now() }]
        for (const line of lines) {
          state.discussion = [...state.discussion, { role: 'npc', speaker: line.name, text: line.text, at: Date.now() }]
          state.conversations[line.npcId] = [
            ...(state.conversations[line.npcId] ?? []),
            { role: 'user' as const, text: `[公聊] ${statement}` },
            { role: 'assistant' as const, text: line.text },
          ].slice(-12)
        }
        state.turns += 1
        await manager.update(game.sessionId, state)
        const rendered = lines.map((l) => `- ${l.name}:${l.text}${l.flagged ? '(已净化)' : ''}`).join('\n')
        return {
          lines: lines.map((l) => `${l.name}:${l.text}`),
          text: `【公聊 · 全体反应】\n${rendered}\n\n主持人守则:按顺序转述各角色反应(可加神态描写,不得改词);引擎已对越界台词做净化处理。`,
        }
      },
    }),
    timeoutMs: 180_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'party_show',
      description:
        '剧本杀:玩家向某位角色(或当众)出示一条已搜到的证据时调用。引擎会让该角色按其人设与说谎边界作出反应;铁证齐备时凶手按剧本崩溃认罪。',
      parameters: {
        npc: { type: 'string', required: true, description: '角色名字' },
        clue_id: { type: 'string', required: true, description: '证据的简短描述关键词(须为已搜到的证据)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            npc: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        const npcId = String((args as { npc: unknown }).npc ?? '').trim()
        const clueKey = String((args as { clue_id: unknown }).clue_id ?? '').trim().toLowerCase()
        const suspect = caseData.suspects.find((s) => s.id === npcId || s.name === npcId)
        if (!suspect) throw new Error(`没有这位人士。可选:${caseData.suspects.map((s) => s.name).join('、')}`)
        if (state.mode === 'reversal' && suspect.id === caseData.murderer) {
          throw new Error('你不能向自己出示证据——侦探团在质问你。')
        }
        const candidates = findClues(caseData, clueKey, state.discoveredClues)
        if (candidates.length === 0) {
          throw new Error(`没有识别出这条证据。请用已搜到证据的关键词描述。已搜到:${state.discoveredClues.map((id) => caseData.clues.find((c) => c.id === id)?.description.slice(0, 24)).join(';')}`)
        }
        if (candidates.length > 1) {
          const list = candidates.map((c, i) => `${i + 1}) [${c.location}] ${c.description}`).join('\n')
          throw new Error(`「${clueKey}」有歧义,匹配到多条证据,请向玩家确认是哪一条:\n${list}`)
        }
        const clue = candidates[0]
        if (!state.discoveredClues.includes(clue.id)) throw new Error('这条证据还没有被发现,不能出示。')
        const shown = state.evidenceShown[suspect.id] ?? []
        if (!shown.includes(clue.id)) shown.push(clue.id)
        state.evidenceShown[suspect.id] = shown
        state.turns += 1
        const scripted = scriptedCollapse(caseData, state.evidenceShown, suspect.id)
        let reaction: string
        if (scripted !== null) {
          reaction = scripted
        } else {
          const revealed = clue.reveals.map((id) => factText(caseData, id))
          try {
            reaction = (
              await talkAsNpc(ctx, {
                sessionId: exec.agent?.session.id ?? '',
                route: routeOf(exec.agent),
                label: `npc:party:${suspect.id}`,
                system: `${buildNpcSystem(caseData, suspect.id)}\n\n【当前情境】玩家向你出示了证据:「${clue.description}」。${revealed.length > 0 ? `该证据表明:${revealed.join(';')}` : '该证据的具体含义由你按人设理解。'}请按你的说谎边界与性格做出反应,只输出你的台词。`,
                user: '玩家把证据摆在你面前,盯着你。',
                history: (state.conversations[suspect.id] ?? []).slice(-8),
                maxTokens: 400,
                signal: exec.signal,
              })
            ).text
          } catch (error) {
            if (error instanceof LlmUnavailableError) throw error
            reaction = `${suspect.name}盯着证据,嘴唇动了动,什么都没说。`
          }
          const audited = await auditedReply(ctx, exec, caseData, state, suspect, reaction)
          reaction = audited.reply
        }
        state.conversations[suspect.id] = [
          ...(state.conversations[suspect.id] ?? []),
          { role: 'user' as const, text: `[出示证据:${clue.description}]` },
          { role: 'assistant' as const, text: reaction },
        ].slice(-12)
        await manager.update(game.sessionId, state)
        return {
          npc: suspect.name,
          text: `「${suspect.name}」对证据的反应(转述时保持原意,可加神态描写):\n${reaction}`,
        }
      },
    }),
    timeoutMs: 120_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'party_accuse',
      description:
        '剧本杀:玩家正式指控某人为凶手时调用——这是终局动作,引擎会立即判定对错、按双栏结算(推理正确性 + 扮演质量)并揭示全部真相,不可撤销。',
      parameters: {
        npc: { type: 'string', required: true, description: '被指控的角色名字' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            correct: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        if (state.mode === 'reversal') throw new Error('反转模式没有指控环节——质询结束后用 party_verdict 终局裁决。')
        const npcId = String((args as { npc: unknown }).npc ?? '').trim()
        const suspect = caseData.suspects.find((s) => s.id === npcId || s.name === npcId)
        if (!suspect) throw new Error(`没有这位人士。可选:${caseData.suspects.map((s) => s.name).join('、')}`)
        const correct = suspect.id === caseData.murderer
        state.accusedId = suspect.id
        state.turns += 1
        const roleplay = await verifyRoleplay(ctx, routeOf(exec.agent), state.discussion, exec.signal)
        settleParty(caseData, state, roleplay)
        state.phase = correct ? 'solved' : 'given_up'
        state.score = partyScoreBars(caseData, state)
        const text = partySettleText(caseData, state)
        await manager.update(game.sessionId, state)
        return { correct, text }
      },
    }),
    timeoutMs: 180_000,
  })

  // 反转模式:玩家(凶手)的陈述与终局裁决
  ctx.tools.register({
    ...defineTool({
      name: 'party_defend',
      description:
        '剧本杀·反转模式:玩家(凶手)提交陈述/辩解时调用。引擎对照证据与秘密裁决嫌疑度升降(坚守公开说辞可洗清嫌疑;自曝或与已搜证据矛盾则嫌疑大增),并揭示侦探团本轮新搜到的证据。嫌疑度只有引擎能改。',
      parameters: {
        statement: { type: 'string', required: true, description: '玩家的陈述/辩解原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        if (state.mode !== 'reversal') throw new Error('本局不是反转模式。')
        const statement = String((args as { statement: unknown }).statement ?? '').trim()
        if (statement === '') throw new Error('陈述不能为空')
        const result = reversalDefend(caseData, state, statement)
        await manager.update(game.sessionId, state)
        return { text: result.text }
      },
    }),
    timeoutMs: 30_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'party_verdict',
      description:
        '剧本杀·反转模式:质询轮次结束后调用,终局裁决。引擎按嫌疑度判定玩家是否被识破(≥ 60 被识破),结算逃脱结局 + 扮演质量,并揭晓全部真相。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            caught: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (_args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'party')
        const state = game.state as PartyState
        const caseData = game.truth as DetectiveCase
        if (state.mode !== 'reversal') throw new Error('本局不是反转模式。')
        const roleplay = await verifyRoleplay(ctx, routeOf(exec.agent), state.discussion, exec.signal)
        const result = reversalVerdict(caseData, state, roleplay)
        if (state.verdictDone) await manager.update(game.sessionId, state)
        return { caught: result.caught, text: result.text }
      },
    }),
    timeoutMs: 180_000,
  })

  // ── 时间循环(因果时间表引擎;真相与因果链永不进 GM 上下文) ──────────────────
  const loopTool = (
    toolName: string,
    description: string,
    parameters: Record<string, { type: 'string'; required?: true; description: string }>,
    run: (
      script: LoopScript,
      state: LoopState,
      args: Record<string, unknown>,
      exec: { agent?: { session: { id: string }; options?: { provider?: string; model?: string } } | undefined; signal?: AbortSignal },
    ) => Promise<{ result: string; text: string }> | { result: string; text: string },
  ): void => {
    ctx.tools.register({
      ...defineTool({
        name: toolName,
        description,
        parameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              result: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: renderText,
        },
        execute: async (args: unknown, exec) => {
          const game = await requireGame(manager, exec, 'loop')
          const state = game.state as LoopState
          const script = game.truth as LoopScript
          const record = (args ?? {}) as Record<string, unknown>
          const outcome = await run(script, state, record, exec)
          if (outcome.result !== 'error') await manager.update(game.sessionId, state)
          return { result: outcome.result, text: outcome.text }
        },
      }),
      timeoutMs: 90_000,
    })
  }

  loopTool(
    'loop_move',
    '时间循环:玩家要前往某个地点时调用。移动消耗 1 个时间片;到达 19:00 时引擎自动结算悲剧或完美一日,并可能触发世界回滚(只有玩家的元知识保留)。',
    { to: { type: 'string', required: true, description: '地点:镇公所大厅 / 集市广场 / 旧图书馆 / 旧钟楼' } },
    (script, state, args) => {
      const r = loopMove(script, state, String(args.to ?? ''))
      return { result: r.won === true ? 'solved' : 'success', text: r.text }
    },
  )

  loopTool(
    'loop_observe',
    '时间循环:玩家观察当前时间片与地点时调用。引擎返回可见投影(谁在场做什么、目击事件),目击会自动收录为元知识。',
    {},
    (script, state) => {
      const r = loopObserve(script, state)
      return { result: 'success', text: r.text }
    },
  )

  loopTool(
    'loop_investigate',
    '时间循环:玩家深查当前地点的机关/物件时调用(如 档案箱/挎包/炭盆/小门)。引擎按"先知道,才拿得到"裁决,可能获得道具与元知识。',
    { target: { type: 'string', required: true, description: '要深查的对象名称' } },
    (script, state, args) => {
      const r = loopInvestigate(script, state, String(args.target ?? ''))
      return { result: 'success', text: r.text }
    },
  )

  loopTool(
    'loop_talk',
    '时间循环:玩家与在场的某位 NPC 对话时,把玩家的话原文传入。引擎让该 NPC 按角色页回应(他们不记得别的循环,也不知道自己的命运);台词过泄密审计。',
    {
      npc: { type: 'string', required: true, description: 'NPC 名字(沈培元 / 老周 / 林薇)' },
      text: { type: 'string', required: true, description: '玩家对 NPC 说的话原文' },
    },
    async (script, state, args, exec) => {
      const r = await loopTalk(ctx, exec.agent?.session.id ?? '', routeOf(exec.agent), script, state, String(args.npc ?? ''), String(args.text ?? ''), exec.signal)
      return { result: 'success', text: r.text }
    },
  )

  loopTool(
    'loop_act',
    '时间循环:玩家执行因果行动时调用(如 拆铆钉/把残页交给记者/出示合影)。引擎对照时间、地点、知识门槛与道具裁决,可能切断悲剧的因果边。',
    { action: { type: 'string', required: true, description: '行动原文(如 用铜钥匙拆下断裂铆钉)' } },
    (script, state, args) => {
      const r = loopAct(script, state, String(args.action ?? ''))
      return { result: 'success', text: r.text }
    },
  )

  loopTool(
    'loop_fast_forward',
    '时间循环:玩家标记已知动作、批量重放时调用。计划文本用时间标记 + 地点 + 动作(如"12:00 图书馆翻档案箱 → 15:00 集市摸挎包")。引擎按"先知道,才拿得到"照常裁决,跳过不满足条件的步骤并标注,输出浓缩摘要;到达 19:00 正常结算。',
    { plan: { type: 'string', required: true, description: '快进计划原文(时间 + 地点 + 动作)' } },
    (script, state, args) => {
      const r = loopFastForward(script, state, String(args.plan ?? ''))
      return { result: r.won === true ? 'solved' : 'success', text: r.text }
    },
  )

  loopTool(
    'loop_submit_plan',
    '时间循环:玩家提交完整"完美一日"行动方案时调用——这是终局动作。引擎逐条对照因果链验证(行动提及 + 知识门槛),给出逐条通过/失败回执;全部通过则完美一日达成。',
    { plan: { type: 'string', required: true, description: '玩家的完整行动方案原文' } },
    (script, state, args) => {
      const verdict = loopVerifyPlan(script, state, String(args.plan ?? ''))
      state.planVerdict = JSON.stringify(verdict.items)
      if (verdict.pass) {
        state.phase = 'solved'
        const settle = loopSettleText(script, state)
        return { result: 'solved', text: `【因果链逐条核验】\n${verdict.items.map((i) => `- ${i.ok ? '✓' : '✗'} ${i.reason}`).join('\n')}\n\n${settle}` }
      }
      return {
        result: 'success',
        text: `【因果链逐条核验:未通过】\n${verdict.items.map((i) => `- ${i.ok ? '✓' : '✗'} ${i.reason}`).join('\n')}\n\n方案还差最后几步——继续调查,或修正方案后再次提交。`,
      }
    },
  )

  // ── 王国议会(确定性账本;顾问立场引擎确定,LLM 只写台词) ────────────────────
  ctx.tools.register({
    ...defineTool({
      name: 'council_consult',
      description:
        '王国议会:每季开始时调用,开启本季议会议程。引擎确定本季事件卡与各顾问立场,返回事件卡(议题 + 选项)。随后用 council_speak 收集顾问发言。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (_args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'council')
        const state = game.state as CouncilState
        const script = game.truth as CouncilScript
        if (state.pending !== null) {
          return { text: '本季议会已经开启,等待玩家决策或追问。' }
        }
        const { event } = openCouncil(script, state)
        await manager.update(game.sessionId, state)
        const options = event.options.map((o) => `- ${o.id}:${o.label}`).join('\n')
        return {
          text: `【第 ${state.season} 季 · 事件】${event.title}\n${event.prompt}\n\n【可选决策】\n${options}\n\n主持人守则:以史官口吻揭示本季议题,然后调用 council_speak 收集四位重臣的发言。选项 id 供玩家决策用,你不得暗示哪个选项更好。`,
        }
      },
    }),
    timeoutMs: 30_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'council_speak',
      description:
        '王国议会:议会开启后调用,收集四名顾问对本季议题的发言(引擎按其立场与风格生成台词,并过泄密审计)。你按返回顺序转述,不得替顾问加词或改词。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lines: { type: 'array', items: { type: 'string' }, required: true },
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (_args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'council')
        const state = game.state as CouncilState
        const script = game.truth as CouncilScript
        if (state.pending === null) {
          throw new Error('本季议会尚未开启,先调用 council_consult。')
        }
        const { lines } = await councilSpeak(ctx, exec.agent?.session.id ?? '', routeOf(exec.agent), script, state, exec.signal)
        for (const line of lines) {
          state.conversations[line.advisorId] = [
            ...(state.conversations[line.advisorId] ?? []),
            { role: 'assistant' as const, text: line.text },
          ].slice(-10)
        }
        await manager.update(game.sessionId, state)
        const rendered = lines.map((l) => `- ${l.name}:${l.text}${l.flagged ? '(已净化)' : ''}`).join('\n')
        return {
          lines: lines.map((l) => `${l.name}:${l.text}`),
          text: `【议会发言】\n${rendered}\n\n主持人守则:按顺序转述(可加神态描写,不得改词);玩家可以 council_question 追问某人、council_investigate 调查,或直接 council_decide 拍板。`,
        }
      },
    }),
    timeoutMs: 180_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'council_question',
      description:
        '王国议会:玩家向某位顾问追问时,把玩家的话原文传入。引擎让该顾问按其立场与风格回应(台词过泄密审计),你转述时保持原意。',
      parameters: {
        adviser: { type: 'string', required: true, description: '顾问名字(沈万钧 / 霍震霆 / 玄尘子 / 顾长风)' },
        text: { type: 'string', required: true, description: '玩家追问的原文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'council')
        const state = game.state as CouncilState
        const script = game.truth as CouncilScript
        const reply = await councilQuestion(ctx, exec.agent?.session.id ?? '', routeOf(exec.agent), script, state, String((args as { adviser: unknown }).adviser ?? ''), String((args as { text: unknown }).text ?? ''), exec.signal)
        await manager.update(game.sessionId, state)
        return { text: reply }
      },
    }),
    timeoutMs: 120_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'council_investigate',
      description:
        '王国议会:玩家花 2 金调查一位顾问(可能揭露其真实议程)或某个隐藏祸患(瘟疫/贪腐/外敌/饥荒,只返回趋势信号)。',
      parameters: {
        target: { type: 'string', required: true, description: '顾问名字,或 瘟疫潜伏/朝堂贪腐/外敌威胁/饥荒压力' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'council')
        const state = game.state as CouncilState
        const script = game.truth as CouncilScript
        const text = councilInvestigate(script, state, String((args as { target: unknown }).target ?? ''))
        await manager.update(game.sessionId, state)
        return { text }
      },
    }),
    timeoutMs: 30_000,
  })

  ctx.tools.register({
    ...defineTool({
      name: 'council_decide',
      description:
        '王国议会:玩家拍板决策时调用(option 为 council_consult 返回的选项 id)。引擎结算账本、按顾问主张与结果的吻合度更新信任评级、引爆隐藏祸患,并进入下一季。20 季末自动终局结算。',
      parameters: {
        option: { type: 'string', required: true, description: '选项 id(见 council_consult 返回的决策列表)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: renderText,
      },
      execute: async (args: unknown, exec) => {
        const game = await requireGame(manager, exec, 'council')
        const state = game.state as CouncilState
        const script = game.truth as CouncilScript
        const result = councilDecide(script, state, String((args as { option: unknown }).option ?? ''))
        state.score = councilScore(script, state)
        await manager.update(game.sessionId, state)
        return { text: result.text }
      },
    }),
    timeoutMs: 30_000,
  })

  // ── 单人跑团(种子骰子 + 战斗状态机;GM 只叙事,数值只走引擎) ──────────────────
  const trpgTool = (
    toolName: string,
    description: string,
    parameters: Record<string, { type: 'string'; required?: true; description: string }>,
    run: (
      script: TrpgScript,
      state: TrpgState,
      sessionId: string,
      args: Record<string, unknown>,
      exec: { agent?: { session: { id: string }; options?: { provider?: string; model?: string } } | undefined; signal?: AbortSignal },
    ) => Promise<{ result: string; text: string }> | { result: string; text: string },
  ): void => {
    ctx.tools.register({
      ...defineTool({
        name: toolName,
        description,
        parameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              result: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: renderText,
        },
        execute: async (args: unknown, exec) => {
          const game = await requireGame(manager, exec, 'trpg')
          const state = game.state as TrpgState
          const script = game.truth as TrpgScript
          const sessionId = exec.agent?.session.id ?? game.sessionId
          const record = (args ?? {}) as Record<string, unknown>
          const outcome = await run(script, state, sessionId, record, exec)
          if (outcome.result !== 'error') await manager.update(game.sessionId, state)
          return { result: outcome.result, text: outcome.text }
        },
      }),
      timeoutMs: 90_000,
    })
  }

  trpgTool(
    'trpg_move',
    '跑团:玩家要前往某个区域时调用。引擎按相邻关系裁决,并按遭遇表掷遭遇检定(可能触发战斗)。引擎没给的场景信息你绝不能编造。',
    { to: { type: 'string', required: true, description: '区域名(霜松林地 / 雾沼 / 铁喉城寨 / 铁喉内厅)' } },
    (script, state, sessionId, args) => {
      const r = trpgMove(script, state, sessionId, String(args.to ?? ''), state.difficulty)
      return { result: r.combat === true ? 'combat' : 'success', text: r.text }
    },
  )

  trpgTool(
    'trpg_examine',
    '跑团:玩家检查某个地点/地标/人物时调用。引擎返回描述与任务线索(可能推进任务目标)。',
    { target: { type: 'string', required: true, description: '地标或人物名(如 商队残骸/内厅门/铁匠铺)' } },
    (script, state, _sessionId, args) => {
      return { result: 'success', text: trpgExamine(script, state, String(args.target ?? '')) }
    },
  )

  trpgTool(
    'trpg_check',
    '跑团:玩家做技能检定或非常规动作(奇招)时调用。你按难度提议 dc(5-25),引擎用种子骰子裁决并留档;成功/失败后的剧情由你渲染,但 HP/物品/任务变化必须走其他引擎工具。',
    {
      skill: { type: 'string', required: true, description: '技能名(stealth/athletics/persuasion/perception,或自由描述)' },
      dc: { type: 'string', required: true, description: '难度等级数字(5-25)' },
      description: { type: 'string', required: true, description: '这次检定的动作描述(留档用)' },
    },
    (script, state, sessionId, args) => {
      const dc = Number(args.dc)
      if (!Number.isFinite(dc) || dc < 5 || dc > 25) return { result: 'error', text: 'dc 须为 5-25 的数字' }
      const r = trpgRollCheck(script, state, sessionId, String(args.skill ?? ''), Math.round(dc), 'none', String(args.description ?? ''))
      const text = `【引擎检定】${r.detail}

主持人守则:按检定结果渲染剧情(成功=玩家意图达成;失败=合理的后果),但不得改动 HP/物品/任务——那些变化只能走引擎工具。`
      return { result: 'success', text }
    },
  )

  trpgTool(
    'trpg_talk',
    '跑团:玩家与在场的某位 NPC 对话时,把玩家的话原文传入。引擎让该 NPC 按角色页回应(知识边界/说谎边界/好感度),台词过泄密审计。',
    {
      npc: { type: 'string', required: true, description: 'NPC 名字(老霍克 / 希尔达 / 铁牙罗格)' },
      text: { type: 'string', required: true, description: '玩家对 NPC 说的话原文' },
    },
    async (script, state, sessionId, args, exec) => {
      const reply = await trpgTalk(ctx, sessionId, routeOf(exec.agent), script, state, String(args.npc ?? ''), String(args.text ?? ''), exec.signal)
      return { result: 'success', text: reply }
    },
  )

  trpgTool(
    'trpg_use',
    '跑团:玩家使用背包里的物品时调用(如 喝治疗药水/用铜钥匙开内厅门/把模具交给铁匠)。引擎裁决效果并更新状态。',
    { item: { type: 'string', required: true, description: '物品名(治疗药水 / 铜钥匙 / 铁砧模具)' } },
    (script, state, _sessionId, args) => {
      return { result: 'success', text: trpgUse(script, state, String(args.item ?? '')) }
    },
  )

  trpgTool(
    'trpg_attack',
    '跑团:战斗中玩家攻击某个敌人时调用。引擎掷攻击骰、算伤害、结算敌人反击与胜利奖励。',
    { target: { type: 'string', required: true, description: '敌人名(雾沼灰狼 / 铁喉山贼 / 铁牙罗格)' } },
    (script, state, sessionId, args) => {
      const r = trpgAttack(script, state, sessionId, String(args.target ?? ''))
      return { result: r.victory === true ? 'victory' : r.defeat === true ? 'defeat' : 'success', text: r.text }
    },
  )

  trpgTool(
    'trpg_flee',
    '跑团:战斗中玩家尝试逃跑时调用。引擎做潜行检定,失败则敌人反击。',
    {},
    (script, state, sessionId) => {
      const r = trpgFlee(script, state, sessionId, state.difficulty)
      return { result: r.defeat === true ? 'defeat' : 'success', text: r.text }
    },
  )

  trpgTool(
    'trpg_rest',
    '跑团:玩家休整时调用。引擎恢复 HP 并记录次数(每局 3 次)。',
    {},
    (script, state) => {
      return { result: 'success', text: trpgRest(script, state) }
    },
  )
}
