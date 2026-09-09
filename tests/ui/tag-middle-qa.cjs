const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const out = '.superloopy/evidence/frontend/tag-middle'
const url = process.env.NAIS_UI_QA_URL || 'http://127.0.0.1:5189/tag-completion.html'
const cases = []
const accepted = (page) => page.evaluate(() => window.tagFixture.accepted)
const valueIs = (page, text) =>
  page.waitForFunction((expected) => document.querySelector('textarea')?.value === expected, text)
const ready = async (page) => {
  await page.waitForFunction(
    () => document.querySelector('[role=listbox]')?.getAttribute('aria-busy') === 'false'
  )
  await page.locator('[data-tag-popup]').getByRole('option').first().waitFor()
}
const position = async (input, initial, cursor, end = cursor) => {
  await input.fill(initial)
  await input.press('Escape')
  await input.evaluate(
    (el, selection) => {
      el.focus()
      el.setSelectionRange(selection.cursor, selection.end)
    },
    { cursor, end }
  )
}

const insertionCases = [
  {
    name: 'insert at start without a new comma before the existing first tag',
    initial: 'full body, standing',
    cursor: 0,
    query: '웃는',
    expected: 'smile, full body, standing'
  },
  {
    name: 'insert in an explicit empty middle slot',
    initial: 'full body, standing, , blue eyes',
    cursor: 'full body, standing, '.length,
    query: '웃는',
    expected: 'full body, standing, smile, blue eyes'
  },
  {
    name: 'insert immediately before an existing middle tag without adding a comma',
    initial: 'full body, standing, blue eyes',
    cursor: 'full body, standing, '.length,
    query: '웃는',
    expected: 'full body, standing, smile, blue eyes'
  },
  {
    name: 'insert immediately after an existing middle tag without adding a comma',
    initial: 'full body, standing, blue eyes',
    cursor: 'full body, standing'.length,
    query: '웃는',
    expected: 'full body, standing, smile, blue eyes'
  },
  {
    name: 'English insertion before an existing tag also preserves it',
    initial: 'full body, standing, blue eyes',
    cursor: 'full body, standing, '.length,
    query: 'sm',
    expected: 'full body, standing, smile, blue eyes'
  },
  {
    name: 'English insertion after an existing tag also preserves it',
    initial: 'full body, standing, blue eyes',
    cursor: 'full body, standing'.length,
    query: 'sm',
    expected: 'full body, standing, smile, blue eyes'
  },
  {
    name: 'insert at end after an existing tag without adding a comma',
    initial: 'full body, standing',
    cursor: 'full body, standing'.length,
    query: '웃는',
    expected: 'full body, standing, smile, '
  },
  {
    name: 'insert at end after a pre-existing separator',
    initial: 'full body, standing, ',
    cursor: 'full body, standing, '.length,
    query: '웃는',
    expected: 'full body, standing, smile, '
  },
  {
    name: 'replace an explicitly selected middle tag without affecting its neighbors',
    initial: 'full body, standing, blue eyes',
    cursor: 'full body, '.length,
    end: 'full body, standing'.length,
    query: '웃는',
    expected: 'full body, smile, blue eyes'
  },
  {
    name: 'preserve numeric weight and source role around the inserted query',
    initial: 'full body, 1.5::source#::, blue eyes',
    cursor: 'full body, 1.5::source#'.length,
    query: '웃는',
    expected: 'full body, 1.5::source#smile::, blue eyes'
  },
  {
    name: 'preserve brace weight and target role around the inserted query',
    initial: 'full body, {{target#}}, blue eyes',
    cursor: 'full body, {{target#'.length,
    query: '웃는',
    expected: 'full body, {{target#smile}}, blue eyes'
  },
  {
    name: 'preserve source prefix and the existing tag on its right',
    initial: 'full body, source#standing, blue eyes',
    cursor: 'full body, source#'.length,
    query: '웃는',
    expected: 'full body, source#smile, standing, blue eyes'
  }
]

for (const test of insertionCases) {
  cases.push([
    test.name,
    async ({ page, input }) => {
      await position(input, test.initial, test.cursor, test.end)
      await page.keyboard.insertText(test.query)
      const typed = await input.inputValue()
      await ready(page)
      assert.equal(
        await page.evaluate(() => window.tagFixture.requests.at(-1)),
        test.query,
        'search only the newly typed query, excluding existing adjacent tags'
      )
      await input.press('Enter')
      await valueIs(page, test.expected)
      assert.deepEqual(await accepted(page), ['smile'])
      await input.press('Control+z')
      assert.equal(await input.inputValue(), typed, 'native undo restores only the completion edit')
    }
  ])
}

