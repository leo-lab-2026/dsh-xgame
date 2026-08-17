/**
 * Symlink farm:链接本机 dsh 安装目录中的 @deepseek-ai 类型包到本仓库的
 * node_modules,供 tsc 构建期类型解析;运行时(profile 内以 link: 安装本包)
 * Node 沿 realpath 解析到 dsh 安装树,天然获得全部运行时依赖。
 *
 * 用法:node scripts/link-deps.mjs [dsh安装目录]
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function resolveInstallDir() {
  const arg = process.argv[2]
  if (arg) return arg
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL
  try {
    const bin = execSync('which dsh', { encoding: 'utf8' }).trim()
    const real = execSync(`readlink -f ${bin}`, { encoding: 'utf8' }).trim()
    // <node>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
    // 上溯 4 层到 <node>/lib/node_modules
    return path.dirname(path.dirname(path.dirname(path.dirname(real))))
  } catch {
    // 默认 mise 安装位置
    return path.join(homedir(), '.local/share/mise/installs/node/24.18.1/lib/node_modules')
  }
}

const install = resolveInstallDir()
const src = path.join(install, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
if (!existsSync(src)) {
  console.error(`dsh 安装目录未找到或结构异常:${src}`)
  process.exit(1)
}

const REQUIRED = [
  'cordis',
  'dsh-agent',
  'dsh-commands',
  'dsh-llm',
  'dsh-session',
  'dsh-subagent',
  'dsh-tools',
]

const target = path.join(repo, 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })
for (const name of REQUIRED) {
  const link = path.join(target, name)
  const real = path.join(src, name)
  if (!existsSync(real)) {
    console.error(`缺失:${real}`)
    process.exit(1)
  }
  rmSync(link, { recursive: true, force: true })
  symlinkSync(real, link, 'dir')
  console.log(`link ${name} -> ${real}`)
}
console.log(`done (install: ${install})`)
