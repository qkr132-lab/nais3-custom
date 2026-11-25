// 폰 화면 빌드 — cloud/web → cloud/public (워커가 정적 자산으로 내보낼 폴더)
//   node cloud/scripts/build-web.mjs
// esbuild 는 앱 루트의 node_modules 것을 쓴다 (cloud/ 에는 따로 설치하지 않음).
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { iconPng, iconSvg } from '../web/tools/png.mjs'

const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDir = path.join(cloudDir, 'web')
const publicDir = path.join(cloudDir, 'public')
const assetsDir = path.join(publicDir, 'assets')
const sharedDir = path.resolve(cloudDir, '..', 'src', 'shared')

/** 번들(js+css) 합계 gzip 목표 — 설계 10절 */
const GZIP_BUDGET = 60 * 1024

const gzipSize = (buf) => gzipSync(buf, { level: 9 }).length
const kb = (n) => `${(n / 1024).toFixed(1)}KB`

// 이전 결과의 번들만 지운다 (public 의 다른 파일은 건드리지 않는다)
rmSync(assetsDir, { recursive: true, force: true })
mkdirSync(assetsDir, { recursive: true })

await build({
  entryPoints: { app: path.join(webDir, 'main.tsx') },
  outdir: assetsDir,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'chrome90', 'safari14', 'firefox90'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  tsconfig: path.join(cloudDir, 'tsconfig.web.json'),
  alias: { '@shared': sharedDir },
  legalComments: 'none',
  logLevel: 'warning'
})

const js = readFileSync(path.join(assetsDir, 'app.js'))
const css = readFileSync(path.join(assetsDir, 'app.css'))
const build_id = createHash('sha1').update(js).update(css).digest('hex').slice(0, 10)

// index.html — 번들 주소에 내용 해시를 붙여 갱신이 바로 보이게
const html = readFileSync(path.join(webDir, 'index.html'), 'utf8').replaceAll('__BUILD__', build_id)
writeFileSync(path.join(publicDir, 'index.html'), html)

copyFileSync(
  path.join(webDir, 'manifest.webmanifest'),
  path.join(publicDir, 'manifest.webmanifest')
)

// 아이콘 — SVG 와 192/512 PNG (같은 도형에서 만든다)
writeFileSync(path.join(publicDir, 'icon.svg'), iconSvg())
writeFileSync(path.join(publicDir, 'icon-192.png'), iconPng(192))
writeFileSync(path.join(publicDir, 'icon-512.png'), iconPng(512))

const jsGz = gzipSize(js)
const cssGz = gzipSize(css)
const htmlGz = gzipSize(Buffer.from(html))
const total = jsGz + cssGz + htmlGz
console.log(`app.js   ${kb(js.length)} (gzip ${kb(jsGz)})`)
console.log(`app.css  ${kb(css.length)} (gzip ${kb(cssGz)})`)
console.log(`index    ${kb(html.length)} (gzip ${kb(htmlGz)})`)
console.log(`합계 gzip ${kb(total)} / 목표 ${kb(GZIP_BUDGET)}`)
console.log(`빌드 ${build_id} → ${path.relative(process.cwd(), publicDir) || publicDir}`)
if (total > GZIP_BUDGET) {
  console.warn('경고: gzip 합계가 목표(60KB)를 넘었습니다')
  process.exitCode = 0
}
