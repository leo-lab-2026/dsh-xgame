# dsh-xgame:用 DSH 玩文字冒险与推理游戏

> 插件策划总览与技术底座。本文档是全部游戏方案的公共基础,方案文档(`01`~`07`)均引用本文档的章节。
> 当前阶段:**仅策划,暂不开发**。

---

## 1. 项目概述

**dsh-xgame** 是一个 DeepSeek Harness(DSH)游戏插件,目标是让用户在 DSH Web 聊天界面里游玩**文字冒险 / 推理游戏**:单人玩家 + 大模型担任的游戏主持人(GM)与 NPC 阵容。

定位声明:

- **人机对战,而非人机工具**:游戏不是"让 AI 帮用户写代码"的变体,而是用户与 AI 玩。DSH 的一切交互能力——自然语言、多轮对话、多智能体、工具、持久化——都服务于"玩"。
- **LLM 是引擎,更是演员**:大模型同时承担三个角色——叙事者(文采与氛围)、规则裁判(自由裁决)、NPC 演员(千人千面)。确定性内核保证"游戏是公平的",LLM 保证"游戏是好玩的"。
- **一个插件,七个方案**:插件包内按方案分模块(见[§10 方案索引](#10-方案索引)),用户按兴趣与难度选择开局的游戏。

非目标(本阶段):

- 不做多人联机(多人类玩家同局)。
- 不做美术/音效资产,UI 复用 DSH Web 现有的聊天流与工具卡片。
- 不做"AI 帮玩家代打"或"AI 与 AI 对打给人类看"的模式(后者可作为观战彩蛋,但不在核心玩法内)。

---

## 2. 为什么 DSH 适合做文字冒险/推理游戏

DSH 与通用聊天机器人相比,具备几个对游戏至关重要、而聊天机器人没有的能力:

| DSH 能力 | 机制 | 对游戏的意义 |
|---|---|---|
| **多智能体** | `subagent` 工具,continuable 后台子代理,可多轮对话、每子代理独立 persona | NPC 拥有**私有记忆与私有知识**,信息不对称成为可实现的玩法(审讯、剧本杀、顾问议会) |
| **多代理编排** | `workflow` 工具 | 群戏场景(公聊、议会辩论)中并发收集多个 NPC 的反应 |
| **工具注册** | `ctx.tools.register(defineTool(...))` | 玩家动作(`examine/talk/use/accuse`)注册为带 schema 与 UI 卡片的工具,规则由引擎裁决 |
| **斜杠命令** | `ctx.commands.register()` | `/look /bag /map /hint /save /score` 等元命令,不占用模型上下文 |
| **结构化提问** | 模型侧 `ask_user_question` 工具 | 正式抉择点(指控、投票、路线分支)给玩家选项 + 自定义回答 |
| **会话持久化** | 会话自动落盘(`session.jsonl.zstd`)、`session/event` 事件流、storages 目录 | 断线续玩、长线战役跨会话推进、自动 checkpoint |
| **技能系统** | `ctx.skills.register` / filesystem 技能提供方 | 规则书(跑团规则、计分规则)按需注入,不常驻上下文 |
| **任务系统** | `goal` 工具 | 跑团任务链、章节目标的管理与推进 |
| **定时器** | `inject: ['timer']` 的 `ctx.timeout` | 限时挑战、NPC 自主行动时钟、结算前的倒计时 |
| **设置持久化** | `dsh-settings`(settings.yaml) | 难度、语言、显示偏好按用户持久化 |

最关键的一点:**DSH 允许我们把"规则"和"叙事"分开**。规则写成确定性代码(引擎),叙事交给 LLM(演绎)。聊天机器人只能两者混在一个上下文里,因此容易出现"AI 随口放水/随口加戏"的失控;DSH 的工具与文件系统让引擎成为唯一真相。

---

## 3. DSH 插件形态与安装

### 3.1 插件包形态

`dsh-xgame` 是标准 DSH 插件包,遵循 Cordis 插件约定:

```
dsh-xgame/
├── package.json          # 含 dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 注册游戏服务行的 bundle patch
├── lib/                  # 构建产物
│   ├── index.js          # export const name / inject / apply(ctx, config)
│   ├── core/             # 确定性内核(状态仓库、裁决引擎、谜题引擎)
│   ├── schemes/          # 七个方案各自的引擎与内容生成器
│   ├── npc/              # NPC 运行时(subagent 封装)
│   └── ui/               # presentCall/presentResult 卡片
└── src/                  # TypeScript 源码
```

`cordis.patch.yml` 形态(参考现有插件约定,insert 行注册服务):

```yaml
# dsh-xgame bundle patch:用户可在 profile 的 cordis.patch.yml 中按 id 覆盖。
- insert:
    - id: dsh-xgame
      name: 'dsh-xgame'
      config:
        storageRoot: ''          # 空 = 使用 DSH storages 目录下的 dsh-xgame/ 子目录
        defaultScheme: detective # 开局默认方案
        language: zh-CN
```

插件主入口骨架:

```ts
// lib/index.js —— 设计级示意,不代表最终签名
export const name = 'dsh-xgame'
export const inject = ['timer']

export function apply(ctx, config) {
  const game = new GameService(ctx, config) // 状态仓库 + 裁决引擎 + 计分 + NPC 运行时
  game.registerTools(ctx)   // ctx.tools.register(...) 注册玩家动作
  game.registerCommands(ctx) // ctx.commands.register(...) 注册斜杠命令
  game.installCheckpoints(ctx) // ctx.on('session/event', ...) 自动存档
  ctx.effect(() => () => game.dispose())
}
```

### 3.2 安装方式

DSH 的 profile 通过 `package.json` 的 `dsh.profile.bundles` 装载组合包。两种使用方式:

1. **独立游戏 profile(推荐)**:`dsh plugin --profile game add dsh-xgame`,profile 的 bundles 为
   `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-xgame"]`,用 `dsh --profile game` 启动。
2. **加入现有 web profile**:把 `dsh-xgame` 追加进 web profile 的 bundles,与日常开发环境共存;游戏通过斜杠命令 `/game new <方案>` 开局。

---

## 4. 三层架构

所有方案共享同一架构,只有"内核内容"与"NPC 数量"不同:

```
┌─────────────────────────────────────────────────┐
│ 玩家(人类)                                       │
│   自然语言动作 / 斜杠命令 / ask_user 抉择 / 打字   │
└───────────────┬─────────────────────────────────┘
                ▼
┌─────────────────────────────────────────────────┐
│ ① 确定性内核(唯一真相)                            │
│   GameState(JSON + Schemastery schema)落盘 fs     │
│   规则函数:行动裁决、谜题解、事实图、时间表、账本    │
│   —— LLM 不可改写,只能读取快照                    │
└───────────────┬─────────────────────────────────┘
                ▼ 状态快照(强制注入)
┌─────────────────────────────────────────────────┐
│ ② LLM 叙事层(主 GM agent)                        │
│   意图解析:自然语言 → 引擎操作                      │
│   叙事渲染:引擎结果 → 有文采的描写                  │
│   节奏主持:提示、紧张感、转场                       │
└───────────────┬─────────────────────────────────┘
                ▼ 需要角色扮演时
┌─────────────────────────────────────────────────┐
│ ③ NPC 多智能体层(continuable subagent)            │
│   每个 NPC:独立 persona + 私有知识 + 私有记忆      │
│   玩家与其对话走 send_message 多轮持久会话          │
│   群戏场景走 workflow 并发收集                      │
└─────────────────────────────────────────────────┘
```

**层级之间的单向数据流是设计的生命线**:内核状态 → 快照注入叙事层;叙事层与 NPC 层都不能反向修改内核,只能通过"引擎操作"这一窄接口提交变更。谁都可以被 LLM 自由发挥,唯独事实不行。

### 4.1 ① 确定性内核

- **GameState**:每个方案一个 JSON 状态模型(Schemastery schema 校验),包括场景、物品、线索、NPC 状态、玩家状态、回合计数、计时等。状态文件落在 `storages/dsh-xgame/<sessionId>/state.json`,每次变更原子写入(临时文件 + rename)。
- **规则函数**:纯函数,输入(当前状态, 操作参数) → 输出(新状态, 结果描述)。例如 `applyUseItem`、`applyExamine`、`checkDeduction`。全部可单元测试。
- **真相数据**(与状态分离存放):事实图、谜题解、答案卡、事件时间表、凶手身份等,生成后**永不进入 GM 上下文**,仅引擎可读。

### 4.2 ② LLM 叙事层

主 GM agent 由插件配置 persona 与工具白名单(见[§6 交互层](#6-交互层设计))。两条核心约定写入 GM 的 system prompt:

1. **意图解析**:玩家输入自由文本后,GM 先将其解析为 0..N 个引擎操作,提交引擎执行;引擎返回的结构化结果再被 GM 渲染为叙事。GM 没有"直接推进剧情"的权力。
2. **状态忠实**:每次回复前,引擎把当前状态快照注入 GM 上下文;GM 的描写不得与快照矛盾(如不得描写玩家没有的物品)。

### 4.3 ③ NPC 多智能体层

- 每个 NPC = 一个 continuable 子代理会话,存活于整局游戏;玩家与 NPC 对话不经过 GM 转述(或仅由 GM 主持转场)。
- NPC 的 system prompt 由其"角色页"生成:人设、目标、性格、**他知道什么**(知识边界)、**他可以说谎到什么程度**(说谎边界)、对话风格。
- NPC 之间原则上不直接通信;群戏场景由 workflow 并发收集各 NPC 的一句话反应后汇总呈现。
- NPC 的记忆存在于其自身会话中;需要跨场景记忆时,由内核在其"角色档案"里维护结构化摘要,在新一轮对话开启时注入。

---

## 5. 反幻觉与一致性总原则

> **真相先于叙事(truth-first generation)。**

LLM 的强项是文采与演绎,弱项是记住自己编过的事实。因此全部方案遵守四条铁律:

1. **先定事实,再写叙事**:生成顺序永远是"确定性事实(事实图/谜题解/时间表/账本)→ 可公开叙事投影 → LLM 演绎"。绝不允许 LLM 先生成情节、再回填事实。
2. **引擎即真相**:一切改变世界状态的动作必须经过引擎裁决;LLM 只能提议"发生了什么",引擎负责"是否真的发生"。
3. **真相不进模型上下文**:答案、凶手、谜底等只存引擎;GM 与 NPC 只拿各自的投影/视角。这样即使玩家诱导提问,模型也无从泄露——它本来就没看到。
4. **自由裁决要有兜底**:允许 LLM 自由裁判的场景(跑团奇招、社交反应)必须有 verifier 子代理复核或可回退的规则兜底;复核失败按规则兜底结算。

配套机制:

- **Verifier 子代理**:独立于 GM 的复核代理,负责(1)定期审计 NPC 输出是否越界泄密;(2)终局把玩家的自由文本推理报告分解为断言,逐条对照事实图评分;(3)审核程序化生成的内容可玩性。
- **状态快照强制注入**:每次 GM/NPC 回合前注入,防止叙事与状态漂移。
- **审计日志**:引擎操作与裁决全量落盘,便于复盘与回归测试。

---

## 6. 交互层设计

### 6.1 玩家动作 = 注册工具

玩家动作不靠 GM 自由发挥,而是注册为 DSH 工具(`ctx.tools.register(defineTool(...))`),schema 即动作参数,引擎实现 execute:

| 通用动作 | 参数(示例) | 说明 |
|---|---|---|
| `examine` | `target`(物品/地点/NPC) | 观察,返回描述 + 可用交互 |
| `move` | `to` | 场景切换 |
| `use` | `item`, `on` | 道具使用/组合,引擎裁决 |
| `talk` | `npc`, `text?` | 发起/继续与 NPC 对话(路由到 NPC 子代理) |
| `inspect_inventory` | — | 查看背包 |
| `submit_theory` / `accuse` / `vote` | `text` / `target` | 各方案的终局/关键动作 |

方案专属动作在各自文档中列出。动作的 UI 呈现用 `presentCall`/`presentResult` 卡片(物品卡、线索卡、角色卡),让 Web 界面有"游戏感"。

### 6.2 斜杠命令(不占模型上下文)

| 命令 | 用途 |
|---|---|
| `/game new <方案> [难度]` | 开局 |
| `/game save` / `/game resume` | 手动存档 / 恢复 |
| `/game score` | 查看当前得分 |
| `/game quit` | 结束并结算 |
| `/look` `/bag` `/map` `/hint` | 方案内的快捷观察/背包/地图/提示 |
| `/hint [等级]` | 购买提示(按方案扣分/计费) |

### 6.3 正式抉择点

需要玩家做**正式决定**的场合(指控谁、投票、路线分支、是否冒险)用模型侧 `ask_user_question` 呈现选项 + 允许自定义回答;与自由动作(打字)区分开,保证关键选择可回溯、可计分。

### 6.4 界面体验

- GM 叙事 = 普通助手消息;NPC 对话 = 以"角色卡片 + 引用块"呈现;物品/线索 = 工具结果卡片;结算 = 三栏评分卡(见[§8](#8-计分系统))。
- 终局"真相揭晓"用结构化卡片一次性公布事实图、凶手、关键证据链。

---

## 7. 持久化、断点续玩与事件观察

- **状态即存档**:GameState 落盘即存档;`session/event` 的 `turn/end` 触发自动 checkpoint(状态 + 各 NPC 会话的引用)。DSH 会话本身持久化,因此"关掉网页再回来"天然续玩。
- **事件观察**:插件监听 `session/event` 做四件事:自动存档、回合/计时统计、GM 与 NPC 的越界审计触发、结算触发(达成终局条件)。
- **长线战役**(方案二/七):世界状态跨会话存于 storages;新会话开始时从存档重建内核状态,GM 以"前情提要"开场。

---

## 8. 计分系统

终局结算页三栏:

1. **结论正确性**(确定性,由引擎比对真相计算):指控/答案/目标达成情况,是硬分。
2. **推理质量**(LLM rubric,锚定评分表):对玩家自由文本推理报告,由 verifier 按"关键线索利用率 / 逻辑链完整度 / 冗余猜测惩罚"打分,给出理由。
3. **效率**(确定性):回合数、提示使用数、耗时、循环次数等方案专属指标。

计分 rubric 作为 skill 注入 verifier,保证多次对局评分口径一致。

---

## 9. 通用组件清单(插件骨架)

跨方案复用的服务,即插件开发的第一个里程碑:

| 组件 | 职责 |
|---|---|
| `GameStateStore` | GameState 的 schema 校验、原子读写、快照 |
| `TruthVault` | 真相数据(事实图/谜题解/答案卡)的生成后封存与只读访问 |
| `ActionRegistry` | 通用动作工具(schema + execute)与方案专属动作的注册 |
| `CommandRegistry` | 斜杠命令注册 |
| `Adjudicator` | 引擎操作分发、裁决、审计日志 |
| `Verifier` | 独立复核子代理封装(泄密审计、推理评分、内容审核) |
| `NpcRuntime` | NPC 子代理的创建、对话路由、角色档案注入 |
| `HintService` | 分层提示生成(Socratic hints)与扣分计费 |
| `ScoreService` | 三栏计分与结算卡片 |
| `CheckpointService` | 自动存档、恢复 |
| `ContentGenerators` | 各方案的程序化内容生成 + 可解性验证(求解器) |

---

## 10. 方案索引

| 方案 | 文档 | 一句话 | 单局时长 | 开发复杂度 |
|---|---|---|---|---|
| 一 雾都谜案(侦探推理) | [01-detective.md](01-detective.md) | 程序化生成的本格推理单案,审讯会撒谎的嫌疑人,写下你的推理报告 | 30-60 分钟 | 中 |
| 二 织梦者(单人跑团) | [02-solo-trpg.md](02-solo-trpg.md) | 开放世界沙盒跑团,建卡、骰子、任务、跨会话战役 | 数小时 | 大 |
| 三 暴风雪山庄(剧本杀) | [03-social-deduction.md](03-social-deduction.md) | 与 5 名 AI 角色同处山庄,谁是凶手?也可能就是你 | 60-120 分钟 | 大 |
| 四 第七扇门(密室逃脱) | [04-escape-room.md](04-escape-room.md) | 确定性谜题引擎驱动的密室,LLM 负责把锁讲成故事 | 20-45 分钟 | 小-中 |
| 五 昨日重现(时间循环) | [05-time-loop.md](05-time-loop.md) | 困在重复的一天,用跨循环的知识改变因果 | 60-120 分钟 | 很大 |
| 六 轻量小游戏合集 | [06-mini-games.md](06-mini-games.md) | 海龟汤、卧底、20 问:零门槛快节奏 | 5-15 分钟 | 很小 |
| 七 王国议会(经营模拟) | [07-kingdom-council.md](07-kingdom-council.md) | 各怀议程的 AI 顾问吵成一团,你来做最终决策 | 数小时 | 很大 |

对比矩阵、MVP 推荐与分阶段路线见 [08-comparison-roadmap.md](08-comparison-roadmap.md)。
