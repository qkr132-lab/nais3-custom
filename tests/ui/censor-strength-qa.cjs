const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict'),
  fs = require('node:fs')
const out = '.superloopy/evidence/frontend/strength-sync'
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } }),
    errors = [],
    passed = []
  page.on('pageerror', (e) => errors.push(e.message))
  const setRange = async (name, steps) => {
    const range = page.getByRole('slider', { name, exact: true })
    await range.focus()
    await range.press('Home')
    for (let i = 0; i < steps; i++) await range.press('ArrowRight')
  }
  const record = (id) =>
    page.evaluate((id) => window.censorFixture.records().find((s) => s.id === id), id)
  try {
    await page.goto('http://127.0.0.1:5189/censor.html')
    await page.getByRole('button', { name: '씬 01: 검열 태그 없음, 수정', exact: true }).click()
    await page.getByRole('checkbox', { name: '음경 검열', exact: true }).check()
    await setRange('음경 검열 강도', 11)
    await setRange('보정 태그 억제 강도', 4)
    await page.getByText('적용 태그 미리보기', { exact: false }).click()
    assert.match(await page.getByRole('dialog').textContent(), /1.2::completely white penis censor/)
    assert.match(await page.getByRole('dialog').textContent(), /-0.4::/)
    await page.getByRole('button', { name: '1개 씬에 적용', exact: true }).click()
    assert.equal((await record(1)).censorWeights.penis, 1.2)
    await page.reload()
    await page.getByRole('button', { name: '씬 01: 검열 태그: 음경, 수정', exact: true }).click()
    assert.equal(
      await page.getByRole('slider', { name: '음경 검열 강도', exact: true }).inputValue(),
      '1.2'
    )
    await setRange('음경 검열 강도', 20)
    await page.getByRole('button', { name: '취소', exact: true }).click()
    assert.equal((await record(1)).censorWeights.penis, 1.2)
    passed.push('slider changes preview and persists; reload/cancel preserve value')
    await page.evaluate(async () => {
      await window.censorFixture
        .state()
        .setCensors([2], { penis: true, weights: { penis: 2.4, suppress: 1.1 } })
      const s = window.censorFixture.state()
      s.setEditMode(true)
      s.clearSelection()
      s.toggleSelected(1)
      s.toggleSelected(2)
    })
    await page.getByRole('button', { name: '선택 2개 검열 설정', exact: true }).click()
    assert.equal(await page.getByText('서로 다름', { exact: true }).count(), 2)
    await page.getByRole('checkbox', { name: '항문 검열', exact: true }).check()
    await setRange('항문 검열 강도', 6)
    await page.getByRole('button', { name: '2개 씬에 적용', exact: true }).click()
    assert.equal((await record(1)).censorWeights.penis, 1.2)
    assert.equal((await record(2)).censorWeights.penis, 2.4)
    assert.equal((await record(1)).censorWeights.anal, 0.7)
    assert.equal((await record(2)).censorWeights.anal, 0.7)
    passed.push('mixed untouched weights persist; changed weight applies to both')
    await page.getByRole('button', { name: '선택 2개 검열 설정', exact: true }).click()
    await page.getByRole('button', { name: '모두 켜기', exact: true }).click()
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 850 })
      const box = await page.getByRole('dialog').boundingBox()
      assert.ok(
        box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 851
      )
      await page.screenshot({ path: `${out}/strength-${width}.png` })
      await page
        .getByRole('slider', { name: '보정 태그 억제 강도', exact: true })
        .scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${out}/strength-bottom-${width}.png` })
    }
    await page.getByRole('button', { name: '가중치 기본값 복원', exact: true }).click()
    await page.evaluate(() => window.censorFixture.failNext())
    await page.getByRole('button', { name: '2개 씬에 적용', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal((await record(1)).censorWeights.penis, 1.2)
    await page.getByRole('button', { name: '2개 씬에 적용', exact: true }).click()
    assert.equal((await record(1)).censorWeights.penis, 2)
    assert.equal((await record(2)).censorWeights.suppress, 2)
    passed.push('responsive scroll, reset defaults, save failure retains draft, retry')
    assert.deepEqual(errors, [])
    fs.writeFileSync(`${out}/strength-results.json`, JSON.stringify({ passed, errors }, null, 2))
    console.log({ passed, errors })
  } catch (e) {
    await page.screenshot({ path: `${out}/strength-failure.png` })
    console.error(passed)
    throw e
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
