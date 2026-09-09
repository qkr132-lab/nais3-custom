/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Fail packaging without printing matched credentials or personal data.
const path = require('node:path')
const asar = require('@electron/asar')

const resources = new Set([
  'icon.png',
  'qwen35_tokenizer.def',
  't5_tokenizer.json',
  'tag-search-manifest.json',
  'tag-search.sqlite',
  'tag-wiki.json',
  'tags-ko.json',
  'tags.json'
])
const rootFiles = new Set([
  'package.json',
  'LICENSE',
  'NOTICE-tag-search.md',
  'NOTICE-tag-wiki.md',
  'NOTICE-tokenizers.md'
])
function allowedFile(file) {
  if (
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|nais3\.db(?:-wal|-shm)?|credentials[^/]*|id_rsa|id_ed25519)$/i.test(
      file
    )
  )
    return false
  if (rootFiles.has(file) || file.startsWith('node_modules/')) return true
  if (file.startsWith('resources/')) return resources.has(file.slice('resources/'.length))
  return (
    /^out\/main\/(?:index|nai-token-worker|tag-search-worker)\.js$/.test(file) ||
    /^out\/main\/chunks\/[\w-]+\.js$/.test(file) ||
    file === 'out/preload/index.js' ||
    file === 'out/renderer/index.html' ||
    /^out\/renderer\/assets\/[\w.-]+\.(?:js|css|woff2)$/.test(file)
  )
}
const rules = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  githubToken: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  apiToken: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{30,}/,
  jwt: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
  awsAccess: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  credentialLiteral:
    /(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*['"][A-Za-z0-9_+/=.-]{24,}['"]/i
}
function credentialFindings(text) {
  return Object.entries(rules)
    .filter(([, rule]) => rule.test(text))
    .map(([name]) => name)
}
function auditPackage(archive) {
  let checked = 0
  const failures = []
  for (const entry of asar.listPackage(archive)) {
    const file = entry.replace(/\\/g, '/').replace(/^\//, '')
    const info = asar.statFile(archive, path.normalize(file))
    if (info.files) continue
    if (!allowedFile(file)) {
      failures.push(`${file}: unexpected release file`)
      continue
    }
    if (info.link) continue
    if (/\.(?:js|mjs|cjs|json|html|css|ya?ml)$/.test(file)) {
      const data = asar.extractFile(archive, path.normalize(file)).toString('utf8')
      for (const rule of credentialFindings(data)) failures.push(`${file}: ${rule}`)
    }
    checked++
  }
  if (failures.length)
    throw new Error(`Release privacy check failed (values redacted):\n${failures.join('\n')}`)
  console.log(
    `Release privacy check passed: ${checked} files, explicit application inputs, no credential-pattern matches.`
  )
  return checked
}
module.exports = async (context) => {
  const resourceDir =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources')
  auditPackage(path.join(resourceDir, 'app.asar'))
}
module.exports.auditPackage = auditPackage
module.exports.allowedFile = allowedFile
module.exports.credentialFindings = credentialFindings
