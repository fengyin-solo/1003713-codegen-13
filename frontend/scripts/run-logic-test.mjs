// 逻辑测试运行器：用 esbuild 把 TS 测试打成 ESM 后交给 node 执行。
// 纯前端仓库无后端，数据层跑在内存 localStorage 垫片上（见测试文件头部）。
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = resolve(here, '.tmp-logic-test.mjs')

const candidates = [
  resolve(root, 'node_modules/@esbuild/linux-arm64/bin/esbuild'),
  resolve(root, 'node_modules/@esbuild/linux-x64/bin/esbuild'),
  resolve(root, 'node_modules/@esbuild/darwin-arm64/bin/esbuild'),
  resolve(root, 'node_modules/.bin/esbuild'),
]
// node_modules 可能在别的平台安装过，逐个探测，挑当前平台真正可执行的那个。
const esbuild = candidates.find((path) => {
  if (!existsSync(path)) {
    return false
  }
  const probe = spawnSync(path, ['--version'])
  return probe.status === 0
})
if (!esbuild) {
  console.error('找不到可用的 esbuild 二进制，请先 npm install')
  process.exit(2)
}

function run(bin, args) {
  const result = spawnSync(bin, args, { stdio: 'inherit' })
  if (result.error) {
    throw result.error
  }
  return result.status ?? 1
}

try {
  const bundleStatus = run(esbuild, [
    resolve(here, 'maintenance-logic-test.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${out}`,
    '--log-level=warning',
  ])
  if (bundleStatus !== 0) {
    process.exit(bundleStatus)
  }
  process.exit(run(process.execPath, [out]))
} finally {
  rmSync(out, { force: true })
}
