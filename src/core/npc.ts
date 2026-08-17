/**
 * NPC 子代理层(docs/03 §5.5 / docs/05 §5.5 的 subagent 化 NPC):
 *
 * NPC 台词由**隔离的一次性子代理**生成:
 *  - 走 `ctx.subagents` 的 `spawn` provider(不继承主会话上下文 → 真相永不进入 NPC 会话);
 *  - `toolFilter: { allow: [] }` → 子代理没有任何工具,只能回一句台词;
 *  - 人设/角色页以提示词注入,历史窗口由调用方传入(时间循环回滚时历史被清空,
 *    天然实现"NPC 循环内失忆");
 *  - 每次对话一个子代理,出结果即释放(run.dispose)。
 *
 * 子代理不可用(离线/冒烟/mock 环境、无 agents 注册表、provider 缺失)时
 * 自动回退到无状态 LLM(completeChat);两者都不可用时抛出 LlmUnavailableError,
 * 由调用方给静默兜底。因此本插件在无 subagent 服务的主机上也照常工作。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentRoute } from '../types.js'
import { completeChat, LlmUnavailableError, type ChatTurn } from './llm.js'

/** NPC 台词的实际生成通道。 */
export type NpcChannel = 'subagent' | 'llm'

export interface NpcTalkResult {
  text: string
  channel: NpcChannel
}

export interface NpcTalkOptions {
  /** 当前主会话 id(用于解析活体父 Agent;找不到时回退)。 */
  sessionId: string
  route: AgentRoute
  /** 子代理标签(如 `npc:loop:钱掌柜`),进入子代理会话投影,便于 UI/日志辨识。 */
  label: string
  /** NPC 人设系统提示(仅在 LLM 回退通道使用;子代理通道把全部内容放用户消息)。 */
  system: string
  /** 用户消息(子代理的 prompt 或 LLM 回退的 user)。 */
  user: string
  history?: ChatTurn[]
  maxTokens?: number
  signal?: AbortSignal
}

/** 解析 subagents 服务;必须含 `spawn` provider(fork 继承父上下文,禁用)。 */
export function subagentService(ctx: Context): SubagentRuntime | undefined {
  try {
    const svc = ctx.get('subagents') as SubagentRuntime | undefined
    if (svc === undefined || typeof svc.start !== 'function') return undefined
    return svc.list().includes('spawn') ? svc : undefined
  } catch {
    return undefined
  }
}

/** 解析会话的活体父 Agent(子代理 start 的 parent 凭据)。 */
export function parentAgent(ctx: Context, sessionId: string): Agent | undefined {
  try {
    const registry = ctx.get('agents') as AgentRegistry | undefined
    return registry?.get(SessionId(sessionId))
  } catch {
    return undefined
  }
}

/** 子代理输出(ContentBlock 序列)→ 纯文本。 */
export function npcOutputText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

/**
 * 以 NPC 身份生成一句台词。优先隔离子代理;失败回退无状态 LLM;
 * 两者都不可用时抛出 LlmUnavailableError(与 completeChat 一致,调用方按需兜底)。
 */
export async function talkAsNpc(ctx: Context, options: NpcTalkOptions): Promise<NpcTalkResult> {
  const svc = subagentService(ctx)
  const parent = parentAgent(ctx, options.sessionId)
  if (svc !== undefined && parent !== undefined) {
    try {
      // 子代理不继承父上下文:角色页(system)+ 历史窗口 + 玩家消息全部拼进 prompt
      const blocks: ContentBlock[] = [{ type: 'text', text: options.system }]
      const history = options.history ?? []
      if (history.length > 0) {
        const transcript = history
          .map((turn) => `${turn.role === 'user' ? '玩家' : '你'}说:${turn.text}`)
          .join('\n')
        blocks.push({ type: 'text', text: `\n【此前的对话】\n${transcript}` })
      }
      blocks.push({ type: 'text', text: `\n\n${options.user}\n\n请只以角色的身份回一句台词。` })
      const run = await svc.start('spawn', {
        label: options.label,
        prompt: blocks,
        parent,
        signal: options.signal ?? new AbortController().signal,
        agentOptions: {
          provider: options.route.provider,
          model: options.route.model,
          maxTokens: options.maxTokens ?? 300,
        },
        toolFilter: { allow: [] },
      })
      try {
        const result = await run.result
        const text = npcOutputText(result.output)
        if (text !== '') return { text, channel: 'subagent' }
      } finally {
        void run.dispose().catch(() => undefined)
      }
    } catch {
      // 子代理启动/运行失败 → 回退无状态 LLM
    }
  }
  try {
    const text = await completeChat(ctx, options.route, {
      system: options.system,
      user: options.user,
      history: options.history,
      maxTokens: options.maxTokens,
      signal: options.signal,
    })
    return { text, channel: 'llm' }
  } catch (error) {
    if (error instanceof LlmUnavailableError) throw error
    throw new LlmUnavailableError()
  }
}
