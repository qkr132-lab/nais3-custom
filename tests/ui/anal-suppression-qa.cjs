const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = '.superloopy/evidence/frontend/anal-suppression'
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const errors = [],
    passed = []
  page.on('pageerror', (error) => errors.push(error.message))
  const button = (name) => page.getByRole('button', { name, exact: true })
  const record = (id) =>
    page.evaluate((id) => window.censorFixture.records().find((s) => s.id === id), id)
  const open = (id) =>
    page
      .locator(`[data-scene-id="${id}"]`)
      .getByRole('button', { name: /검열 태그.*수정/ })
      .click()
  try {
    await page.goto('http://127.0.0.1:5189/censor.html')
    await open(1)
    assert.equal(await button('항문 성행위 억제 OFF').getAttribute('aria-pressed'), 'true')
    await button('항문 성행위 억제 ON').click()
    await page.getByText('적용 태그 미리보기', { exact: false }).click()
    assert.match(await page.getByRole('dialog').textContent(), /네거티브: anal/)
    await button('1개 씬에 적용').click()
    assert.equal((await record(1)).suppressAnal, true)
    assert.deepEqual((await record(1)).censorKinds, [])
    await page.reload()
    await open(1)
    assert.equal(await button('항문 성행위 억제 ON').getAttribute('aria-pressed'), 'true')
    await button('항문 성행위 억제 OFF').click()
    await button('취소').click()
    assert.equal((await record(1)).suppressAnal, true)
    passed.push('default OFF, independent ON, negative preview, persistence and cancel')

    await page.evaluate(() => {
      const store = window.censorFixture.state()
      store.setEditMode(true)
      store.clearSelection()
      store.toggleSelected(1)
      store.toggleSelected(2)
    })
    await button('선택 2개 검열 설정').click()
    assert.equal(await page.getByText('일부 켜짐 1/2', { exact: true }).count(), 1)
    assert.equal(await button('항문 성행위 억제 ON').getAttribute('aria-pressed'), 'false')
    assert.equal(await button('항문 성행위 억제 OFF').getAttribute('aria-pressed'), 'false')
    await page.getByRole('checkbox', { name: '항문 검열', exact: true }).check()
    await button('2개 씬에 적용').click()
    assert.equal((await record(1)).suppressAnal, true)
    assert.equal((await record(2)).suppressAnal ?? false, false)
    await button('선택 2개 검열 설정').click()
    await button('항문 성행위 억제 ON').click()
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 850 })
      await button('항문 성행위 억제 ON').scrollIntoViewIfNeeded()
      const bounds = await page.getByRole('dialog').boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1)
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 851)
      assert.equal(
        await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true
      )
      await page.screenshot({ path: `${out}/toggle-${width}.png` })
    }
    await button('2개 씬에 적용').click()
    assert.equal((await record(2)).suppressAnal, true)
    passed.push(
      'mixed batch retains untouched options; explicit ON applies to all; responsive layout'
    )

    await button('선택 2개 검열 설정').click()
    await button('항문 성행위 억제 OFF').click()
    await page.evaluate(() => window.censorFixture.failNext())
    await button('2개 씬에 적용').click()
    await page.getByRole('alert').waitFor()
    assert.equal((await record(1)).suppressAnal, true)
    await button('2개 씬에 적용').click()
    assert.equal((await record(1)).suppressAnal, false)
    assert.equal((await record(2)).suppressAnal, false)
    assert.deepEqual((await record(1)).censorKinds, ['anal'])
    passed.push('failed save retains data; retry turns off only suppression, keeping white censor')
    assert.deepEqual(errors, [])
    fs.writeFileSync(`${out}/results.json`, JSON.stringify({ passed, errors }, null, 2))
    console.log({ passed, errors })
  } catch (error) {
    await page.screenshot({ path: `${out}/failure.png` })
    throw error
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
