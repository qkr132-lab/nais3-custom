const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = '.superloopy/evidence/frontend/token-count'
const base = 'http://127.0.0.1:5189/token-count.html'
const tests = []
const badge = (page, id = 'editor-a') => page.getByTestId(id).locator('span[title]')
const expectText = (locator, text) => locator.filter({ hasText: text }).waitFor()
const findCall = async (page, text, channel = 'tokens:count') => {
  await page.waitForFunction(
    ({ text, channel }) =>
      window.tokenFixture.state.calls.some(
        (call) => call.channel === channel && JSON.stringify(call.request).includes(text)
      ),
    { text, channel }
  )
  return page.evaluate(
    ({ text, channel }) =>
      window.tokenFixture.state.calls.findLast(
        (call) => call.channel === channel && JSON.stringify(call.request).includes(text)
      ),
    { text, channel }
  )
}
const reply = (page, call, data) =>
  page.evaluate(({ id, data }) => window.tokenFixture.reply(id, data), { id: call.id, data })
const report = (positive, negative, model = 'nai-diffusion-5-full') => ({
  model,
  limit: model.includes('curated') ? 703 : model.includes('-5-') ? 1471 : 512,
  positive,
  negative,
  characters: [],
  estimated: false
})

tests.push([
  'model limits and exact boundary styling',
  'editor',
  async (page) => {
    const input = page.getByPlaceholder('토큰 입력')
    for (const [model, limit] of [
      ['nai-diffusion-5-full', 1471],
      ['nai-diffusion-5-curated', 703],
      ['nai-diffusion-4-5-full', 512]
    ]) {
      await page.evaluate((model) => window.tokenFixture.patch({ model }), model)
      await input.fill('x'.repeat(limit))
      await expectText(badge(page), `${limit}/${limit}`)
      assert(!((await badge(page).getAttribute('class')) || '').includes('text-danger'))
      await input.press('x')
      await expectText(badge(page), `${limit + 1}/${limit}`)
      assert((await badge(page).getAttribute('class')).includes('text-danger'))
      const call = await findCall(page, model)
      assert.equal(call.request.model, model)
    }
    assert.match(await badge(page).getAttribute('title'), /부분 계산/)
  }
])

tests.push([
  'latest standalone response wins and old count is hidden during recalculation',
  'editor',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.mode = 'manual'))
    const input = page.getByPlaceholder('토큰 입력')
    await input.fill('old')
    const old = await findCall(page, 'old')
    await input.fill('new')
    const latest = await findCall(page, 'new')
    await reply(page, latest, { counts: [222], limit: 1471 })
    await expectText(badge(page), '222/1471')
    await reply(page, old, { counts: [111], limit: 1471 })
    await page.waitForTimeout(80)
    assert.equal(await badge(page).textContent(), '222/1471')
    await input.fill('next')
    assert.equal(await badge(page).count(), 0)
  }
])

tests.push([
  'clearing input cannot be overwritten by an in-flight result',
  'editor',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.mode = 'manual'))
    const input = page.getByPlaceholder('토큰 입력')
    await input.fill('old')
    const old = await findCall(page, 'old')
    await input.fill('')
    await reply(page, old, { counts: [111], limit: 1471 })
    await page.waitForTimeout(80)
    assert.equal(await badge(page).count(), 0)
  }
])

tests.push([
  'model switch rejects an older model response for unchanged text',
  'editor',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.mode = 'manual'))
    await page.getByPlaceholder('토큰 입력').fill('same text')
    const old = await findCall(page, 'nai-diffusion-5-full')
    await page.evaluate(() => window.tokenFixture.patch({ model: 'nai-diffusion-5-curated' }))
    const latest = await findCall(page, 'nai-diffusion-5-curated')
    await reply(page, latest, { counts: [25], limit: 703 })
    await expectText(badge(page), '25/703')
    await reply(page, old, { counts: [90], limit: 1471 })
    await page.waitForTimeout(80)
    assert.equal(await badge(page).textContent(), '25/703')
  }
])

