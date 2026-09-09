const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const result = spawnSync(
  resolve('node_modules/electron/dist/electron.exe'),
  [resolve('tests/tag-worker-check.cjs')],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60000
  }
)
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) console.error(result.error)
process.exitCode = result.status ?? 1
