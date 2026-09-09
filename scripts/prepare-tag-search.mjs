/** Download the versioned dictionary for clean source checkouts; no runtime downloads. */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript runs before TypeScript build tools are required. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TAG_SEARCH_URL =
  'https://github.com/qkr132-lab/nais3-custom/releases/download/tag-data-2026-09-09/tag-search.sqlite.gz'

async function matchesDatabase(path, manifest) {
  try {
    if ((await stat(path)).size !== manifest.databaseBytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === manifest.databaseSha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** The fetch implementation and paths are injectable for offline integrity tests. */
export async function prepareTagSearch({
  databasePath = resolve(root, 'resources/tag-search.sqlite'),
  manifestPath = resolve(root, 'resources/tag-search-manifest.json'),
  url = TAG_SEARCH_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    !Number.isSafeInteger(manifest.databaseBytes) ||
    manifest.databaseBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.databaseSha256)
  ) {
    throw new Error('Invalid tag search database size or SHA256 in manifest')
  }
  if (await matchesDatabase(databasePath, manifest)) return { downloaded: false }

  await mkdir(dirname(databasePath), { recursive: true })
  const temporaryPath = resolve(
    dirname(databasePath),
    `${basename(databasePath)}.download-${randomUUID()}.tmp`
  )
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error(`Tag search database download failed: HTTP ${response.status}`)
    }
    let bytes = 0
    const hash = createHash('sha256')
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (bytes > manifest.databaseBytes) {
          callback(new Error('Tag search database exceeds the expected size'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body),
      createGunzip(),
      verify,
      createWriteStream(temporaryPath, { flags: 'wx' })
    )
    if (bytes !== manifest.databaseBytes || hash.digest('hex') !== manifest.databaseSha256) {
      throw new Error('Tag search database integrity check failed: size or SHA256 mismatch')
    }
    // Keep any existing file until its verified replacement is fully written and closed.
    await rename(temporaryPath, databasePath)
    return { downloaded: true }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareTagSearch()
    .then(({ downloaded }) =>
      console.log(`Tag search database ${downloaded ? 'downloaded and verified' : 'verified'}`)
    )
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
