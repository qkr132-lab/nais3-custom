/** Explicit maintenance command only; never called on app startup or keystrokes.
 * Downloads pinned public metadata, verifies hashes, extracts only vocabulary.
 * node scripts/fetch-tag-search-data.mjs [output-directory]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
const dir = resolve(process.argv[2] ?? '.superloopy/tag-data')
await mkdir(dir, { recursive: true })
const hash = (b) => createHash('sha256').update(b).digest('hex')
const sources = [
  [
    'snapshot.sqlite',
    'https://huggingface.co/datasets/hlibr/danbooru-tag-metadata-snapshot/resolve/e81b8d2e62fc46dfe70ebbb0223420d6bb94cafe/booru_snapshot.sqlite',
    '62d8075cbeecda7225cb3f4b29551ad4ebc85682d79551e97afdd2066eecbbd9'
  ],
  [
    'wiki.parquet',
    'https://huggingface.co/datasets/lylogummy/danbooru_wikis_2026/resolve/efee213a064e53adc185cb4a0198d1317c1e264f/wiki_pages_260310.parquet',
    'eb4107e68654b7196d431ab5d7cf7ecd333f03a5d9637bd81219728507e0921a'
  ]
]
for (const [name, url, expected] of sources) {
  let buffer
  try {
    buffer = await readFile(resolve(dir, name))
  } catch {
    /* Download absent input. */
  }
  if (!buffer || hash(buffer) !== expected) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
    buffer = Buffer.from(await response.arrayBuffer())
    if (hash(buffer) !== expected)
      throw new Error(`${name}: source hash mismatch; review before updating`)
    await writeFile(resolve(dir, name), buffer)
  }
  console.log(`Verified ${name}`)
}
const required = [
  ['data/all-tags.json', '6fea97620451629897dc9a4f5bb3dca6917bea762c00885e028f033647c420da'],
  ['data/aliases.json', '2358ae9ab70d28a89c8b6713a4946111e13fb98dbe43a6384e546ae5ff079aed']
]
let zip
for (const [name, expected] of required) {
  const dest = resolve(dir, name.replaceAll('/', '_'))
  let buffer
  try {
    buffer = await readFile(dest)
  } catch {
    /* Download absent input. */
  }
  if (!buffer || hash(buffer) !== expected) {
    if (!zip) {
      const response = await fetch(
        'https://github.com/Meiax/danbooru-tag-assassin/releases/download/v1.1.2/Danbooru_Tag_Assassin_v1.1.2.eagleplugin'
      )
      if (!response.ok) throw new Error(`Vocabulary archive: HTTP ${response.status}`)
      zip = await JSZip.loadAsync(await response.arrayBuffer())
    }
    buffer = await zip.file(name).async('nodebuffer')
    if (hash(buffer) !== expected) throw new Error(`${name}: source hash mismatch`)
    await writeFile(dest, buffer)
  }
  console.log(`Verified ${name}`)
}
