/**
 * dsh-xgame — DeepSeek Harness 文字冒险/推理游戏插件。
 *
 * 架构:确定性内核(状态与真相落盘,真相永不进模型上下文)+ 主 agent 扮演 GM +
 * 插件侧 LLM 完成裁决/NPC 扮演/推理评分。
 *
 * Bundle row id: `dsh-xgame`(见 cordis.patch.yml)。
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import { GameManager } from './core/manager.js'
import { registerCommands } from './commands.js'
import { registerTools } from './tools.js'

export const name = 'dsh-xgame'

/** 工具注册表必须先挂载(所有游戏动作都注册为工具)。 */
export const inject = ['tools']

export function apply(ctx: Context, config: unknown): void {
  const cfg = resolveConfig(config)
  const manager = new GameManager(ctx, cfg)
  registerTools(ctx, manager)
  registerCommands(ctx, manager)
  const logger = ctx.logger('dsh-xgame')
  logger.info('[dsh-xgame] 游戏插件已加载。开局:/game new soup|detective|escape|party|loop|council|trpg')
}
