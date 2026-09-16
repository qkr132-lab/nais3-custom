const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const out = '.superloopy/evidence/frontend/background'
  fs.mkdirSync(out, { recursive: true })
  try {
    await page.goto('http://127.0.0.1:5189/censor.html')
    await page.locator('[data-scene-id="30"]').waitFor()
    await page.getByRole('button', { name: '5', exact: true }).click()
    await page.getByRole('button', { name: '배경 설정할 씬 선택', exact: true }).click()
    await page.locator('[data-scene-id="1"]').click({ position: { x: 45, y: 70 } })
    await page
      .locator('[data-scene-id="15"]')
      .click({ position: { x: 45, y: 70 }, modifiers: ['Shift'] })
    await page.getByRole('button', { name: '선택 15개 배경 설정', exact: true }).click()
    await page
      .getByPlaceholder('배경 태그 (예: outdoors, forest, sunlight)')
      .fill('forest, sunlight')
    await page.getByLabel('배경 이름', { exact: true }).fill('숲 햇빛')
    await page.getByRole('checkbox', { name: '기존 단색 배경 태그 제외' }).check()
    await page.getByLabel('배경 삽입 위치').selectOption('before-scene')
    assert.match(
      await page.getByTestId('background-preview').textContent(),
      /forest, sunlight, landscape, blue sky/
    )
    await page.getByRole('button', { name: '보관함 저장', exact: true }).click()
    await page.getByText('배경 보관함에 저장했어요.', { exact: true }).waitFor()
    await page.screenshot({ path: `${out}/library.png` })
    await page.getByRole('button', { name: '취소', exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => window.censorFixture.records().filter((s) => s.background?.prompt).length
      ),
      0
    )
    await page.getByRole('button', { name: '선택 15개 배경 설정', exact: true }).click()
    await page.getByRole('button', { name: '숲 햇빛 forest, sunlight' }).click()
    await page.evaluate(() => window.censorFixture.failNext())
    await page.getByRole('button', { name: '15개 씬에 적용', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(
      await page.evaluate(
        () => window.censorFixture.records().filter((s) => s.background?.prompt).length
      ),
      0
    )
    await page.getByRole('button', { name: '15개 씬에 적용', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.reload()
    await page.locator('[data-scene-id="30"]').waitFor()
    assert.equal(
      await page.evaluate(
        () => window.censorFixture.records().filter((s) => s.background?.prompt).length
      ),
      15
    )
    assert.ok(
      await page.evaluate(() =>
        window.censorFixture.records().every((s) => s.prompt === 'landscape, blue sky')
      )
    )
    await page.evaluate(() => window.censorFixture.state().select(1))
    await page.getByRole('button', { name: '배경 태그 설정', exact: true }).click()
    await page.getByRole('button', { name: '테스트 씬 만들기', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.censorFixture.state().selectedId), 31)
    assert.equal(
      await page.evaluate(() => window.censorFixture.records().at(-1).background.prompt),
      'forest, sunlight'
    )
    await page.getByRole('button', { name: '배경 태그 설정', exact: true }).click()
    await page.getByPlaceholder('배경 태그 (예: outdoors, forest, sunlight)').fill('')
    await page.getByRole('button', { name: '1개 씬에 적용', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(
      await page.evaluate(() => window.censorFixture.records().at(-1).background.prompt),
      ''
    )
    assert.deepEqual(errors, [])
    console.log(
      'PASS: background library persistence, cancel, preview order, failed save, batch 15/30, reload, original preservation, test scene, clear'
    )
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