tests.push([
  'failed counting recovers without an unhandled rejection',
  'editor',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.mode = 'manual'))
    const input = page.getByPlaceholder('토큰 입력')
    await input.fill('failed')
    const failed = await findCall(page, 'failed')
    await page.evaluate((id) => window.tokenFixture.reject(id), failed.id)
    await page.waitForTimeout(60)
    assert.equal(await badge(page).count(), 0)
    await input.fill('recovered')
    const next = await findCall(page, 'recovered')
    await reply(page, next, { counts: [9], limit: 1471 })
    await expectText(badge(page), '9/1471')
  }
])

tests.push([
  'identical concurrent editors share one IPC request',
  'duplicate',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.delay = 450))
    await page.getByPlaceholder('토큰 입력').fill('shared')
    await expectText(badge(page), '6/1471')
    await expectText(badge(page, 'editor-b'), '6/1471')
    assert.equal(await page.evaluate(() => window.tokenFixture.state.calls.length), 1)
  }
])

tests.push([
  'explicit editor model remains independent of the selected model',
  'override',
  async (page) => {
    await page.getByPlaceholder('토큰 입력').fill('abcd')
    await expectText(badge(page), '4/1471')
    await expectText(badge(page, 'editor-b'), '4/512')
    await page.evaluate(() => window.tokenFixture.patch({ model: 'nai-diffusion-5-curated' }))
    await expectText(badge(page), '4/703')
    assert.equal(await badge(page, 'editor-b').textContent(), '4/512')
  }
])

tests.push([
  'fragment changes invalidate old responses without changing IPC fields',
  'editor',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.mode = 'manual'))
    await page.getByPlaceholder('토큰 입력').fill('<sample>')
    const old = await findCall(page, '<sample>')
    await page.evaluate(() => window.tokenFixture.fragment('updated fragment'))
    await page.waitForFunction(() => window.tokenFixture.state.calls.length === 2)
    const latest = await findCall(page, '<sample>')
    assert.deepEqual(Object.keys(latest.request).sort(), ['model', 'texts'])
    await reply(page, latest, { counts: [25], limit: 1471, estimated: true })
    await expectText(badge(page), '25/1471')
    await reply(page, old, { counts: [5], limit: 1471 })
    await page.waitForTimeout(80)
    assert.match(await badge(page).textContent(), /25\/1471/)
    assert.match(await badge(page).textContent(), /약 /)
    assert.match(await badge(page).getAttribute('title'), /예상값/)
  }
])

tests.push([
  'main totals include both character signs and update quality/UC/model inputs',
  'panel',
  async (page) => {
    const pos = page.locator('span[title^="긍정 최종 합계"]').first()
    const neg = page.locator('span[title^="부정 최종 합계"]').first()
    await expectText(pos, '13/1471')
    await expectText(neg, '26/1471')
    await page.evaluate(() => window.tokenFixture.characters({ negativePrompt: 'xxxx' }))
    await expectText(neg, '12/1471')
    await page.evaluate(() =>
      window.tokenFixture.patch({
        qualityToggle: true,
        ucPreset: 4,
        model: 'nai-diffusion-5-curated'
      })
    )
    await expectText(pos, '13/703')
    const call = await findCall(page, 'nai-diffusion-5-curated', 'tokens:preview')
    assert.equal(call.request.requests[0].qualityToggle, true)
    assert.equal(call.request.requests[0].ucPreset, 4)
    assert.deepEqual(Object.keys(call.request.requests[0]).sort(), [
      'characterPrompts',
      'model',
      'negativePrompt',
      'prompt',
      'qualityToggle',
      'ucPreset'
    ])
    await page.evaluate(() => window.tokenFixture.characters({ enabled: false }))
    await expectText(pos, '4/703')
    await expectText(neg, '8/703')
  }
])

