const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = '.superloopy/evidence/frontend/censor'
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto('http://127.0.0.1:5189/censor.html')
    await page.locator('[data-scene-id="30"]').waitFor()
    await page.getByRole('button', { name: '5', exact: true }).click()
    await page.getByRole('button', { name: '검열할 씬 선택', exact: true }).click()
    await page.locator('[data-scene-id="1"]').click({ position: { x: 45, y: 70 } })
    await page
      .locator('[data-scene-id="15"]')
      .click({ position: { x: 45, y: 70 }, modifiers: ['Shift'] })
    assert.equal(await page.evaluate(() => window.censorFixture.state().selection.size), 15)
    await page.getByRole('button', { name: '선택 15개 검열 설정' }).click()
    await page.getByRole('checkbox', { name: '음경 검열', exact: true }).check()
    await page.getByRole('checkbox', { name: '고환 검열', exact: true }).check()
    await page.screenshot({ path: `${out}/batch-dialog.png` })
    await page.getByRole('button', { name: '15개 씬에 적용' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(
      await page.evaluate(
        () => window.censorFixture.records().filter((s) => s.censorKinds.length).length
      ),
      15
    )
    await page.reload()
    await page.locator('[data-scene-id="30"]').waitFor()
    assert.equal(
      await page.evaluate(
        () => window.censorFixture.state().scenes.filter((s) => s.censorKinds.length).length
      ),
      15
    )
    await page.screenshot({ path: `${out}/applied-grid.png` })
    // Single scene edit; cancel is a true draft.
    await page.getByRole('button', { name: '씬 16: 검열 태그 없음, 수정', exact: true }).click()
    await page.getByRole('checkbox', { name: '외음부 검열', exact: true }).check()
    await page.getByRole('button', { name: '취소', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.censorFixture.records()[15].censorKinds), [])
    await page.getByRole('button', { name: '씬 16: 검열 태그 없음, 수정', exact: true }).click()
    await page.getByRole('checkbox', { name: '외음부 검열', exact: true }).check()
    await page.evaluate(() => window.censorFixture.failNext())
    await page.getByRole('button', { name: '1개 씬에 적용' }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(
      await page.getByRole('checkbox', { name: '외음부 검열', exact: true }).isChecked(),
      true
    )
    assert.deepEqual(await page.evaluate(() => window.censorFixture.records()[15].censorKinds), [])
    await page.screenshot({ path: `${out}/save-error.png` })
    await page.getByRole('button', { name: '1개 씬에 적용' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    // Two different scenes: adding anal leaves the other per-scene options untouched.
    await page.getByRole('button', { name: '검열할 씬 선택', exact: true }).click()
    for (const id of [1, 16])
      await page.locator(`[data-scene-id="${id}"]`).click({ position: { x: 45, y: 70 } })
    await page.getByRole('button', { name: '선택 2개 검열 설정' }).click()
    assert.equal(
      await page
        .getByRole('checkbox', { name: '음경 검열', exact: true })
        .getAttribute('aria-checked'),
      'mixed'
    )
    await page.getByRole('checkbox', { name: '항문 검열', exact: true }).check()
    await page.getByRole('button', { name: '2개 씬에 적용' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.censorFixture.records()[0].censorKinds), [
      'penis',
      'anal',
      'testicles'
    ])
    assert.deepEqual(await page.evaluate(() => window.censorFixture.records()[15].censorKinds), [
      'vulva',
      'anal'
    ])
    await page.getByRole('button', { name: '선택 2개 검열 설정' }).click()
    await page.getByRole('button', { name: '모두 끄기' }).click()
    await page.getByRole('button', { name: '2개 씬에 적용' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.censorFixture.records()[0].censorKinds), [])
    // Empty preset, switching back, detail entry point.
    await page.evaluate(() => window.censorFixture.preset(2))
    assert.equal(
      await page.getByRole('button', { name: '검열할 씬 선택', exact: true }).isDisabled(),
      true
    )
    await page.evaluate(() => window.censorFixture.preset(1))
    await page.reload()
    await page.locator('[data-scene-id="2"]').click({ position: { x: 45, y: 70 } })
    assert.equal(await page.evaluate(() => window.censorFixture.state().selectedId), 2)
    await page
      .getByRole('button', { name: '씬 02: 검열 태그: 음경 · 고환, 수정', exact: true })
      .click()
    await page.getByRole('dialog').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.censorFixture.state().selectedId), 2)
    await page.reload()
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 850 })
      await page.locator('[data-scene-id="2"]').waitFor()
      await page
        .getByRole('button', { name: '씬 02: 검열 태그: 음경 · 고환, 수정', exact: true })
        .click()
      const modal = page.getByRole('dialog')
      const rect = await modal.boundingBox()
      assert(rect.x >= 0 && rect.x + rect.width <= width + 1)
      assert(rect.y >= 0 && rect.y + rect.height <= 851)
      assert.equal(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth), true)
      await page.screenshot({ path: `${out}/dialog-${width}.png` })
      await page.getByRole('button', { name: '취소', exact: true }).click()
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
    await page
      .getByRole('button', { name: '씬 02: 검열 태그: 음경 · 고환, 수정', exact: true })
      .click()
    await page.screenshot({ path: `${out}/dialog-light.png` })
    assert.deepEqual(errors, [])
    console.log(
      'PASS: range select 15/30, apply, reload, single edit, cancel, save failure/retry, mixed, clear, preset switch, detail, Escape, 390/768/1280, light/dark'
    )
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
