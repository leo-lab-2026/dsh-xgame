/**
 * 发布产物打包:把运行时依赖(@deepseek-ai/dsh-tools、dsh-llm 等)打进
 * dist/index.js,使发布包完全自包含。
 *
 * 为什么必须打包:DSH profile 使用 hoisted nodeLinker 且 autoInstallPeers: false;
 * 若插件把 @deepseek-ai/dsh-* 装进 profile 的 node_modules,会遮蔽 harness 自身的
 * 同名模块解析(双实例 → 符号键内部状态失配 → 工具调用崩溃,实测可复现)。
 * 自包含产物不向 profile 引入任何 @deepseek-ai 包,彻底规避。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

await build({
  entryPoints: [path.join(repo, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(repo, 'dist/index.js'),
  sourcemap: false,
  minify: false,
  legalComments: 'eof',
  logLevel: 'info',
})
console.log('dist/index.js bundled')
