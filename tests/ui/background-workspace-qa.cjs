const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const out = '.superloopy/evidence/frontend/background-workspace'
  fs.mkdirSync(out, { recursive: true })
  try {
    await page.goto('http://127.0.0.1:5189/censor.html?workspace')
    await page.locator('[data-scene-id="30"]').waitFor()
    await page.getByRole('button', { name: '배경 태그', exact: true }).click()
    await page.getByRole('button', { name: '배경 추가', exact: true }).waitFor()
    assert.equal(await page.locator('[data-scene-id]').count(), 0)
    await page.getByRole('button', { name: '배경 추가', exact: true }).click()
    await page.locator('[data-scene-id="31"]').click()
    await page.getByPlaceholder('배경 프롬프트', { exact: true }).fill('forest, sunlight')
    await page.getByRole('checkbox', { name: '공통 프롬프트의 기존 단색 배경 태그 제외' }).check()
    await page.getByRole('button', { name: '생성', exact: true }).click()
    await page.waitForFunction(() => window.censorFixture.queued().length === 1)
    assert.equal(await page.evaluate(() => window.censorFixture.queued()[0].sceneId), 31)
    assert.match(
      await page.evaluate(() => window.censorFixture.queued()[0].prompt),
      /forest, sunlight/
    )
    await page.evaluate(() => window.censorFixture.complete(31))
    assert.equal(await page.evaluate(() => window.censorFixture.state().imagesTotal), 1)
    await page.evaluate(() => window.censorFixture.state().toggleFavorite(1))
    await page.getByTitle('즐겨찾기만 보기', { exact: true }).click()
    assert.equal(await page.evaluate(() => window.censorFixture.state().images[0].favorite), true)
    await page.getByRole('button', { name: '배경 목록', exact: true }).click()
    await page.getByRole('button', { name: '배경 추가', exact: true }).click()
    await page.locator('[data-scene-id="32"]').click()
    await page.getByPlaceholder('배경 프롬프트', { exact: true }).fill('beach, sunset')
    await page.getByRole('button', { name: '배경 목록', exact: true }).click()
    await page.screenshot({ path: `${out}/top-level-background-tab.png` })
    await page.getByRole('button', { name: '씬 태그', exact: true }).click()
    await page.locator('[data-scene-id="30"]').waitFor()
    assert.equal(await page.locator('[data-scene-id]').count(), 30)
    await page.getByRole('button', { name: '배경 태그', exact: true }).click()
    await page.locator('[data-scene-id="31"]').waitFor()
    assert.equal(await page.locator('[data-scene-id]').count(), 2)
    await page
      .locator('[data-scene-id="31"]')
      .getByRole('button', { name: '이 배경을 씬에 사용' })
      .click()
    await page.getByRole('checkbox', { name: '씬 01', exact: true }).check()
    await page.getByRole('checkbox', { name: '씬 02', exact: true }).check()
    await page.screenshot({ path: `${out}/apply-to-scenes.png` })
    await page.getByRole('button', { name: '2개 씬에 적용하고 이동', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.locator('[data-scene-id="30"]').waitFor()
    assert.equal(await page.evaluate(() => window.censorFixture.state().libraryKind), 'scene')
    assert.equal(
      await page.evaluate(
        () =>
          window.censorFixture.records().filter((s) => s.background?.prompt === 'forest, sunlight')
            .length
      ),
      2
    )
    assert.equal(
      await page.evaluate(() => window.censorFixture.records()[0].prompt),
      'landscape, blue sky'
    )
    await page.evaluate(() => window.censorFixture.state().select(1))
    await page.getByRole('button', { name: '배경 태그 설정' }).click()
    assert.equal(await page.getByRole('button', { name: '새 배경 forest, sunlight' }).count(), 1)
    await page.getByRole('button', { name: '취소', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: '배경 태그', exact: true }).click()
    await page.locator('[data-scene-id="31"]').waitFor()
    assert.equal(await page.locator('[data-scene-id]').count(), 2)
    await page.setViewportSize({ width: 768, height: 960 })
    await page.screenshot({ path: `${out}/tablet.png` })
    assert.deepEqual(errors, [])
    console.log(
      'PASS: top-level background tab, isolated cards, edit, generation queue, completed-image refresh, favorite, tab return, selection/apply, shared library, reload, tablet'
    )
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
