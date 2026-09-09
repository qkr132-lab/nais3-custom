const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Separate browser/page state from the existing completion and real-dictionary QA.
const out = '.superloopy/evidence/frontend/tag-enter'
const url = process.env.NAIS_UI_QA_URL || 'http://127.0.0.1:5189/tag-completion.html'
const korean = '심백안'
const cases = []

const accepted = (page) => page.evaluate(() => window.tagFixture.accepted)
const valueIs = async (page, text) => {
  await page.waitForFunction(
    (expected) => document.querySelector('textarea').value === expected,
    text
  )
}
const searchStarted = (page, query) =>
  page.waitForFunction((q) => window.tagFixture.requests.includes(q), query)
const noLateInsertion = async (page, input, text) => {
  await page.waitForTimeout(850)
  assert.equal(await input.inputValue(), text)
  assert.deepEqual(await accepted(page), [])
}
const captureInput = async (input) => {
  await input.evaluate((el) => {
    window.enterEvents = []
    for (const type of [
      'keydown',
      'keyup',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input'
    ]) {
      el.addEventListener(type, (event) => {
        const entry = {
          type,
          key: event.key,
          code: event.code,
          keyCode: event.keyCode,
          composing: event.isComposing,
          inputType: event.inputType,
          data: event.data,
          value: el.value,
          prevented: event.defaultPrevented
        }
        window.enterEvents.push(entry)
        // React delegated handlers run after this listener.
        queueMicrotask(() => {
          entry.prevented = event.defaultPrevented
        })
      })
    }
  })
}
const compose = async (page, input) => {
  await input.focus()
  await captureInput(input)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: korean,
    selectionStart: korean.length,
    selectionEnd: korean.length
  })
  return cdp
}
const enterUp = (cdp) =>
  cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
const assertNoImeNewline = async (page) => {
  const events = await page.evaluate(() => window.enterEvents)
  assert(events.some((e) => e.type === 'compositionstart'), 'native composition started')
  assert(events.some((e) => e.type === 'compositionend'), 'native composition committed')
  assert(
    !events.some(
      (e) =>
        (e.type === 'input' && /[\r\n]/.test(e.value)) ||
        (e.type === 'input' && ['insertLineBreak', 'insertParagraph'].includes(e.inputType)) ||
        (e.type === 'beforeinput' &&
          ['insertLineBreak', 'insertParagraph'].includes(e.inputType) &&
          !e.prevented)
    ),
    'IME Enter must not perform a default newline before or after completion'
  )
  return events
}

cases.push([
  'immediate Enter flushes the debounce and accepts once',
  async ({ page, input }) => {
    await input.fill('sm')
    assert.deepEqual(await page.evaluate(() => window.tagFixture.requests), [])
    await input.press('Enter')
    await valueIs(page, 'smile, ')
    assert.deepEqual(await accepted(page), ['smile'])
    assert.deepEqual(await page.evaluate(() => window.tagFixture.requests), ['sm'])
    await input.press('Control+z')
    assert.equal(await input.inputValue(), 'sm')
  }
])

cases.push([
  'Enter during an in-flight slow search accepts its current result',
  async ({ page, input }) => {
    await input.fill('slow')
    await searchStarted(page, 'slow')
    await input.press('Enter')
    assert.equal(await input.inputValue(), 'slow')
    await valueIs(page, 'smile, ')
    assert.deepEqual(await accepted(page), ['smile'])
  }
])

cases.push([
  'repeated Enter while pending produces one insertion and no newline',
  async ({ page, input }) => {
    await page.evaluate(() => (window.tagFixture.delay = 500))
    await input.fill('sm')
    await input.press('Enter')
    await input.press('Enter')
    await input.press('Enter')
    await valueIs(page, 'smile, ')
    await page.waitForTimeout(180)
    assert.equal(await input.inputValue(), 'smile, ')
    assert.deepEqual(await accepted(page), ['smile'])
  }
])

cases.push([
  'immediate Enter after native compositionend accepts without a second key',
  async ({ page, input }) => {
    const cdp = await compose(page, input)
    await cdp.send('Input.insertText', { text: korean })
    await input.press('Enter')
    await valueIs(page, 'smile, ')
    assert.deepEqual(await accepted(page), ['smile'])
    return { events: await assertNoImeNewline(page) }
  }
])

for (const delay of [0, 350]) {
  cases.push([
    `Windows Process/229 + Enter code commits and accepts once (search delay ${delay}ms)`,
    async ({ page, input }) => {
      await page.evaluate((ms) => (window.tagFixture.delay = ms), delay)
      const cdp = await compose(page, input)
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Process',
        code: 'Enter',
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229
      })
      // CDP key dispatch does not implement an OS IME. This native commit emits
      // compositionupdate -> beforeinput/input -> compositionend in Chromium.
      await cdp.send('Input.insertText', { text: korean })
      await enterUp(cdp)
      await valueIs(page, 'smile, ')
      await page.waitForTimeout(160)
      assert.equal(await input.inputValue(), 'smile, ')
      assert.deepEqual(await accepted(page), ['smile'])
      const events = await assertNoImeNewline(page)
      assert(
        events.some(
          (e) =>
            e.type === 'keydown' && e.code === 'Enter' && e.keyCode === 229 && e.composing
        )
      )
      await input.press('Control+z')
      assert.equal(await input.inputValue(), korean)
      return { events }
    }
  ])
}

