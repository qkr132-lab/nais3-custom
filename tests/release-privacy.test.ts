import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { auditPackage, allowedFile, credentialFindings } = require('../scripts/audit-release.cjs')
const asar = require('@electron/asar')

describe('release privacy gate', () => {
  it.each([
    'nais3.db',
    '.env',
    'resources/nais3.db',
    'resources/tag_usage.json',
    'scripts/gen-cover.mjs',
    'out/renderer/settings.json',
    'node_modules/example/.env'
  ])('blocks unexpected or private file %s', (file) => {
    expect(allowedFile(file)).toBe(false)
  })
  it('allows runtime code, public dictionaries and required dependency files', () => {
    for (const file of [
      'out/main/index.js',
      'out/renderer/assets/index-abcd.js',
      'resources/tag-search.sqlite',
      'node_modules/sharp/lib/index.js',
      'LICENSE'
    ])
      expect(allowedFile(file)).toBe(true)
  })
  it('detects embedded credentials without returning their values', () => {
    const fakeToken = 'sk-' + 'x'.repeat(40)
    const result = credentialFindings(`const token = '${fakeToken}'`)
    expect(result).toContain('apiToken')
    expect(JSON.stringify(result)).not.toContain(fakeToken)
  })
  it('inspects the actual ASAR and rejects a credential in otherwise permitted code', async () => {
    const prefix = join(tmpdir(), 'nais-release-audit-test-')
    const root = await mkdtemp(prefix)
    try {
      const source = join(root, 'source')
      await mkdir(join(source, 'out', 'main'), { recursive: true })
      const fakeToken = 'ghp_' + 'x'.repeat(40)
      await writeFile(join(source, 'out', 'main', 'index.js'), `const token = '${fakeToken}'`)
      const archive = join(root, 'app.asar')
      await asar.createPackage(source, archive)
      let message = ''
      try {
        auditPackage(archive)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('githubToken')
      expect(message).not.toContain(fakeToken)
    } finally {
      if (!resolve(root).startsWith(resolve(prefix))) throw new Error('Unexpected test directory')
      await rm(root, { recursive: true, force: true })
    }
  })
})
