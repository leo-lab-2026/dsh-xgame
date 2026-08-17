/** 游戏管理器:每会话一局,内存缓存 + 落盘持久化。 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { XgameConfig } from '../config.js'
import type { GameStateBase, LoadedGame, SchemeId } from '../types.js'
import { defaultStorageRoot, dropSession, loadJson, saveJson } from './store.js'
import { casefileText, detectiveEngine, type DetectiveCase, type DetectiveState } from '../games/detective.js'
import { soupEngine } from '../games/soup.js'
import { escapeEngine, panelText, type EscapePanel, type EscapeScenario, type EscapeState } from '../games/escape.js'
import { partyEngine, panelText as partyPanelText, type PartyPanel, type PartyState } from '../games/party.js'
import { loopEngine, panelText as loopPanelText, type LoopPanel, type LoopScript, type LoopState } from '../games/loop.js'
import { councilEngine, panelText as councilPanelText, type CouncilPanel, type CouncilScript, type CouncilState } from '../games/council.js'
import { trpgEngine, panelText as trpgPanelText, type TrpgPanel, type TrpgScript, type TrpgState } from '../games/trpg.js'

export interface SchemeEngine {
  id: SchemeId
  label: string
  /** 开局:生成状态与真相,返回注入给 GM 的开场简报。 */
  create(sessionId: string, difficulty: number): Promise<{ state: GameStateBase; truth: unknown; brief: string }>
  /** 续玩简报。 */
  resumeBrief(state: GameStateBase, truth?: unknown): string
  /** /game score 展示文本。 */
  scoreText(state: GameStateBase, truth?: unknown): string
  /** /game quit 时的结算文本(含真相揭晓,直接渲染在命令结果里,不进模型上下文)。 */
  settleText(state: GameStateBase, truth: unknown): string
  /** /hint 提示文本(调用方负责 hintsUsed++ 与落盘)。 */
  hint(state: GameStateBase, truth: unknown): { text: string }
}

const ENGINES: Record<SchemeId, SchemeEngine> = {
  soup: soupEngine,
  detective: detectiveEngine,
  escape: escapeEngine,
  party: partyEngine,
  loop: loopEngine,
  council: councilEngine,
  trpg: trpgEngine,
}

export class GameError extends Error {}

export class GameManager {
  private readonly root: string
  private readonly cache = new Map<string, LoadedGame>()

  constructor(private readonly ctx: Context, config: XgameConfig) {
    this.root = config.storageDir === '' ? defaultStorageRoot() : config.storageDir
  }

  schemeLabel(scheme: SchemeId): string {
    return ENGINES[scheme].label
  }

