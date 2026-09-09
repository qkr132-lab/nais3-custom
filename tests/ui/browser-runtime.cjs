const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { chromium } = require(process.env.NAIS_PLAYWRIGHT_MODULE || 'playwright')

function launchBrowser() {
  let executablePath = process.env.NAIS_BROWSER_EXECUTABLE
  if (!executablePath && process.platform === 'win32') {
    const chrome = join(
      process.env.ProgramFiles || 'C:/Program Files',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    )
    if (existsSync(chrome)) executablePath = chrome
  }
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  })
}

module.exports = { launchBrowser }
