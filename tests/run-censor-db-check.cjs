const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const out = path.resolve('.superloopy/evidence/frontend/censor/censor-db-check.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
// Rebuild with narrowly scoped adapters for app-only I/O. SQLite/repo/migrations remain real.
esbuild
  .build({
    entryPoints: ['tests/censor-db-check.ts'],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    plugins: [
      {
        name: 'isolated-app-adapters',
        setup(build) {
          build.onResolve(
            {
              filter: /^(electron|\.\.\/db|\.\.\/db\/settings|\.\.\/images\/storage|\.\.\/trash)$/
            },
            (args) => {
              if (
                args.path === 'electron' ||
                args.importer.endsWith(path.join('scenes', 'repo.ts'))
              )
                return { path: args.path, namespace: 'fixture' }
            }
          )
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents: {
              electron: `export const BrowserWindow = { getFocusedWindow: () => ({}), getAllWindows: () => [{}] }; export const shell = {}; export const dialog = { showSaveDialog: async () => ({filePath:globalThis.censorTestExportPath}), showOpenDialog: async () => ({filePaths:[globalThis.censorTestExportPath]}) };`,
              '../db': 'export const getDb = () => globalThis.censorTestDb;',
              '../db/settings': 'export const getSetting = () => null;',
              '../images/storage': "export const libraryRoot = () => '';",
              '../trash': 'export const trashFile = async () => {};'
            }[args.path]
          }))
        }
      }
    ]
  })
  .then(() => {
    const result = spawnSync(path.resolve('node_modules/electron/dist/electron.exe'), [out], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true
    })
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    process.exitCode = result.status ?? 1
  })
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
