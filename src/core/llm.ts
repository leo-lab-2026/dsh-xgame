/**
 * 插件侧 LLM 调用:裁决引擎、NPC 扮演、推理评分都在这里完成。
 * 真相数据只在本插件的调用里出现,永不进入主 agent 上下文。
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRoute } from '../types.js'

export class LlmUnavailableError extends Error {
  constructor() {
    super('dsh-xgame:llm 服务不可用(本插件需要宿主组合挂载 @deepseek-ai/dsh-llm)')
  }
}

export interface CompleteOptions {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

/** 一次插件侧对话补全,返回纯文本。 */
export async function complete(ctx: Context, route: AgentRoute, options: CompleteOptions): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') throw new LlmUnavailableError()
  const provider = route.provider ?? ''
  const model = route.model ?? ''
  if (provider === '' || model === '') {
    throw new Error('dsh-xgame:当前 agent 未配置 provider/model,无法进行内部裁决')
  }
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: options.user }],
      source: { kind: 'user' },
    }),
  ]
  const stream = llm.stream({
    provider,
    model,
    messages,
    system: options.system,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    signal: options.signal,
  })
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text.trim()
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

/** 带对话历史的一次补全。 */
export async function completeChat(ctx: Context, route: AgentRoute, options: CompleteOptions & { history?: ChatTurn[] }): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') throw new LlmUnavailableError()
  const provider = route.provider ?? ''
  const model = route.model ?? ''
  if (provider === '' || model === '') {
    throw new Error('dsh-xgame:当前 agent 未配置 provider/model,无法进行内部裁决')
  }
  const messages = (options.history ?? []).map((turn) =>
    turn.role === 'assistant'
      ? createAssistantMessage({
          content: [{ type: 'text', text: turn.text }],
          source: { provider, model },
        })
      : createUserMessage({
          content: [{ type: 'text', text: turn.text }],
          source: { kind: 'user' },
        }),
  )
  messages.push(createUserMessage({
    content: [{ type: 'text', text: options.user }],
    source: { kind: 'user' },
  }))
  const stream = llm.stream({
    provider,
    model,
    messages,
    system: options.system,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    signal: options.signal,
  })
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text.trim()
}

/** 从模型输出中提取 JSON(容忍 markdown 代码围栏)。 */
export function extractJson<T>(text: string): T {
  let body = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence) body = fence[1].trim()
  const first = body.indexOf('{')
  const last = body.lastIndexOf('}')
  if (first >= 0 && last > first) body = body.slice(first, last + 1)
  return JSON.parse(body) as T
}
