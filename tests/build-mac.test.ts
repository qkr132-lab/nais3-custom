import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  macBuildPlan,
  machoArchitectures,
  stageMacInputs,
  STAGE_INPUTS,
  verifyMacNativeAddons
} from '../scripts/build-mac.mjs'

const arm64 = Buffer.from('cffaedfe0c0000010000000000000000', 'hex')
const x64 = Buffer.from('cffaedfe070000010000000000000000', 'hex')
const require = createRequire(import.meta.url)
const { normalizeOptions } = require('electron-builder/out/builder.js')
const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory.js')
const { Platform } = require('app-builder-lib')
const { Arch } = require('builder-util')

describe('isolated macOS release packaging', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nais-mac-test-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each(['arm64', 'x64'])('installs and rebuilds addons for %s rather than the host', (arch) => {
    const plan = macBuildPlan(join(directory, arch), join(directory, 'dist'), arch)
    expect(plan.install).toContain(`--cpu=${arch}`)
    expect(plan.install).toContain('--os=darwin')
    expect(plan.install).toContain('--include=optional')
    expect(plan.install).toContain('--ignore-scripts')
    expect(plan.build).toContain(`--${arch}`)
    expect(plan.build).toContain('--config.npmRebuild=true')
    expect(plan.build).toContain(`--config.directories.output=${join(directory, 'dist')}`)
    expect(plan.build[0]).toBe(
      join(directory, arch, 'node_modules/electron-builder/out/cli/cli.js')
    )
  })

  it.each(['arm64', 'x64'])('keeps %s isolated despite the config listing both CPUs', (arch) => {
    const plan = macBuildPlan(directory, join(directory, 'dist'), arch)
    const start = plan.build.indexOf('--mac') + 1
    const end = plan.build.findIndex((arg, index) => index >= start && arg.startsWith('--'))
    const normalized = normalizeOptions({ mac: plan.build.slice(start, end), [arch]: true })
    const targets = computeArchToTargetNamesMap(
      normalized.targets.get(Platform.MAC),
      { platformSpecificBuildOptions: { target: [{ target: 'dmg', arch: ['arm64', 'x64'] }] } },
      Platform.MAC
    )
    expect([...targets.entries()]).toEqual([[Arch[arch], ['dmg', 'zip']]])
  })

  it('stages only release inputs, excluding host dependencies and private workspace files', async () => {
    const source = join(directory, 'source')
    const stage = join(directory, 'stage')
    for (const input of STAGE_INPUTS) {
      const path = join(source, input)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, input)
    }
    await writeFile(join(source, '.env'), 'private')
    await mkdir(join(source, 'node_modules'))
    await mkdir(join(source, '.superloopy'))
    await writeFile(join(source, 'resources/tag-search.sqlite.gz'), 'download source only')
    await stageMacInputs(source, stage)
    expect(await readFile(join(stage, 'resources/tag-search.sqlite'), 'utf8')).toBe(
      'resources/tag-search.sqlite'
    )
    for (const excluded of ['.env', 'node_modules', '.superloopy']) {
      expect(await readdir(stage)).not.toContain(excluded)
    }
    expect(await readdir(join(stage, 'resources'))).not.toContain('tag-search.sqlite.gz')
  })

  it('decodes real thin Mach-O header byte orders and rejects unrelated data', () => {
    expect(machoArchitectures(arm64)).toEqual(['arm64'])
    expect(machoArchitectures(x64)).toEqual(['x64'])
    expect(machoArchitectures(Buffer.from('MZ executable'))).toEqual([])
    expect(machoArchitectures(Buffer.alloc(2))).toEqual([])
  })

  it('accepts universal Mach-O containing both CPU architectures', () => {
    const fat = Buffer.from(
      'cafebabe00000002' +
        '010000070000000300001000000010000000000c' +
        '0100000c0000000000002000000010000000000c',
      'hex'
    )
    expect(machoArchitectures(fat)).toEqual(['x64', 'arm64'])
  })

  async function addons(sqlite: Buffer, sharp: Buffer, sharpArch = 'x64'): Promise<void> {
    await writeFile(join(directory, 'better_sqlite3.node'), sqlite)
    await writeFile(join(directory, `sharp-darwin-${sharpArch}-0.35.3.node`), sharp)
  }

  it('rejects the observed Intel release defect even when filenames look correct', async () => {
    await addons(arm64, x64)
    await expect(verifyMacNativeAddons(directory, 'x64')).rejects.toThrow(/Wrong CPU.*expected x64/)
  })

  it('rejects an Intel package containing only the ARM64 sharp dependency', async () => {
    await addons(x64, arm64, 'arm64')
    await expect(verifyMacNativeAddons(directory, 'x64')).rejects.toThrow(/Missing x64.*sharp/)
  })

  it.each([
    ['arm64', arm64],
    ['x64', x64]
  ])('accepts matching SQLite and sharp modules for %s', async (arch, header) => {
    await addons(header as Buffer, header as Buffer, arch as string)
    await expect(verifyMacNativeAddons(directory, arch)).resolves.toBeUndefined()
  })
})
