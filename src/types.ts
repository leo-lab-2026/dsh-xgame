/** dsh-xgame 共享类型。 */

export type SchemeId = 'soup' | 'detective' | 'escape' | 'party' | 'loop' | 'council' | 'trpg'

export interface ScoreBar {
  label: string
  value: number
  note: string
}

export type GamePhase = 'playing' | 'solved' | 'given_up' | 'settled'

export interface GameStateBase {
  scheme: SchemeId
  difficulty: number
  startedAt: number
  updatedAt: number
  phase: GamePhase
  /** 玩家动作/引擎操作计数(斜杠命令不计)。 */
  turns: number
  hintsUsed: number
  /** 结算后的三栏得分。 */
  score: ScoreBar[] | null
}

export interface LoadedGame<S extends GameStateBase = GameStateBase, T = unknown> {
  sessionId: string
  state: S
  truth: T
}

/** 工具执行上下文里可用的最小 agent 路由信息。 */
export interface AgentRoute {
  provider?: string
  model?: string
  maxTokens?: number
}
