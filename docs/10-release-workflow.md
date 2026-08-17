# 发布与推送流程手册(GitHub + npm Trusted Publisher)

> 本文档固化 dsh-xgame 的日常推送与发版发布流程,供维护者长期执行。
> 当前生效配置:npmjs **GitHub Trusted Publisher**(仓库 `leo-lab-2026/dsh-xgame`,workflow 文件 `publish.yml`,允许 `npm publish` 与 `npm stage publish`);CI 为 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),采用 **npm 暂存发布(staged publishing)**。

---

## 1. 流程总览

发布链路分两段,中间以"人在场(2FA)"为界:

```
① 自动化(CI,无需人工、无需 npm token)
   修改 → npm test 通过 → git commit → git push --tags(v*)
        ↓
   GitHub Actions 自动执行:
   构建 → 打包 → 冒烟测试 → 版本-标签一致性校验
        ↓
   npm stage publish --provenance(OIDC 认证)
   —— 版本进入"暂存"状态:占住版本号,但对公众不可见 ——
        ↓
② 人在场(维护者,每次发布一次 2FA)
   npm stage list                 # 查看暂存版本
   npm stage approve <stage-id>   # 批准 → 版本正式上线(需 2FA)
```

---

## 2. 日常推送(不发版)

日常开发只推 `main`,**不推标签就不会触发任何发布**:

```sh
npm test                      # 先跑冒烟测试(约 40 组断言)
git add -A
git commit -m "fix(...): 说明"
git push origin main
```

---

## 3. 标准发版流程(推荐)

### 3.1 升版本并推送标签

```sh
npm version patch            # 0.1.2 → 0.1.3;自动改 package.json、commit、打 tag
# 或 npm version minor / npm version major(遵循 semver)
git push origin main
git push origin v0.1.3       # 标签名必须为 v<版本号>,触发 CI
```

版本与标签必须一致:CI 有校验步骤,`v0.1.3` 但 package.json 是 `0.1.4` 会直接失败。
预发布版本(如 `1.0.0-beta.1`)必须显式指定 tag,暂存流程同样受此约束。

### 3.2 CI 自动暂存

推送标签后,GitHub Actions(仓库 → Actions → Publish Package to npmjs)自动:

1. `npm ci`(registry devDependencies,不依赖本机 dsh)
2. `npm run build`(tsc 编译 + 类型声明)
3. `npm run bundle`(esbuild 打包自包含产物 `dist/index.js`)
4. `npm test`(冒烟测试)
5. 版本-标签一致性校验
6. `npm stage publish --provenance --access public`(OIDC 认证,零 token)

用 `gh run watch` 或 Actions 页面确认 run 为绿色。

### 3.3 批准上架(唯一人工环节,需 2FA)

```sh
npm stage list                      # 列出暂存版本,记下 id(UUID)
npm stage approve <stage-id>        # 批准发布,按提示完成 2FA(浏览器确认或 OTP)
```

- 注意:`approve` 的参数是 **stage-id(UUID)**,不是版本号。
- 批准后版本立即对公众可见,`latest` 指向它。
- 不想要的版本:`npm stage reject <stage-id>`(同样需要 2FA,删除后该版本号可重新暂存)。

---

## 4. 手动触发工作流(备选)

GitHub Actions → Publish Package to npmjs → **Run workflow**,选择分支与模式:

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `stage` | 构建+测试+暂存发布(默认) | 不推标签也走一遍发布预演 |
| `publish` | 构建+测试+**直接 npm publish** | 理论上可行,但账号开 2FA 时在 CI 中会因无法交互而失败,一般不用 |
| `check` | 仅构建+打包+测试,不发布 | 验证 CI 健康、PR 前检查 |

> 实用提示:推送 `main` 前可先跑一次 `check` 模式确认云端构建通过。

---

## 5. 各环节 2FA 要求(常见疑问)

npm 暂存发布的官方规则([npm-stage 文档](https://docs.npmjs.com/cli/v11/commands/npm-stage)):

| 命令 | 需要 2FA | 说明 |
|---|---|---|
| `npm stage publish`(CI 暂存) | **否** | 为自动化流程设计,2FA 推迟到批准环节 |
| `npm stage list` / `view` / `download` | 否 | 只读操作 |
| `npm stage approve` | **是** | 批准上架,每次都要 |
| `npm stage reject` | 是 | 永久删除暂存版本 |
| `npm publish`(直接发布) | **是**(账号开 2FA 时) | 这就是为什么 CI 走暂存而非直发 |

**结论:是的,每一个版本上架都需要你确认一次 2FA。** 这不是配置问题,而是 npm 供应链安全策略的刻意设计("proof-of-presence"):暂存可以由机器自动完成,但"某个版本对公众可见"这个动作必须有人在场。没有"批准一次管所有后续版本"的机制,也不建议用 GAT bypass 2FA 的 token 绕过(官方明确建议删除这类 token,改用信任关系)。

如果你希望减少打断感,现实的做法是:攒一批改动后发一个 patch/minor,一次 2FA 确认一个版本。

---

## 6. 失败与异常处理

| 现象 | 原因 | 处理 |
|---|---|---|
| CI 在"校验版本与标签一致"失败 | 标签与 package.json 版本不一致 | 对齐后重新打标签(`git tag -d` 删除错误标签,`npm version` 重新生成) |
| CI 构建/测试失败 | 代码问题 | 看 Actions 日志;本地 `npm run build && npm test` 复现修复后重推标签 |
| `approve` 报 "stage-id must be a valid UUID" | 传了版本号 | 用 `npm stage list` 里的 `id`(UUID) |
| 版本已存在/被暂存占用 | 相同版本号重复 | 换版本号;或 `npm stage reject` 旧暂存后重来 |
| 刚发布的版本 `dsh plugin add dsh-xgame` 装到旧版 | pnpm 对新版本有最低冷却期(minimumReleaseAge) | 显式安装:`dsh plugin --profile <p> add dsh-xgame@<版本>`;或等冷却结束 |
| 暂存后想改内容 | 暂存 tag 不可变 | `npm stage reject` 后重新暂存同一版本号 |
| 推送标签没触发工作流 | 标签名不是 `v*` | 确认标签格式 `v0.x.y` |

---

## 7. 安全注意

- CI 全程零 token:OIDC(`id-token: write`)+ Trusted Publisher,凭据不落仓库。
- 信任关系已限定 `npm publish` / `npm stage publish` 两个动作,短期令牌不能执行其他 `npm stage` 子命令。
- 不要在仓库里放任何 npm token;本地 `.npmrc` 的登录态只用于 `approve`(人在场环节)。
- 每次发版建议先在 `check` 模式或标签 CI 里看测试全绿,再执行 approve。

---

## 8. 相关文档

- [`../.github/workflows/publish.yml`](../.github/workflows/publish.yml):发布工作流本体
- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers) / [npm-stage](https://docs.npmjs.com/cli/v11/commands/npm-stage):官方文档
- [仓库 README](../README.md)「发布」一节:流程速览
