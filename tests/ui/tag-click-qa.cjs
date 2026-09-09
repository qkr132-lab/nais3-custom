const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = '.superloopy/evidence/frontend/tag-click'
const url = process.env.NAIS_UI_QA_URL || 'http://127.0.0.1:5189/tag-completion.html'
const cases = []

async function capture(page) {
  await page.evaluate(() => {
    window.tagClickEvents = []
    const types = [
      'pointerdown',
      'pointerup',
      'click',
      'compositionstart',
      'compositionend',
      'beforeinput',
      'input',
      'blur',
      'focus'
    ]
    for (const type of types)
      document.addEventListener(
        type,
        (event) => {
          const el = event.target
          if (
            !(el instanceof HTMLElement) ||
            (!el.matches('textarea') && !el.closest('[role=option]'))
          )
            return
          const input = el.matches('textarea') ? el : document.activeElement
          const entry = {
            type,
            at: performance.now(),
            detail: event.detail,
            inputType: event.inputType,
            data: event.data,
            composing: event.isComposing,
            target: el.tagName,
            prevented: event.defaultPrevented,
            text: input?.value
          }
          window.tagClickEvents.push(entry)
          queueMicrotask(() => {
            entry.prevented = event.defaultPrevented
          })
        },
        true
      )
    const observer = new MutationObserver(() => {
      if (
        window.tagClickReadyAt == null &&
        document.querySelector('[role=listbox][aria-busy=false] [role=option]')
      )
        window.tagClickReadyAt = performance.now()
    })
    observer.observe(document.body, { childList: true, attributes: true, subtree: true })
  })
}

async function ready(page) {
  await page.waitForFunction(() =>
    document.querySelector('[role=listbox][aria-busy=false] [role=option]')
  )
}

async function clickPoint(page) {
  const bounds = await page.locator('[role=listbox] [role=option]').first().boundingBox()
  return { x: bounds.x + 30, y: bounds.y + 20 }
}

async function acceptedOnce(page, input) {
  await page.waitForTimeout(450)
  assert.equal(await input.inputValue(), 'smile, ')
  assert.deepEqual(await page.evaluate(() => window.tagFixture.accepted), ['smile'])
}

cases.push([
  'first click immediately after a result appears',
  async ({ page, input }) => {
    await input.fill('sm')
    await ready(page)
    const point = await clickPoint(page)
    await page.mouse.click(point.x, point.y)
    const delta = await page.evaluate(
      () => window.tagClickEvents.find((e) => e.type === 'pointerdown').at - window.tagClickReadyAt
    )
    assert.ok(delta < 150, `rapid click must occur inside former ignored interval, got ${delta}ms`)
    await acceptedOnce(page, input)
    return { readyToClickMs: delta }
  }
])

cases.push([
  'single native click while Korean IME composition is active',
  async ({ page, input, cdp }) => {
    await input.focus()
    await cdp.send('Input.imeSetComposition', {
      text: '심백안',
      selectionStart: 3,
      selectionEnd: 3
    })
    await ready(page)
    await page.waitForTimeout(180)
    const point = await clickPoint(page)
    await page.mouse.click(point.x, point.y)
    await acceptedOnce(page, input)
  }
])

cases.push([
  'composition commits between pointer down and pointer up',
  async ({ page, input, cdp }) => {
    await input.focus()
    await cdp.send('Input.imeSetComposition', {
      text: '심백안',
      selectionStart: 3,
      selectionEnd: 3
    })
    await ready(page)
    await page.waitForTimeout(180)
    const point = await clickPoint(page)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await cdp.send('Input.insertText', { text: '심백안' })
    await page.mouse.up()
    await acceptedOnce(page, input)
  }
])

cases.push([
  'dragging a row keeps the original input',
  async ({ page, input }) => {
    await input.fill('sm')
    await ready(page)
    await page.waitForTimeout(180)
    const point = await clickPoint(page)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + 45, point.y)
    await page.mouse.up()
    await page.waitForTimeout(250)
    assert.equal(await input.inputValue(), 'sm')
    assert.deepEqual(await page.evaluate(() => window.tagFixture.accepted), [])
  }
])

cases.push([
  'native IME click remains undoable and the next Korean composition inserts cleanly',
  async ({ page, input, cdp }) => {
    await input.focus()
    await cdp.send('Input.imeSetComposition', {
      text: '심백안',
      selectionStart: 3,
      selectionEnd: 3
    })
    await ready(page)
    let point = await clickPoint(page)
    await page.mouse.click(point.x, point.y)
    await acceptedOnce(page, input)
    await input.press('Control+z')
    assert.equal(await input.inputValue(), '심백안')
    await input.press('Escape')
    await input.press('End')
    await page.keyboard.type(', ')
    await cdp.send('Input.imeSetComposition', { text: '전신', selectionStart: 2, selectionEnd: 2 })
    assert.equal(await input.inputValue(), '심백안, 전신')
    await ready(page)
    point = await clickPoint(page)
    await page.mouse.click(point.x, point.y)
    await page.waitForTimeout(450)
    assert.equal(await input.inputValue(), '심백안, smile, ')
    assert.deepEqual(await page.evaluate(() => window.tagFixture.accepted), ['smile', 'smile'])
  }
])

cases.push([
  'native IME first click inside Scene enlarged placement retains both dialogs',
  async ({ page, cdp }) => {
    await page.goto(new URL('placement.html?mode=addition&tags=1', url).href)
    await capture(page)
    await page.getByRole('button', { name: '넓게 배치', exact: true }).click()
    const dialog = page.getByRole('dialog').last()
    await dialog.getByRole('button', { name: /, X / }).first().click()
    const input = dialog.locator('textarea').first()
    await input.fill('')
    await input.focus()
    await cdp.send('Input.imeSetComposition', {
      text: '심백안',
      selectionStart: 3,
      selectionEnd: 3
    })
    await ready(page)
    const point = await clickPoint(page)
    await page.mouse.click(point.x, point.y)
    await acceptedOnce(page, input)
    assert.equal(await page.getByRole('dialog', { includeHidden: true }).count(), 2)
  }
])

cases.push([
  'changing the query during pointer down cannot insert the old suggestion',
  async ({ page, input }) => {
    await input.fill('sm')
    await ready(page)
    const point = await clickPoint(page)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await input.fill('blue')
    await page.mouse.up()
    await page.waitForTimeout(300)
    assert.equal(await input.inputValue(), 'blue')
    assert.deepEqual(await page.evaluate(() => window.tagFixture.accepted), [])
  }
])

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const results = []
  try {
    for (const [name, run] of cases) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(url)
      await capture(page)
      const input = page.getByPlaceholder('첫 번째 태그 입력')
      const cdp = await page.context().newCDPSession(page)
      try {
        const detail = await run({ page, input, cdp })
        assert.deepEqual(errors, [])
        results.push({ name, pass: true, detail })
      } catch (error) {
        results.push({ name, pass: false, error: error.message, errors })
        await page.screenshot({ path: `${out}/failure-${results.length}.png` })
      }
      results.at(-1).events = await page.evaluate(() => window.tagClickEvents)
      await page.close()
    }
  } finally {
    await browser.close()
  }
  fs.writeFileSync(
    `${out}/${process.env.NAIS_QA_LABEL || 'results'}.json`,
    JSON.stringify(results, null, 2)
  )
  console.log(results.map(({ events, ...result }) => result))
  if (results.some((result) => !result.pass)) process.exitCode = 1
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
