const { launchBrowser } = require('./browser-runtime.cjs')
const { spawn } = require('node:child_process')
const { resolve } = require('node:path')
const readline = require('node:readline')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = '.superloopy/evidence/frontend/korean-search'
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const child = spawn(
    require('electron'),
    [resolve('tests/tag-worker-bridge.cjs')],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const pending = new Map()
  let id = 0
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line),
      j = pending.get(m.id)
    if (!j) return
    pending.delete(m.id)
    m.error ? j.reject(new Error(m.error)) : j.resolve(m.result)
  })
  const stderr = []
  child.stderr.on('data', (b) => stderr.push(b.toString()))
  const bridge = (channel, req) =>
    new Promise((resolve, reject) => {
      const key = ++id
      pending.set(key, { resolve, reject })
      child.stdin.write(JSON.stringify({ id: key, channel, req }) + '\n')
    })
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  page.setDefaultTimeout(10000)
  const errors = [],
    passed = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.exposeFunction('realTagInvoke', bridge)
  const popup = page.locator('[data-tag-popup]')
  const ready = async () => {
    await page.waitForFunction(
      () => document.querySelector('[role=listbox]')?.getAttribute('aria-busy') === 'false'
    )
    await popup.getByRole('option').first().waitFor()
    await page.waitForTimeout(170)
  }
  try {
    await page.goto('http://127.0.0.1:5189/tag-completion.html')
    const input = page.getByPlaceholder('첫 번째 태그 입력')
    await input.fill('ㅈ')
    await ready()
    assert((await popup.innerText()).includes('full body'))
    await page.screenshot({ path: out + '/initials.png' })
    passed.push('single initial shows full body with a natural Korean label')
    await input.fill('에너르기파')
    await ready()
    assert(
      (await popup.getByRole('option').first().innerText()).includes('kamehameha (dragon ball)')
    )
    await page.screenshot({ path: out + '/kamehameha.png' })
    await input.press('Enter')
    assert.equal(await input.inputValue(), 'kamehameha (dragon ball), ')
    await input.press('Control+z')
    assert.equal(await input.inputValue(), '에너르기파')
    await input.press('Escape')
    await input.fill('')
    passed.push('Korean alternate spelling → canonical tag, Enter and native undo')
    await input.fill('심백안')
    await input.press('Enter')
    await page.waitForFunction(() => document.querySelector('textarea')?.value === 'sanpaku, ')
    passed.push('immediate Enter on the reported Korean typo resolves the real sanpaku tag')
    await input.fill('')
    await input.dispatchEvent('compositionstart')
    await input.fill('전ㅅ')
    await ready()
    assert((await popup.getByRole('option').first().innerText()).includes('full body'))
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      isComposing: true
    })
    assert.equal(await input.inputValue(), '전ㅅ')
    await input.fill('전신')
    await input.dispatchEvent('compositionend', { data: '신' })
    await input.dispatchEvent('keyup', { key: 'Enter', code: 'Enter' })
    await page.waitForFunction(() => document.querySelector('textarea')?.value === 'full body, ')
    assert.equal(await input.inputValue(), 'full body, ')
    passed.push('live incomplete Hangul suggestions; one IME Enter commits and inserts')
    await input.fill('눈 감은')
    await ready()
    assert((await popup.getByRole('option').first().innerText()).includes('closed eyes'))
    await popup.getByRole('option').first().click()
    assert.equal(await input.inputValue(), 'closed eyes, ')
    passed.push('natural Korean phrase and pointer insertion')
    await input.fill('warrior (dq3) (cosplay)')
    await input.press('Escape')
    await input.evaluate((el) => el.setSelectionRange(0, 0))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', {
      text: '복근', selectionStart: 2, selectionEnd: 2
    })
    await ready()
    assert.match(await popup.getByRole('option').first().innerText(), /^abs\s/)
    await popup.getByRole('option').first().click()
    assert.equal(await input.inputValue(), 'abs, warrior (dq3) (cosplay)')
    await input.press('Control+z')
    assert.equal(await input.inputValue(), '복근warrior (dq3) (cosplay)')
    await cdp.detach()
    passed.push('real abs lookup and native IME click preserve the adjacent warrior cosplay tag')
    await input.fill('에너지 구체')
    await ready()
    assert((await popup.getByRole('option').first().innerText()).includes('energy ball'))
    assert((await popup.innerText()).includes('최근·자주'))
    assert.equal(await popup.getByRole('tab').count(), 0)
    await page.getByTestId('outside').click()
    assert.equal(await popup.count(), 0)
    passed.push('relevant result then history in one list; outside click dismisses')
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 850 })
      await input.fill('')
      await input.fill('카메하메하')
      await ready()
      const b = await popup.boundingBox()
      assert(b.x >= 0 && b.x + b.width <= width + 1)
      await page.screenshot({ path: out + `/search-${width}.png` })
      await input.press('Escape')
    }
    passed.push('real-data popup fits 390, 768 and 1280 widths')
    await page.setViewportSize({ width: 1280, height: 850 })
    await page.goto('http://127.0.0.1:5189/placement.html?mode=addition&tags=1')
    await page.getByRole('button', { name: '넓게 배치', exact: true }).click()
    const dialog = page.getByRole('dialog').last()
    await dialog.getByRole('button', { name: /, X / }).first().click()
    const ta = dialog.locator('textarea').first()
    await ta.fill('카메하메하')
    await ready()
    await page.screenshot({ path: out + '/nested-placement.png' })
    await popup.getByRole('option').first().click()
    assert.equal(await ta.inputValue(), 'kamehameha (dragon ball), ')
    assert.equal(await page.getByRole('dialog', { includeHidden: true }).count(), 2)
    await ta.fill('전ㅅ')
    await ready()
    await ta.press('Enter')
    assert.equal(await ta.inputValue(), 'full body, ')
    passed.push('real dictionary click and Enter inside nested enlarged scene placement')
    assert.deepEqual(errors, [])
    assert.deepEqual(stderr, [])
    fs.writeFileSync(out + '/ui-report.json', JSON.stringify({ passed, errors, stderr }, null, 2))
    console.log(JSON.stringify({ passed, errors }, null, 2))
  } catch (e) {
    console.error('Passed before failure', passed)
    await page.screenshot({ path: out + '/failure.png' })
    throw e
  } finally {
    await browser.close()
    child.stdin.end()
    child.kill()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