cases.push([
  'user reproduction: insert abs before warrior (dq3) (cosplay) without deleting it',
  async ({ page, input }) => {
    await page.evaluate(() => {
      const invoke = window.nais.invoke
      window.nais.invoke = async (channel, args) => {
        if (channel === 'tags:search' && args.query === '복근') {
          window.tagFixture.requests.push(args.query)
          return {
            items: [{ tag: 'abs', ko: '복근', count: 10000, type: 'general', match: 'exact' }]
          }
        }
        return invoke(channel, args)
      }
    })
    await position(input, 'warrior (dq3) (cosplay)', 0)
    await page.keyboard.insertText('복근')
    const typed = await input.inputValue()
    await ready(page)
    assert.equal(await page.evaluate(() => window.tagFixture.requests.at(-1)), '복근')
    await input.press('Enter')
    await valueIs(page, 'abs, warrior (dq3) (cosplay)')
    assert.deepEqual(await accepted(page), ['abs'])
    await input.press('Control+z')
    assert.equal(await input.inputValue(), typed)
  }
])

cases.push([
  'cursor movement while a middle completion is pending cancels insertion',
  async ({ page, input }) => {
    const initial = 'full body, standing, blue eyes'
    await page.evaluate(() => (window.tagFixture.delay = 450))
    await position(input, initial, 'full body, standing, '.length)
    await page.keyboard.insertText('웃는')
    const typed = await input.inputValue()
    await input.press('Enter')
    await input.press('ArrowLeft')
    await page.waitForTimeout(700)
    assert.equal(await input.inputValue(), typed)
    assert.deepEqual(await accepted(page), [])
  }
])

cases.push([
  'typing a middle query one character at a time retains its full insertion span',
  async ({ page, input }) => {
    await position(input, 'full body, standing, blue eyes', 'full body, standing, '.length)
    await page.keyboard.type('smi', { delay: 40 })
    await input.press('Backspace')
    await ready(page)
    assert.equal(await page.evaluate(() => window.tagFixture.requests.at(-1)), 'sm')
    await input.press('Enter')
    await valueIs(page, 'full body, standing, smile, blue eyes')
    assert.deepEqual(await accepted(page), ['smile'])
  }
])

for (const direction of ['ArrowDown', 'ArrowUp']) {
  cases.push([
    `${direction} navigates ready suggestions during native Korean composition`,
    async ({ page, input }) => {
      const initial = 'full body, standing, blue eyes'
      const cursor = 'full body, standing, '.length
      const korean = '웃는'
      await position(input, initial, cursor)
      await input.evaluate((el) => {
        window.middleComposing = false
        el.addEventListener('compositionstart', () => (window.middleComposing = true))
        el.addEventListener('compositionend', () => (window.middleComposing = false))
      })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.imeSetComposition', {
        text: korean,
        selectionStart: korean.length,
        selectionEnd: korean.length
      })
      await ready(page)
      const before = await input.inputValue()
      const options = page.locator('[data-tag-popup]').getByRole('option')
      const index = direction === 'ArrowDown' ? 1 : (await options.count()) - 1
      const expectedTag = direction === 'ArrowDown' ? 'smirk' : 'short hair'
      const expectedId = await options.nth(index).getAttribute('id')
      const key = direction === 'ArrowDown' ? 40 : 38
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: direction === 'ArrowDown' ? 'Process' : direction,
        code: direction,
        windowsVirtualKeyCode: direction === 'ArrowDown' ? 229 : key,
        nativeVirtualKeyCode: direction === 'ArrowDown' ? 229 : key
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: direction,
        code: direction,
        windowsVirtualKeyCode: key,
        nativeVirtualKeyCode: key
      })
      assert.equal(await input.getAttribute('aria-activedescendant'), expectedId)
      assert.equal(await input.inputValue(), before)
      assert.equal(await input.evaluate((el) => el.selectionStart), cursor + korean.length)

      if (await page.evaluate(() => window.middleComposing)) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Process',
          code: 'Enter',
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode: 229
        })
        await cdp.send('Input.insertText', { text: korean })
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        })
      } else {
        // Navigation may commit the native IME before moving the highlighted row.
        // A real keyboard then sends an ordinary Enter, not a second text commit.
        await input.press('Enter')
      }
      await valueIs(page, `full body, standing, ${expectedTag}, blue eyes`)
      assert.deepEqual(await accepted(page), [expectedTag])
    }
  ])
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const results = []
  try {
    for (const [name, run] of cases) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
      page.setDefaultTimeout(4000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.goto(url)
        const input = page.getByPlaceholder('첫 번째 태그 입력')
        await input.waitFor()
        await run({ page, input })
        assert.deepEqual(errors, [])
        results.push({ name, passed: true })
        console.log(`PASS ${name}`)
      } catch (error) {
        const screenshot = path.join(out, `failure-${results.length + 1}.png`)
        await page.screenshot({ path: screenshot }).catch(() => {})
        const state = await page
          .evaluate(() => ({
            value: document.querySelector('textarea')?.value,
            start: document.querySelector('textarea')?.selectionStart,
            end: document.querySelector('textarea')?.selectionEnd,
            fixture: window.tagFixture
          }))
          .catch(() => null)
        results.push({ name, passed: false, error: error.message, state, errors, screenshot })
        console.error(`FAIL ${name}: ${error.message}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  const passed = results.filter((result) => result.passed).length
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ passed, total: results.length, results }, null, 2)
  )
  console.log(`${passed}/${results.length} middle insertion and IME navigation cases passed`)
  if (passed !== results.length) process.exitCode = 1
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
