import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import {
  createScene,
  createPreset,
  getScene,
  listScenes,
  setSceneCensors,
  duplicateScene,
  duplicatePreset,
  bulkCopyScenes,
  bulkMove,
  deleteScene,
  restoreScenes,
  exportScenesJson,
  importScenesJson,
  updateScene
} from '../src/main/scenes/repo'

async function main(): Promise<void> {
  const db = new Database(':memory:')
  Object.assign(globalThis, { censorTestDb: db })
  for (const migration of migrations.slice(0, -1)) db.transaction(() => migration(db))()
  const old = createScene(1, 'legacy')
  db.transaction(() => migrations.at(-1)!(db))()
  reconcileSchema(db)
  reconcileSchema(db)
  assert.deepEqual(getScene(old)?.censorKinds, [])
  assert.equal(getScene(old)?.suppressAnal, false)
  const ids = Array.from({ length: 30 }, (_, i) => createScene(1, `scene-${i}`))
  setSceneCensors(ids.slice(0, 15), { penis: true, testicles: true })
  assert.equal(listScenes(1).filter((s) => s.censorKinds?.length).length, 15)
  setSceneCensors([ids[0], ids[15]], { vulva: true })
  assert.deepEqual(getScene(ids[0])?.censorKinds, ['penis', 'vulva', 'testicles'])
  assert.deepEqual(getScene(ids[15])?.censorKinds, ['vulva'])
  assert.throws(() => setSceneCensors([ids[0], -999], { anal: true }))
  assert.equal(getScene(ids[0])?.censorKinds?.includes('anal'), false)
  setSceneCensors([ids[0]], { weights: { penis: 1.2, suppress: 0.4 } })
  setSceneCensors([ids[0]], { suppressAnal: true })
  setSceneCensors([ids[15]], { weights: { penis: 2.1 } })
  setSceneCensors([ids[0], ids[15]], { weights: { anal: 0.7 } })
  assert.equal(getScene(ids[0])?.censorWeights?.penis, 1.2)
  assert.equal(getScene(ids[15])?.censorWeights?.penis, 2.1)
  assert.equal(getScene(ids[0])?.suppressAnal, true)
  assert.equal(getScene(ids[15])?.suppressAnal, false)
  assert.throws(() => setSceneCensors([ids[0], -999], { suppressAnal: false }))
  assert.equal(getScene(ids[0])?.suppressAnal, true)
  assert.throws(() => setSceneCensors([ids[0], -999], { weights: { penis: 4 } }))
  assert.equal(getScene(ids[0])?.censorWeights?.penis, 1.2)
  const duplicate = getScene(duplicateScene(ids[0]))
  assert.equal(duplicate?.censorWeights?.suppress, 0.4)
  assert.equal(duplicate?.suppressAnal, true)
  assert.deepEqual(getScene(duplicateScene(ids[0]))?.censorKinds, ['penis', 'vulva', 'testicles'])
  const copyPreset = duplicatePreset(1)
  assert.equal(listScenes(copyPreset).filter((s) => s.censorKinds?.length).length, 18)
  assert.equal(listScenes(copyPreset).find((s) => s.name === 'scene-0')?.censorWeights?.penis, 1.2)
  assert.equal(listScenes(copyPreset).find((s) => s.name === 'scene-0')?.suppressAnal, true)
  const dest = createPreset('destination')
  const copied = bulkCopyScenes([ids[0]], dest)
  assert.deepEqual(getScene(copied[0])?.censorKinds, ['penis', 'vulva', 'testicles'])
  assert.equal(getScene(copied[0])?.censorWeights?.penis, 1.2)
  assert.equal(getScene(copied[0])?.suppressAnal, true)
  bulkMove([ids[0]], dest)
  deleteScene(ids[0])
  restoreScenes([ids[0]])
  assert.deepEqual(getScene(ids[0])?.censorKinds, ['penis', 'vulva', 'testicles'])
  assert.equal(getScene(ids[0])?.suppressAnal, true)
  const exportPath = join(mkdtempSync(join(tmpdir(), 'nais-censor-test-')), 'scenes.json')
  Object.assign(globalThis, { censorTestExportPath: exportPath })
  assert.equal(await exportScenesJson(dest), true)
  assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).scenes[0].suppressAnal, true)
  assert.deepEqual(JSON.parse(readFileSync(exportPath, 'utf8')).scenes[0].censorKinds, [
    'penis',
    'vulva',
    'testicles'
  ])
  const imported = createPreset('imported')
  await importScenesJson(imported)
  assert.ok(listScenes(imported).every((s) => s.suppressAnal === true))
  assert.ok(
    listScenes(imported).every(
      (s) => s.censorWeights?.penis === 1.2 && s.censorWeights?.suppress === 0.4
    )
  )
  assert.deepEqual(
    listScenes(imported).map((s) => s.censorKinds),
    [
      ['penis', 'vulva', 'testicles'],
      ['penis', 'vulva', 'testicles']
    ]
  )
  const legacyImport = createPreset('legacy import')
  writeFileSync(
    exportPath,
    JSON.stringify({
      scenes: [
        { name: 'missing flag', negativePrompt: 'blur, anal' },
        { name: 'malformed flag', suppressAnal: 'false' }
      ]
    })
  )
  await importScenesJson(legacyImport)
  assert.ok(listScenes(legacyImport).every((s) => s.suppressAnal === false))
  assert.equal(listScenes(legacyImport)[0].negativePrompt, 'blur, anal')
  // Persisted storage is re-read independently of the renderer; all writes are isolated in memory.
  setSceneCensors(ids.slice(1, 15), { penis: false, testicles: false })
  assert.deepEqual(getScene(ids[1])?.censorKinds, [])
  setSceneCensors([ids[0]], { suppressAnal: false })
  assert.equal(getScene(ids[0])?.suppressAnal, false)
  assert.deepEqual(getScene(ids[0])?.censorKinds, ['penis', 'vulva', 'testicles'])
  updateScene(ids[0], { suppressAnal: true })
  assert.equal(getScene(ids[0])?.suppressAnal, true)
  updateScene(ids[0], { suppressAnal: 'false' })
  assert.equal(getScene(ids[0])?.suppressAnal, false)
  db.close()
  console.log(
    'PASS: migration, schema reconciliation, batch 15/30, mixed settings, rollback, duplicate, copy, move, restore, JSON round trip, independent suppression, legacy import'
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
