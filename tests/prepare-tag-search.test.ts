import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { prepareTagSearch, TAG_SEARCH_URL } from '../scripts/prepare-tag-search.mjs'

describe('prepare offline tag dictionary', () => {
  let directory: string
  let databasePath: string
  let manifestPath: string
  const expected = Buffer.from('verified offline dictionary fixture')

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nais-tag-prepare-'))
    databasePath = join(directory, 'tag-search.sqlite')
    manifestPath = join(directory, 'tag-search-manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        databaseBytes: expected.length,
        databaseSha256: createHash('sha256').update(expected).digest('hex')
      })
    )
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const download = (data: Buffer): Mock<(url: string, options: RequestInit) => Promise<Response>> =>
    vi.fn(async () => new Response(gzipSync(data)))

  it('downloads and verifies a fresh checkout dictionary', async () => {
    const fetchImpl = download(expected)
    expect(await prepareTagSearch({ databasePath, manifestPath, fetchImpl })).toEqual({
      downloaded: true
    })
    expect(fetchImpl.mock.calls[0][0]).toBe(TAG_SEARCH_URL)
    expect(await readFile(databasePath)).toEqual(expected)
    expect((await readdir(directory)).sort()).toEqual([
      'tag-search-manifest.json',
      'tag-search.sqlite'
    ])
  })

  it('keeps the verified local database without accessing the network', async () => {
    await writeFile(databasePath, expected)
    const fetchImpl = vi.fn(() => {
      throw new Error('A verified local dictionary must not access the network')
    })
    expect(await prepareTagSearch({ databasePath, manifestPath, fetchImpl })).toEqual({
      downloaded: false
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('repairs a corrupt database even when its byte count matches', async () => {
    await writeFile(databasePath, Buffer.alloc(expected.length))
    const fetchImpl = download(expected)
    expect(await prepareTagSearch({ databasePath, manifestPath, fetchImpl })).toEqual({
      downloaded: true
    })
    expect(await readFile(databasePath)).toEqual(expected)
  })

  it.each([
    ['wrong SHA256', Buffer.alloc(expected.length)],
    ['too short', expected.subarray(0, -1)],
    ['too long', Buffer.concat([expected, Buffer.from('extra')])]
  ])(
    'rejects %s while preserving the old file and removing temporary files',
    async (_, invalid) => {
      const original = Buffer.from('old dictionary kept until verified replacement')
      await writeFile(databasePath, original)
      await expect(
        prepareTagSearch({ databasePath, manifestPath, fetchImpl: download(invalid as Buffer) })
      ).rejects.toThrow(/integrity|expected size/)
      expect(await readFile(databasePath)).toEqual(original)
      expect((await readdir(directory)).sort()).toEqual([
        'tag-search-manifest.json',
        'tag-search.sqlite'
      ])
    }
  )

  it('cleans up a truncated gzip without creating a database', async () => {
    const truncated = gzipSync(expected).subarray(0, -8)
    await expect(
      prepareTagSearch({
        databasePath,
        manifestPath,
        fetchImpl: async () => new Response(truncated)
      })
    ).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['tag-search-manifest.json'])
  })
})