  async load<S extends GameStateBase = GameStateBase>(sessionId: string): Promise<LoadedGame<S, unknown> | null> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached as LoadedGame<S, unknown>
    const state = await loadJson<S>(this.root, sessionId, 'state.json')
    if (state === null) return null
    const truth = await loadJson(this.root, sessionId, 'truth.json')
    const loaded: LoadedGame = { sessionId, state, truth }
    this.cache.set(sessionId, loaded)
    return loaded as LoadedGame<S, unknown>
  }

  async update(sessionId: string, state: GameStateBase): Promise<void> {
    state.updatedAt = Date.now()
    const loaded = await this.load(sessionId)
    this.cache.set(sessionId, { sessionId, state, truth: loaded?.truth ?? null })
    await saveJson(this.root, sessionId, 'state.json', state)
  }

  /** 开局:创建状态与真相,落盘,并返回开场简报文本。 */
  async newGame(sessionId: string, scheme: SchemeId, difficulty: number): Promise<string> {
    const active = await this.load(sessionId)
    if (active !== null) {
      throw new GameError(`已有一局「${ENGINES[active.state.scheme].label}」进行中。先 /game quit 结束当前对局。`)
    }
    const engine = ENGINES[scheme]
    const created = await engine.create(sessionId, difficulty)
    await saveJson(this.root, sessionId, 'state.json', created.state)
    await saveJson(this.root, sessionId, 'truth.json', created.truth)
    this.cache.set(sessionId, { sessionId, state: created.state, truth: created.truth })
    return created.brief
  }

  /** 续玩简报(存档存在时)。 */
  async resumeBrief(sessionId: string): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('没有可恢复的对局。输入 /game new soup 或 /game new detective 开局。')
    }
    const engine = ENGINES[loaded.state.scheme]
    return engine.resumeBrief(loaded.state, loaded.truth)
  }

  async scoreText(sessionId: string): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。输入 /game new soup 或 /game new detective 开局。')
    }
    return ENGINES[loaded.state.scheme].scoreText(loaded.state, loaded.truth)
  }

  /** 结束对局:返回结算文本(含真相),并清除存档。 */
  async quit(sessionId: string): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    const engine = ENGINES[loaded.state.scheme]
    const text = engine.settleText(loaded.state, loaded.truth)
    this.cache.delete(sessionId)
    await dropSession(this.root, sessionId)
    return text
  }

  /** 购买一条提示(计入 hintsUsed)。 */
  async hint(sessionId: string): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。输入 /game new soup 或 /game new detective 开局。')
    }
    const { text } = ENGINES[loaded.state.scheme].hint(loaded.state, loaded.truth)
    loaded.state.hintsUsed += 1
    await this.update(sessionId, loaded.state)
    return text
  }

  /** 侦探推理:卷宗(已收集线索)。 */
  async casefile(sessionId: string): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme !== 'detective') {
      throw new GameError('当前游戏没有卷宗(仅侦探推理支持 /casefile)。')
    }
    return casefileText(loaded.state as DetectiveState, loaded.truth as DetectiveCase)
  }

  /** 密室逃脱:/look /bag /map 面板。 */
  async escapePanel(sessionId: string, panel: EscapePanel): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme !== 'escape') {
      throw new GameError(`当前游戏没有「${panel}」面板(仅密室逃脱支持)。`)
    }
    return panelText(loaded.truth as EscapeScenario, loaded.state as EscapeState, panel)
  }

  /** 剧本杀:/roles /timeline 面板。 */
  async partyPanel(sessionId: string, panel: PartyPanel): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme !== 'party') {
      throw new GameError(`当前游戏没有「${panel}」面板(仅剧本杀支持)。`)
    }
    return partyPanelText(loaded.truth as DetectiveCase, loaded.state as PartyState, panel)
  }

  /** 时间循环:/facts /relations /schedule /loops 面板。 */
  async loopPanel(sessionId: string, panel: LoopPanel): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme !== 'loop') {
      throw new GameError(`当前游戏没有「${panel}」面板(仅时间循环支持)。`)
    }
    return loopPanelText(loaded.truth as LoopScript, loaded.state as LoopState, panel)
  }

  /** 王国议会:/ledger /trust /history 面板。 */
  async trpgPanel(sessionId: string, panel: TrpgPanel): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme !== 'trpg') {
      throw new GameError(`当前游戏没有「${panel}」面板(仅单人跑团支持)。`)
    }
    return trpgPanelText(loaded.truth as TrpgScript, loaded.state as TrpgState, panel)
  }

  /** /bag /map:按方案路由(密室逃脱与单人跑团共用命令名)。 */
  async bagOrMap(sessionId: string, panel: 'bag' | 'map'): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme === 'escape') {
      return panelText(loaded.truth as EscapeScenario, loaded.state as EscapeState, panel)
    }
    if (loaded.state.scheme === 'trpg') {
      return trpgPanelText(loaded.truth as TrpgScript, loaded.state as TrpgState, panel)
    }
    throw new GameError(`当前游戏没有「${panel}」面板(密室逃脱或单人跑团支持)。`)
  }

  /** 王国议会:/ledger /trust /history 面板。 */
  async councilPanel(sessionId: string, panel: CouncilPanel): Promise<string> {
    const loaded = await this.load(sessionId)
    if (loaded === null) {
      throw new GameError('当前会话没有进行中的游戏。')
    }
    if (loaded.state.scheme !== 'council') {
      throw new GameError(`当前游戏没有「${panel}」面板(仅王国议会支持)。`)
    }
    return councilPanelText(loaded.truth as CouncilScript, loaded.state as CouncilState, panel)
  }

  /** 把开场简报作为一条用户消息投递给 agent,唤醒其扮演 GM。 */
  submitBrief(agent: Agent, brief: string): void {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: brief }],
      source: { kind: 'user' },
    }))
  }
}
