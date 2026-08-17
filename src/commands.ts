/** 斜杠命令注册:/game、/casefile、/hint(经 commands 服务,不占模型上下文)。 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { GameManager } from './core/manager.js'
import { GameError } from './core/manager.js'

const HELP = `【dsh-xgame 游戏命令】
/game new <soup|detective|escape|party|loop|council|trpg> [难度 1-3]   开局(海龟汤 / 侦探推理 / 密室逃脱 / 剧本杀 / 时间循环 / 王国议会 / 单人跑团)
/game resume                              恢复存档对局
/game score                               查看当前得分
/game quit                                结束对局并查看真相
/hint                                     购买一条提示(计入效率分)
/casefile                                 侦探推理:查看已收集线索卷宗
/look /bag /map                           密室逃脱:观察房间 / 背包 / 地图
/roles /timeline                          剧本杀:角色名册 / 已确证时间线
/facts /relations /schedule /loops        时间循环:元知识 / 好感度 / 已观测时间表 / 循环记录
/ledger /trust /history                   王国议会:账本 / 信任评级 / 历史决策
/sheet /quests /world                     单人跑团:角色卡 / 任务 / 地图`

export function registerCommands(ctx: Context, manager: GameManager): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'game',
      description: '文字冒险/推理游戏:开局、查分、退出',
      input: { hint: 'new <soup|detective> [难度] | resume | score | quit | help' },
      handler: async (invocation: CommandInvocation) => {
        const { agent, rawInput } = invocation
        const parts = rawInput.trim().split(/\s+/).filter((p) => p !== '')
        const sub = parts[0] ?? 'help'
        try {
          switch (sub) {
            case 'new': {
              const scheme = parts[1] ?? ''
              if (scheme !== 'soup' && scheme !== 'detective' && scheme !== 'escape' && scheme !== 'party' && scheme !== 'loop' && scheme !== 'council' && scheme !== 'trpg') {
                return { kind: 'error', text: `未知游戏类型「${scheme}」。用法:/game new soup、detective、escape、party、loop、council 或 trpg(可加难度 1-3,如 /game new trpg 2)` }
              }
              const difficulty = parts[2] !== undefined ? Number(parts[2]) : 1
              if (!Number.isFinite(difficulty) || difficulty < 1 || difficulty > 3) {
                return { kind: 'error', text: '难度须为 1-3 的整数。' }
              }
              const brief = await manager.newGame(agent.session.id, scheme, difficulty)
              manager.submitBrief(agent, brief)
              return { kind: 'success', text: `🎮 新游戏已开局:${manager.schemeLabel(scheme)}(难度 ${difficulty}/3)。主持人即将登场——开始你的第一句话吧。` }
            }
            case 'resume': {
              const brief = await manager.resumeBrief(agent.session.id)
              manager.submitBrief(agent, brief)
              return { kind: 'success', text: '🔄 已恢复对局。' }
            }
            case 'score':
              return { kind: 'success', text: await manager.scoreText(agent.session.id) }
            case 'quit':
              return { kind: 'success', text: await manager.quit(agent.session.id) }
            case 'help':
              return { kind: 'success', text: HELP }
            default:
              return { kind: 'error', text: `未知子命令「${sub}」。\n${HELP}` }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: message }
        }
      },
    })

    commandCtx.commands.register({
      name: 'hint',
      description: '购买一条提示(计入效率分)',
      handler: async (invocation: CommandInvocation) => {
        const { agent } = invocation
        try {
          const text = await manager.hint(agent.session.id)
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
        }
      },
    })

    commandCtx.commands.register({
      name: 'casefile',
      description: '侦探推理:查看已收集的线索卷宗',
      handler: async (invocation: CommandInvocation) => {
        const { agent } = invocation
        try {
          const text = await manager.casefile(agent.session.id)
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
        }
      },
    })

    const escapePanelCommand = (name: string, panel: 'look' | 'bag' | 'map', description: string): void => {
      commandCtx.commands.register({
        name,
        description,
        handler: async (invocation: CommandInvocation) => {
          const { agent } = invocation
          try {
            const text = await manager.escapePanel(agent.session.id, panel)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
          }
        },
      })
    }
    escapePanelCommand('look', 'look', '密室逃脱:观察当前房间')
    for (const panel of ['bag', 'map'] as const) {
      commandCtx.commands.register({
        name: panel,
        description: panel === 'bag' ? '查看背包(密室逃脱 / 单人跑团)' : '查看地图(密室逃脱 / 单人跑团)',
        handler: async (invocation: CommandInvocation) => {
          const { agent } = invocation
          try {
            const text = await manager.bagOrMap(agent.session.id, panel)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
          }
        },
      })
    }

    const partyPanelCommand = (name: string, panel: 'roles' | 'timeline' | 'role', description: string): void => {
      commandCtx.commands.register({
        name,
        description,
        handler: async (invocation: CommandInvocation) => {
          const { agent } = invocation
          try {
            const text = await manager.partyPanel(agent.session.id, panel)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
          }
        },
      })
    }
    partyPanelCommand('roles', 'roles', '剧本杀:查看角色名册')
    partyPanelCommand('timeline', 'timeline', '剧本杀:查看已确证时间线')
    partyPanelCommand('role', 'role', '剧本杀:查看我的角色(反转模式下为秘密凶手卡)')

    const loopPanelCommand = (name: string, panel: 'facts' | 'relations' | 'schedule' | 'loops', description: string): void => {
      commandCtx.commands.register({
        name,
        description,
        handler: async (invocation: CommandInvocation) => {
          const { agent } = invocation
          try {
            const text = await manager.loopPanel(agent.session.id, panel)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
          }
        },
      })
    }
    loopPanelCommand('facts', 'facts', '时间循环:查看元知识清单')
    loopPanelCommand('relations', 'relations', '时间循环:查看 NPC 好感度')
    loopPanelCommand('schedule', 'schedule', '时间循环:查看已观测时间表')
    loopPanelCommand('loops', 'loops', '时间循环:查看循环记录与 diff')

    const councilPanelCommand = (name: string, panel: 'ledger' | 'trust' | 'history', description: string): void => {
      commandCtx.commands.register({
        name,
        description,
        handler: async (invocation: CommandInvocation) => {
          const { agent } = invocation
          try {
            const text = await manager.councilPanel(agent.session.id, panel)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
          }
        },
      })
    }
    councilPanelCommand('ledger', 'ledger', '王国议会:查看账本与隐藏祸患趋势')
    councilPanelCommand('trust', 'trust', '王国议会:查看顾问信任评级')
    councilPanelCommand('history', 'history', '王国议会:查看历史决策')

    const trpgPanelCommand = (name: string, panel: 'sheet' | 'quests' | 'world', description: string): void => {
      commandCtx.commands.register({
        name,
        description,
        handler: async (invocation: CommandInvocation) => {
          const { agent } = invocation
          try {
            const text = await manager.trpgPanel(agent.session.id, panel)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: error instanceof GameError ? error.message : String(error) }
          }
        },
      })
    }
    trpgPanelCommand('sheet', 'sheet', '单人跑团:查看角色卡')
    trpgPanelCommand('quests', 'quests', '单人跑团:查看任务日志')
    trpgPanelCommand('world', 'world', '单人跑团:查看世界地图')
  })
}
