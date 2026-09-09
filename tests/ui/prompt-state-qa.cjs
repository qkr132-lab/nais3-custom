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
  const fields = () => page.locator('textarea')
  try {
    await page.goto('http://127.0.0.1:5189/prompt-state.html')
    await fields().first().fill('latest A')
    await page.getByRole('button', { name: '프리셋 A', exact: true }).click()
    await page.getByText('프리셋 B', { exact: true }).click()
    assert.equal(await fields().first().inputValue(), 'base B')
    await page.getByRole('button', { name: '프리셋 B', exact: true }).click()
    await page.getByText('프리셋 A', { exact: true }).click()
    assert.equal(await fields().first().inputValue(), 'latest A')
    assert.equal(
      await page.evaluate(() => window.promptFixture.presets()[0].params.promptParts.base),
      'latest A'
    )
    passed.push('rapid preset switch flushes edits and preserves three fields')
    await page.getByRole('button', { name: '분할 끄기', exact: true }).click()
    await page.getByPlaceholder('통합 입력').fill('plain newest')
    await page.getByRole('button', { name: '씬 요청 만들기', exact: true }).click()
    await page.waitForFunction(() => window.promptFixture.queued().length === 1)
    let item = await page.evaluate(() => window.promptFixture.queued()[0].request)
    assert.equal(item.prompt, 'plain newest, scene tags')
    assert.equal(item.promptParts, undefined)
    await page.getByRole('button', { name: '분할 켜기', exact: true }).click()
    assert.equal(await fields().first().inputValue(), 'plain newest')
    assert.equal(await fields().nth(1).inputValue(), '')
    passed.push('split off edit is used in actual scene enqueue; toggling on has no stale parts')
    await page.evaluate(() => window.promptFixture.clearQueue())
    await fields().first().fill('sky # note')
    await fields().nth(1).fill('smile # middle')
    await fields().nth(2).fill('detail newest')
    await page.getByRole('button', { name: '메인 요청 만들기', exact: true }).click()
    await page.getByRole('button', { name: '씬 요청 만들기', exact: true }).click()
    await page.waitForFunction(() => window.promptFixture.queued().length === 2)
    item = await page.evaluate(() => window.promptFixture.queued()[1].request)
    assert.match(item.prompt, /sky # note\nsmile # middle\nscene tags, detail newest/)
    await fields().nth(2).fill('live changed detail')
    await page.waitForFunction(() =>
      window.promptFixture.queued().every((i) => i.request.prompt.includes('live changed detail'))
    )
    passed.push('comment boundaries and paused pending main + scene requests follow edits')
    await page.evaluate(() => window.promptFixture.scenes().update(1, { prompt: 'updated scene' }))
    await page.waitForFunction(() =>
      window.promptFixture.queued()[1].request.prompt.includes('updated scene')
    )
    assert.ok(
      !(await page.evaluate(() => window.promptFixture.queued()[0].request.prompt)).includes(
        'updated scene'
      )
    )
    passed.push('scene changes refresh only scene request')
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: '저장값 다시 읽기', exact: true }).click()
    assert.equal(await fields().nth(2).inputValue(), 'live changed detail')
    passed.push('settings hydration restores latest split fields')
    await page.getByText('합친 원문 보기', { exact: false }).click()
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 850 })
      await page.screenshot({ path: `${out}/split-${width}.png` })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(`${out}/prompt-results.json`, JSON.stringify({ passed, errors }, null, 2))
    console.log({ passed, errors })
  } catch (e) {
    await page.screenshot({ path: `${out}/prompt-failure.png` })
    console.error(passed)
    throw e
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
