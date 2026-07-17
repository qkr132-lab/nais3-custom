const packageVersion = require('../../package.json').version
const tagVersion = String(process.env.GITHUB_REF_NAME || '').replace(/^v/, '')

if (!tagVersion || tagVersion !== packageVersion) {
  console.error(
    `Release tag/version mismatch: tag=${tagVersion || '(empty)'}, package=${packageVersion}`
  )
  process.exit(1)
}

console.log(`Release version verified: ${packageVersion}`)
