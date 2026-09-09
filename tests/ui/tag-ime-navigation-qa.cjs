const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const out = '.superloopy/evidence/frontend/tag-ime-navigation'
const url = process.env.NAIS_UI_QA_URL || 'http://127.0.0.1:5189/tag-completion.html'
const ready = (page) =>
  page.waitForFunction(
    () => document.querySelector('[role=listbox]')?.getAttribute('aria-busy') === 'false'
  )

async function key(cdp, code, composing = false) {
  const number = { ArrowDown: 40, ArrowUp: 38, Enter: 13 }[code]
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: composing ? 'Process' : code,
    code,
    windowsVirtualKeyCode: composing ? 229 : number,
    nativeVirtualKeyCode: composing ? 229 : number
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: code,
    code,
    windowsVirtualKeyCode: number,
    nativeVirtualKeyCode: number
  })
}

const scenarios = [
  { name: 'First Down selects the first row and preserves 아헤', arrows: ['ArrowDown'], index: 0 },
  { name: 'Second Down selects the second row', arrows: ['ArrowDown', 'ArrowDown'], index: 1 },
  { name: 'Up then native commit preserves 아헤', arrows: ['ArrowUp'], index: 9 },
  {
    name: 'Repeated arrows keep composition and selected candidate',
    arrows: ['ArrowDown', 'ArrowDown', 'ArrowUp'],
    index: 0
  },
  {
    name: 'Enter during composition accepts the arrow selection once',
    arrows: ['ArrowDown'],
    index: 0,
    enterBeforeCommit: true
  },
  {
    name: 'Middle Korean query keeps following tag after IME navigation',
    arrows: ['ArrowUp'],
    index: 9,
    middle: true,
    enterBeforeCommit: true
  },
  {
    name: 'Editing the composing syllable clears the previous arrow choice',
    arrows: ['ArrowDown'],
    index: 0,
    revise: true
  },
  {
    name: 'One click after IME arrow navigation accepts the clicked row',
    arrows: ['ArrowUp'],
    index: 9,
    click: true
  }
]

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const results = []
  try {
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
      page.setDefaultTimeout(4000)
      try {
        await page.goto(url)
        const input = page.getByPlaceholder('첫 번째 태그 입력')
        await input.fill(scenario.middle ? 'full body, warrior (dq3) (cosplay), blue eyes' : '')
        await input.press('Escape')
        const prefix = scenario.middle ? 'full body, ' : ''
        const suffix = scenario.middle ? 'warrior (dq3) (cosplay), blue eyes' : ''
        await input.evaluate((el, cursor) => {
          el.focus()
          el.setSelectionRange(cursor, cursor)
          window.imeEvents = []
          for (const type of [
            'blur',
            'focus',
            'compositionstart',
            'compositionend',
            'beforeinput',
            'input'
          ]) {
            el.addEventListener(type, (event) =>
              window.imeEvents.push({ type, data: event.data, value: el.value })
            )
          }
        }, prefix.length)
        // Korean IMEs commit earlier syllables and keep only the last syllable active.
        await page.keyboard.insertText('아')
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.imeSetComposition', {
          text: '헤',
          selectionStart: 1,
          selectionEnd: 1
        })
        await ready(page)
        const expectedId = await page.getByRole('option').nth(scenario.index).getAttribute('id')
        for (const arrow of scenario.arrows) await key(cdp, arrow, true)
        assert.equal(await input.getAttribute('aria-activedescendant'), expectedId)
        assert.equal(
          await page.evaluate(() => window.imeEvents.some((event) => event.type === 'blur')),
          false
        )
        let syllable = '헤'
        if (scenario.revise) {
          syllable = '헬'
          await cdp.send('Input.imeSetComposition', {
            text: syllable,
            selectionStart: 1,
            selectionEnd: 1
          })
          await ready(page)
          assert.equal(
            await input.getAttribute('aria-activedescendant'),
            await page.getByRole('option').first().getAttribute('id')
          )
        }
        if (scenario.enterBeforeCommit) await key(cdp, 'Enter', true)
        // Deliver the IME's queued commit even if application code blurred the field.
        if (scenario.click) {
          await page.getByRole('option').nth(scenario.index).click()
        } else {
          await cdp.send('Input.insertText', { text: syllable })
          if (!scenario.enterBeforeCommit) {
            assert.equal(await input.inputValue(), `${prefix}아${syllable}${suffix}`)
            await ready(page)
            if (!scenario.revise)
              assert.equal(await input.getAttribute('aria-activedescendant'), expectedId)
            await input.press('Enter')
          }
        }
        const tag =
          scenario.revise || scenario.index === 0
            ? 'smile'
            : scenario.index === 1
              ? 'smirk'
              : 'short hair'
        const expected = `${prefix}${tag}, ${suffix}`
        await page.waitForFunction(
          (value) => document.querySelector('textarea')?.value === value,
          expected
        )
        assert.deepEqual(await page.evaluate(() => window.tagFixture.accepted), [tag])
        if (!scenario.click)
          assert.equal(
            await page.evaluate(
              () => window.imeEvents.filter((event) => event.type === 'blur').length
            ),
            0
          )
        await input.press('Control+z')
        assert.equal(await input.inputValue(), `${prefix}아${syllable}${suffix}`)
        // A later IME session still updates the restored query normally.
        // Native undo selects the restored span; collapse it before appending.
        await input.press('ArrowRight')
        await cdp.send('Input.imeSetComposition', {
          text: '가',
          selectionStart: 1,
          selectionEnd: 1
        })
        await cdp.send('Input.insertText', { text: '가' })
        assert.equal(await input.inputValue(), `${prefix}아${syllable}가${suffix}`)
        results.push({ name: scenario.name, passed: true })
        console.log(`PASS ${scenario.name}`)
      } catch (error) {
        const state = await page.evaluate(() => ({
          value: document.querySelector('textarea')?.value,
          events: window.imeEvents
        }))
        results.push({ name: scenario.name, passed: false, error: error.message, state })
        console.error(`FAIL ${scenario.name}: ${error.message}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 2))
  const passed = results.filter((result) => result.passed).length
  console.log(`${passed}/${results.length} Korean IME arrow navigation cases passed`)
  if (passed !== results.length) process.exitCode = 1
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
