# 发布与推送流程手册(GitHub + npm Trusted Publisher)

> 本文档固化 dsh-xgame 的日常推送与发版发布流程,供维护者长期执行。
> 当前生效配置:npmjs **GitHub Trusted Publisher**(仓库 `leo-lab-2026/dsh-xgame`,workflow 文件 `publish.yml`,允许 `npm publish`);CI 为 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),采用 **OIDC 直接发布(full OIDC trusted publishing)**。

---

## 1. 流程总览

发布为**单段自动化链路,无人工环节、无 npm token**:

```
修改 → npm test 通过 → git commit → npm version → git push --tags(v*)
        ↓
   GitHub Actions 自动执行(零 token、无需人在场):
    构建 → 打包 → 冒烟测试 → 版本-标签一致性校验
        ↓
   npm publish --provenance --access public(OIDC 认证)
   —— 版本直接对公众可见,latest 指向它 ——
```

对比 dsh-lark-bridge 的落地方式:`dsh-xgame` 早期采用 **npm staged publishing**(`npm stage publish` + 人工 `npm stage approve` 2FA),后改为与 lark-bridge 一致的 **OIDC 全自动直接发布**。直接 `npm publish` 走 OIDC 信任交换,**不需要**交互式 2FA;账号 2FA 只约束 token 登录/敏感操作,不影响 OIDC 发布。

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

## 3. 标准发版流程(全自动)

### 3.1 升版本并推送标签

```sh
npm version patch            # 0.1.2 → 0.1.3;自动改 package.json、commit、打 tag
# 或 npm version minor / npm version major(遵循 semver)
git push origin main
git push origin v0.1.3       # 标签名必须为 v<版本号>,触发 CI
```

版本与标签必须一致:CI 有校验步骤,`v0.1.3` 但 package.json 是 `0.1.4` 会直接失败。
预发布版本(如 `1.0.0-beta.1`)必须显式指定 tag,发布走 `npm publish`,dist-tag 由版本号决定(见下注)。

### 3.2 CI 自动发布(无人工环节)

推送标签后,GitHub Actions(仓库 → Actions → Publish Package to npmjs)自动:

1. `npm ci`(registry devDependencies,不依赖本机 dsh)
2. `npm run build`(tsc 编译 + 类型声明)
3. `npm run bundle`(esbuild 打包自包含产物 `dist/index.js`)
4. `npm test`(冒烟测试)
5. 版本-标签一致性校验
6. `npm publish --provenance --access public`(**OIDC 直接认证,零 token、零人工**;`--provenance` 附 SLSA 构建溯源)

run 变绿即发布完成,`latest` 指向新版本。**没有第二步。** 若账号对 `latest` 有保护或想打预发布 tag,可在 push 标签前用 `npm publish --tag next` 等方式预先调整(否则稳定版 tag 直接进 `latest`)。

> 预发布策略约定:beta/rc 版本希望进 `next` 而非 `latest` 时,当前 CI 直接 `npm publish` 会用默认 `latest`。若需要维护 `latest` 只指向稳定版,请参照 dsh-lark-bridge 的做法,在发布步骤按 `$GITHUB_REF_NAME` 是否含 `-beta.*/ -rc.*/ -pre.*/ -dev.*` 追加 `--tag next`(见文末"可选增强")。

---

## 4. 手动触发工作流(备选)

GitHub Actions → Publish Package to npmjs → **Run workflow**,选择分支与模式:

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `publish` | 构建+测试+**直接 npm publish**(OIDC 全自动) | 不推标签也想发布某个分支的当前版本 |
| `check` | 仅构建+打包+测试,不发布 | 验证 CI 健康、PR 前检查 |

> 实用提示:推送 `main` 前可先跑一次 `check` 模式确认云端构建通过。

---

## 5. OIDC 直接发布的硬性要求(踩过的坑)

| 要求 | 原因 |
|---|---|
| **Node 24**(自带 npm ≥ 11.5.1) | npm OIDC 信任交换需要 npm ≥ 11.5.1;Node 22 自带 npm 10 会退回 token 认证并 404 |
| `actions/setup-node` **不配 `registry-url`** | 无真实 `NODE_AUTH_TOKEN` 时 setup-node 会写入占位 `_authToken`,令 npm 改走 token 认证,OIDC 失效、发布 404 |
| Trusted Publisher 允许 `publish` 动作 | npmjs 信任关系必须放开 `npm publish`;当前配置已允许 |

> 这是 dsh-lark-bridge 实测总结的经验(见其发布手册)。任何一项不满足都会导致发布失败而非"回退到人工",因此 CI 变更后建议先 `check` 模式验证。

---

## 6. 失败与异常处理

| 现象 | 原因 | 处理 |
|---|---|---|
| CI 在"校验版本与标签一致"失败 | 标签与 package.json 版本不一致 | 对齐后重新打标签(`git tag -d` 删除错误标签,`npm version` 重新生成) |
| CI 构建/测试失败 | 代码问题 | 看 Actions 日志;本地 `npm run build && npm test` 复现修复后重推标签 |
| 发布 404 / 认证失败 | setup-node 配了 `registry-url`,或 Node < 24 | 去掉 `registry-url` 并确保 Node 24 后再触发 |
| 版本已存在 | 相同版本号重复 | `npm version patch` 换版本号重发 |
| 刚发布的版本 `dsh plugin add dsh-xgame` 装到旧版 | pnpm 对新版本有最低冷却期(minimumReleaseAge) | 显式安装:`dsh plugin --profile <p> add dsh-xgame@<版本>`;或等冷却结束 |
| 推送标签没触发工作流 | 标签名不是 `v*` | 确认标签格式 `v0.x.y` |

---

## 7. 安全注意

- CI 全程零 token:OIDC(`id-token: write`)+ Trusted Publisher,凭据不落仓库。
- 信任关系已限定 `npm publish`,短期令牌不能执行其他操作。
- 不要在仓库里放任何 npm token;本地 `.npmrc` 的登录态只用于账号管理/`npm deprecate` 等,不参与发布。
- 每次发版建议先在 `check` 模式或标签 CI 里看测试全绿;`latest` 默认直发会覆盖,需谨慎。

---

## 8. 相关文档

- [`../.github/workflows/publish.yml`](../.github/workflows/publish.yml):发布工作流本体
- [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers):官方文档
- [仓库 README](../README.md)「发布」一节:流程速览
- dsh-lark-bridge 发布手册(同款 OIDC 全自动方案,含最佳实践):`../dsh-lark-bridge/docs/10-publish-checklist.md`

## 附:dist-tag 策略(已内置于 publish.yml)

`latest` 永远只指向稳定版,预发布进 `next`:发布步骤已按 `$GITHUB_REF_NAME` 判断,凡含 `-beta.*`/`-rc.*`/`-pre.*`/`-dev.*` 的标签自动追加 `--tag next`,其余走默认 `latest`。

```yaml
      - name: 直接发布(npm publish,OIDC 全自动,无人工环节)
        if: github.event_name == 'push' || inputs.mode == 'publish'
        run: |
          # dist-tag 策略:预发布(beta/rc/pre/dev)进 `next`;`latest` 只收稳定版。
          case "$GITHUB_REF_NAME" in
            *-beta.*|*-rc.*|*-pre.*|*-dev.*) tag="--tag next" ;;
            *) tag="" ;;
          esac
          npm publish --provenance --access public $tag
```
