const { launchBrowser } = require('./browser-runtime.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const out = '.superloopy/evidence/frontend/character-folders'

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await launchBrowser()
  const results = []
  try {
    for (const width of [390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 850 } })
      page.setDefaultTimeout(5000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.goto('http://127.0.0.1:5189/character-folders.html')
        const parent = page.locator('[data-folder-id="1"]')
        const create = parent.getByRole('button', {
          name: '기본 캐릭터 안에 하위 폴더 만들기',
          exact: true
        })
        await create.waitFor()
        assert.equal(await create.evaluate((el) => Number(getComputedStyle(el).opacity)), 1)
        // Moving slightly over the button must not start dragging the whole folder.
        const box = await create.boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + 7, box.y + box.height / 2)
        await page.mouse.up()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('textbox').fill('직접 만든 하위 폴더')
        await dialog.getByRole('button', { name: '확인', exact: true }).click()
        const child = page.locator('[data-folder-id="3"]')
        await child.waitFor()
        const persisted = await page.evaluate(() => window.folderFixture.state.folders)
        assert.equal(persisted.find((f) => f.id === 3).parentId, 1)
        assert.equal(persisted.find((f) => f.id === 1).collapsed, false)
        assert.equal(await child.getByRole('button', { name: /하위 폴더 만들기/ }).count(), 0)
        assert.ok((await child.boundingBox()).x > (await parent.boundingBox()).x)
        const unwanted = await page.evaluate(() =>
          window.folderFixture.state.calls.filter((call) => /reorder|SetParent/.test(call.channel))
        )
        assert.deepEqual(unwanted, [])
        results.push(
          `${width}: direct nested creation opens parent, preserves hierarchy, no accidental drag`
        )

        await page.evaluate(() => window.folderFixture.reload())
        await child.waitFor()
        results.push(`${width}: nested folder remains after reloading persisted state`)
        await create.click()
        await dialog.getByRole('button', { name: '취소', exact: true }).click()
        assert.equal(await page.locator('[data-folder-row]').count(), 3)
        results.push(`${width}: cancel creates nothing`)

        await page.getByPlaceholder('이름·프롬프트 검색').fill('없는 검색어')
        await page.getByRole('button', { name: '폴더', exact: true }).click()
        await dialog.getByRole('textbox').fill('새 최상위 폴더')
        await dialog.getByRole('textbox').press('Enter')
        await page.locator('[data-folder-id="4"]').waitFor()
        assert.equal(await page.getByPlaceholder('이름·프롬프트 검색').inputValue(), '')
        assert.equal(
          await page.evaluate(
            () => window.folderFixture.state.folders.find((f) => f.id === 4).parentId
          ),
          null
        )
        results.push(`${width}: root creation clears search and reveals the new folder`)

        await page.evaluate(() => {
          window.folderFixture.state.failNext = true
        })
        await create.click()
        await dialog.getByRole('textbox').fill('실패 폴더')
        await dialog.getByRole('textbox').press('Enter')
        await page.getByText('저장 실패 검증', { exact: true }).waitFor()
        assert.equal(await page.locator('[data-folder-row]').count(), 4)
        results.push(`${width}: failed save shows error and adds no phantom folder`)
        await page
          .getByText('저장 실패 검증', { exact: true })
          .locator('..')
          .getByRole('button')
          .click()
        await page.getByText('저장 실패 검증', { exact: true }).waitFor({ state: 'hidden' })

        await page.mouse.move(0, 0)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        await page.screenshot({ path: `${out}/${width}-light.png`, fullPage: true })
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'dark'
          document.documentElement.classList.add('dark')
        })
        await page.waitForTimeout(250)
        await page.screenshot({ path: `${out}/${width}-dark.png`, fullPage: true })
        assert.deepEqual(errors, [])
      } catch (error) {
        await page.screenshot({ path: `${out}/${width}-failure.png`, fullPage: true })
        throw new Error(`${width}px: ${error.message}; browser errors: ${errors.join(', ')}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  fs.writeFileSync(
    `${out}/report.json`,
    JSON.stringify({ passed: results.length, results }, null, 2)
  )
  console.log(JSON.stringify({ passed: results.length, results }, null, 2))
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
