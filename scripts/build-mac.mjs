/** Package each macOS CPU from isolated dependencies, then inspect its native addons. */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- This build entrypoint is executable plain JavaScript. */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stagePrefix = 'nais3-mac-build-'
export const STAGE_INPUTS = Object.freeze([
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'LICENSE',
  'NOTICE-tag-search.md',
  'NOTICE-tag-wiki.md',
  'out',
  'build',
  'resources/icon.png',
  'resources/t5_tokenizer.json',
  'resources/tags.json',
  'resources/tags-ko.json',
  'resources/tag-wiki.json',
  'resources/tag-search-manifest.json',
  'resources/tag-search.sqlite'
])

export function macBuildPlan(stageDir, outputDir, arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`)
  return {
    install: [
      'ci',
      '--ignore-scripts',
      `--cpu=${arch}`,
      '--os=darwin',
      '--include=optional',
      '--include=dev',
      '--no-audit',
      '--no-fund'
    ],
    build: [
      join(stageDir, 'node_modules/electron-builder/out/cli/cli.js'),
      '--mac',
      'dmg',
      'zip',
      `--${arch}`,
      '--publish',
      'never',
      '--config.npmRebuild=true',
      `--config.directories.output=${outputDir}`
    ],
    appDirectory: join(outputDir, arch === 'arm64' ? 'mac-arm64' : 'mac')
  }
}

export async function stageMacInputs(projectDir, stageDir) {
  for (const input of STAGE_INPUTS) {
    const destination = join(stageDir, input)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(projectDir, input), destination, { recursive: true, dereference: true })
  }
}

/** Decode thin and universal Mach-O headers without executing foreign CPU binaries. */
export function machoArchitectures(header) {
  const names = new Map([
    [0x01000007, 'x64'],
    [0x0100000c, 'arm64']
  ])
  if (header.length < 8) return []
  const little = header.readUInt32LE(0)
  if (little === 0xfeedfacf || little === 0xfeedface) {
    return [names.get(header.readUInt32LE(4))].filter(Boolean)
  }
  const magic = header.readUInt32BE(0)
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return []
  const stride = magic === 0xcafebabf ? 32 : 20
  const count = header.readUInt32BE(4)
  if (count > 32 || header.length < 8 + count * stride) return []
  return Array.from({ length: count }, (_, index) =>
    names.get(header.readUInt32BE(8 + index * stride))
  ).filter(Boolean)
}

async function nodeAddons(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await nodeAddons(path)))
    else if (entry.isFile() && entry.name.endsWith('.node')) files.push(path)
  }
  return files
}

export async function verifyMacNativeAddons(unpackedDirectory, arch) {
  const files = await nodeAddons(unpackedDirectory)
  const sqlite = files.find((path) => basename(path) === 'better_sqlite3.node')
  const sharp = files.find((path) => basename(path).startsWith(`sharp-darwin-${arch}`))
  if (!sqlite || !sharp) throw new Error(`Missing ${arch} SQLite or sharp native addon`)
  for (const path of [sqlite, sharp]) {
    const file = await open(path, 'r')
    let architectures
    try {
      const header = Buffer.alloc(2048)
      const { bytesRead } = await file.read(header, 0, header.length, 0)
      architectures = machoArchitectures(header.subarray(0, bytesRead))
    } finally {
      await file.close()
    }
    if (!architectures.includes(arch)) {
      throw new Error(`Wrong CPU for ${path}: expected ${arch}, found ${architectures.join(', ')}`)
    }
  }
}

async function run(command, args, cwd, arch) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_arch: arch,
        npm_config_target_arch: arch,
        npm_config_cpu: arch,
        npm_config_os: 'darwin'
      }
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`${command} failed: ${signal || code}`))
    })
  })
}

async function removeOwnedStage(stageDir, temporaryRoot) {
  const ownedDirectory = await realpath(stageDir)
  if (
    dirname(ownedDirectory) !== temporaryRoot ||
    !basename(ownedDirectory).startsWith(stagePrefix)
  ) {
    throw new Error('Refusing to clean a directory outside the owned macOS build stage')
  }
  await rm(ownedDirectory, { recursive: true, force: true })
}

export async function buildMac({ projectDir = root } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS packaging must run on a macOS host')
  const temporaryRoot = await realpath(tmpdir())
  const outputDir = resolve(projectDir, 'dist')
  for (const arch of ['arm64', 'x64']) {
    const stageDir = await mkdtemp(join(temporaryRoot, stagePrefix))
    try {
      console.log(`Preparing isolated ${arch} macOS dependencies`)
      await stageMacInputs(projectDir, stageDir)
      const plan = macBuildPlan(stageDir, outputDir, arch)
      await run('npm', plan.install, stageDir, arch)
      await run(process.execPath, plan.build, stageDir, arch)
      const apps = (await readdir(plan.appDirectory)).filter((name) => name.endsWith('.app'))
      if (apps.length !== 1) throw new Error(`Expected one packaged app in ${plan.appDirectory}`)
      await verifyMacNativeAddons(
        join(plan.appDirectory, apps[0], 'Contents/Resources/app.asar.unpacked'),
        arch
      )
      console.log(`Verified ${arch} SQLite and sharp native addons`)
    } finally {
      await removeOwnedStage(stageDir, temporaryRoot)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--publish' || args[1] !== 'never')) {
    console.error('Usage: node scripts/build-mac.mjs [--publish never]')
    process.exitCode = 1
  } else {
    buildMac().catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}