cases.push([
  'IME Enter with native newline text does not insert a line break',
  async ({ page, input }) => {
    const cdp = await compose(page, input)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r'
    })
    assert.equal(await input.inputValue(), korean)
    await cdp.send('Input.insertText', { text: korean })
    await enterUp(cdp)
    await valueIs(page, 'smile, ')
    assert.deepEqual(await accepted(page), ['smile'])
    return { events: await assertNoImeNewline(page) }
  }
])

cases.push([
  'Shift+Enter remains a newline during search',
  async ({ page, input }) => {
    await input.fill('slow')
    await input.press('Shift+Enter')
    await noLateInsertion(page, input, 'slow\n')
  }
])

cases.push([
  'typing after pending Enter cancels automatic acceptance',
  async ({ page, input }) => {
    await input.fill('slow')
    await input.press('Enter')
    await input.press('x')
    await noLateInsertion(page, input, 'slowx')
  }
])

cases.push([
  'cursor movement after pending Enter cancels automatic acceptance',
  async ({ page, input }) => {
    await input.fill('slow')
    await input.press('Enter')
    await input.press('ArrowLeft')
    await noLateInsertion(page, input, 'slow')
    assert.equal(await input.evaluate((el) => el.selectionStart), 3)
  }
])

cases.push([
  'outside click after pending Enter cancels automatic acceptance',
  async ({ page, input }) => {
    await input.fill('slow')
    await input.press('Enter')
    await page.getByTestId('outside').click()
    await noLateInsertion(page, input, 'slow')
    assert.equal(await page.locator('[data-tag-popup]').count(), 0)
  }
])

cases.push([
  'Escape after pending Enter cancels automatic acceptance',
  async ({ page, input }) => {
    await input.fill('slow')
    await input.press('Enter')
    await input.press('Escape')
    await noLateInsertion(page, input, 'slow')
    assert.equal(await page.locator('[data-tag-popup]').count(), 0)
  }
])

cases.push([
  'a changed query cannot receive an older pending result',
  async ({ page, input }) => {
    await input.fill('slow')
    await input.press('Enter')
    await input.fill('blue')
    await noLateInsertion(page, input, 'blue')
    await input.press('Enter')
    await valueIs(page, 'blue eyes, ')
    assert.deepEqual(await accepted(page), ['blue eyes'])
  }
])

cases.push([
  'an unknown query never automatically inserts an unrelated history entry',
  async ({ page, input }) => {
    await page.evaluate(() => {
      window.realTagInvoke = async (channel, args) => {
        if (channel === 'tags:recordUse') {
          window.tagFixture.accepted.push(args.tag)
          return
        }
        if (channel === 'tags:search') {
          window.tagFixture.requests.push(args.query)
          await new Promise((resolve) => setTimeout(resolve, 250))
          return {
            items: [
              {
                tag: 'smile',
                ko: '미소',
                count: 80000,
                type: 'general',
                match: 'history',
                usageCount: 10,
                lastUsed: Date.now()
              }
            ]
          }
        }
        throw new Error(`Unexpected QA channel: ${channel}`)
      }
    })
    await input.fill('zzzz')
    await input.press('Enter')
    await noLateInsertion(page, input, 'zzzz')
    // Also verify Enter after history becomes visible does not choose it by default.
    await input.press('Enter')
    assert(!/smile/.test(await input.inputValue()))
    assert.deepEqual(await accepted(page), [])
  }
])

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const results = []
  try {
    for (const [name, test] of cases) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
      page.setDefaultTimeout(3500)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.goto(url)
        const input = page.getByPlaceholder('첫 번째 태그 입력')
        await input.waitFor()
        const detail = await test({ page, input })
        assert.deepEqual(errors, [])
        results.push({ name, passed: true, ...detail })
        console.log(`PASS ${name}`)
      } catch (error) {
        const screenshot = path.join(out, `failure-${results.length + 1}.png`)
        await page.screenshot({ path: screenshot }).catch(() => {})
        const state = await page
          .evaluate(() => ({
            value: document.querySelector('textarea')?.value,
            fixture: window.tagFixture,
            events: window.enterEvents
          }))
          .catch(() => null)
        results.push({ name, passed: false, error: error.message, errors, state, screenshot })
        console.error(`FAIL ${name}: ${error.message}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  const passed = results.filter((r) => r.passed).length
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify({ passed, total: results.length, results }, null, 2)
  )
  console.log(`${passed}/${results.length} Enter regression cases passed`)
  if (passed !== results.length) process.exitCode = 1
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