tests.push([
  'main and open character overlay share totals with independent sign budgets',
  'panel',
  async (page) => {
    await page.evaluate(() => {
      window.tokenFixture.state.delay = 500
      window.tokenFixture.overlay(true)
    })
    await page.getByText('긍정 13/1471', { exact: true }).waitFor()
    await page.getByText('부정 26/1471', { exact: true }).waitFor()
    const calls = await page.evaluate(() =>
      window.tokenFixture.state.calls.filter((c) => c.channel === 'tokens:preview')
    )
    assert.equal(calls.length, 1)
  }
])

tests.push([
  'scene latest response survives late old response (reported regression)',
  'scene',
  async (page) => {
    await page.evaluate(() => (window.tokenFixture.state.mode = 'manual'))
    await page.evaluate(() => window.tokenFixture.scene({ prompt: 'old scene' }))
    const old = await findCall(page, 'old scene', 'tokens:preview')
    await page.evaluate(() => window.tokenFixture.scene({ prompt: 'new scene' }))
    const latest = await findCall(page, 'new scene', 'tokens:preview')
    await reply(page, latest, { reports: [report(222, 22)] })
    const pos = page.locator('span[title^="긍정 최종 합계"]').first()
    await expectText(pos, '222/1471')
    await reply(page, old, { reports: [report(111, 11)] })
    await page.waitForTimeout(100)
    assert.equal(await pos.textContent(), '222/1471')
  }
])

tests.push([
  'scene previews each queue round and displays the highest sign totals',
  'scene',
  async (page) => {
    await page.evaluate(() => {
      window.tokenFixture.state.mode = 'manual'
      window.tokenFixture.extras({
        sequenceEnabled: true,
        entries: [
          {
            id: 'a',
            name: '첫 회차',
            characterIds: [1],
            charRefIds: [],
            vibeIds: [],
            enabled: true,
            charTags: { 1: 'round one' }
          },
          {
            id: 'b',
            name: '둘째 회차',
            characterIds: [1],
            charRefIds: [],
            vibeIds: [],
            enabled: true,
            charTags: { 1: 'round two' }
          }
        ]
      })
    })
    const call = await findCall(page, 'round two', 'tokens:preview')
    assert.equal(call.request.requests.length, 2)
    await reply(page, call, { reports: [report(100, 400), report(300, 200)] })
    const pos = page.locator('span[title^="긍정 최종 합계"]').first()
    const neg = page.locator('span[title^="부정 최종 합계"]').first()
    await expectText(pos, '300/1471')
    await expectText(neg, '400/1471')
    assert.match(await pos.getAttribute('title'), /첫 회차: 100\/1471/)
    assert.match(await pos.getAttribute('title'), /둘째 회차: 300\/1471/)
    assert.match(await neg.getAttribute('title'), /회차별 독립 한도/)
  }
])

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const results = []
  try {
    for (const [name, mode, run] of tests) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      try {
        await page.goto(`${base}?mode=${mode}`)
        await page.waitForFunction(() => !!window.tokenFixture)
        await run(page)
        assert.deepEqual(errors, [])
        results.push({ name, passed: true })
        console.log(`PASS ${name}`)
        if (mode === 'panel' || mode === 'scene')
          await page.screenshot({ path: `${out}/pass-${results.length}.png` })
      } catch (error) {
        const state = await page
          .evaluate(() => ({ fixture: window.tokenFixture?.state, text: document.body.innerText }))
          .catch(() => null)
        results.push({ name, passed: false, error: error.message, errors, state })
        console.error(`FAIL ${name}: ${error.message}`)
        await page.screenshot({ path: `${out}/failure-${results.length}.png` }).catch(() => {})
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  const passed = results.filter((r) => r.passed).length
  fs.writeFileSync(
    `${out}/report.json`,
    JSON.stringify({ passed, total: results.length, results }, null, 2)
  )
  console.log(`${passed}/${results.length} token UI cases passed`)
  if (passed !== results.length) process.exitCode = 1
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
