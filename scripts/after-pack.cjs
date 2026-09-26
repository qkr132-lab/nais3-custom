/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// afterPack: 1) 이 빌드와 다른 OS·CPU용 onnxruntime 바이너리를 지우고 2) 윈도우면 VC++ 런타임을 곁에 두고
// 3) 개인정보 검사를 돌린다.
//
// onnxruntime-node(자동 검열 탐지 실행기)는 모든 OS 바이너리를 한 패키지에 싣는다.
// GPU 파일은 electron-builder.yml의 files에서 이미 빼지만, 윈도우 빌드의 맥 바이너리(89MB)처럼
// 다른 OS 폴더는 files로 가를 수 없다 — 플랫폼별 files를 쓰면 전체 목록을 덮어써
// 작업 폴더 파일까지 실린다(개인정보 검사가 막음). 그래서 패키징 뒤 여기서 지운다.
//
// 윈도우 onnxruntime은 VC++ 2015-2022 런타임(msvcp140 등)을 쓰는데 윈도우에 기본으로 없다.
// 재배포 가능 파일을 바이너리 옆에 두면 설치 없이 그 폴더에서 먼저 찾는다.
const fs = require('node:fs')
const path = require('node:path')
const audit = require('./audit-release.cjs')

// electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }

function resourceDir(context) {
  return context.electronPlatformName === 'darwin'
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources'
      )
    : path.join(context.appOutDir, 'resources')
}

/** 이 빌드의 OS·CPU 폴더만 남긴다. 지운 폴더 목록을 돌려준다 */
function pruneOnnxRuntime(resources, platform, arch) {
  const bin = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6'
  )
  const removed = []
  if (!fs.existsSync(bin)) return removed
  for (const os of fs.readdirSync(bin)) {
    const osDir = path.join(bin, os)
    if (os !== platform) {
      fs.rmSync(osDir, { recursive: true, force: true })
      removed.push(os)
      continue
    }
    for (const a of fs.readdirSync(osDir)) {
      if (a === arch) continue
      fs.rmSync(path.join(osDir, a), { recursive: true, force: true })
      removed.push(`${os}/${a}`)
    }
  }
  return removed
}

const VC_RUNTIME = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_atomic_wait.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll'
]

/** 버전 숫자 비교 (14.44.35112 등) */
function compareVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** VC++ 재배포 가능 파일이 든 폴더 — Visual Studio의 Redist(가장 새 버전) → 이 PC의 System32 */
function findVcRuntime(arch) {
  const has = (dir) => VC_RUNTIME.every((f) => fs.existsSync(path.join(dir, f)))
  const found = []
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const vs = path.join(root, 'Microsoft Visual Studio')
    if (!fs.existsSync(vs)) continue
    for (const year of fs.readdirSync(vs)) {
      const yearDir = path.join(vs, year)
      if (!fs.statSync(yearDir).isDirectory()) continue
      for (const edition of fs.readdirSync(yearDir)) {
        const msvc = path.join(yearDir, edition, 'VC', 'Redist', 'MSVC')
        if (!fs.existsSync(msvc)) continue
        for (const ver of fs.readdirSync(msvc)) {
          const archDir = path.join(msvc, ver, arch)
          if (!fs.existsSync(archDir)) continue
          for (const crt of fs.readdirSync(archDir)) {
            const dir = path.join(archDir, crt)
            if (/^Microsoft\.VC\d+\.CRT$/i.test(crt) && has(dir)) found.push({ ver, dir })
          }
        }
      }
    }
  }
  found.sort((a, b) => compareVersion(b.ver, a.ver))
  if (found.length) return found[0].dir
  // 빌드하는 PC와 같은 CPU일 때만 System32 것을 쓴다
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  if (process.arch === arch && has(system32)) return system32
  return null
}

/** 윈도우 onnxruntime 옆에 VC++ 런타임을 복사한다 — 못 찾으면 빌드를 멈춘다 */
function bundleVcRuntime(resources, arch) {
  const dest = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
    'win32',
    arch
  )
  if (!fs.existsSync(dest)) return null
  const src = findVcRuntime(arch)
  if (!src)
    throw new Error(
      `VC++ 런타임(${VC_RUNTIME.join(', ')})을 찾지 못했습니다 — Visual Studio C++ 도구를 설치하세요`
    )
  for (const f of VC_RUNTIME) fs.copyFileSync(path.join(src, f), path.join(dest, f))
  return src
}

module.exports = async (context) => {
  const resources = resourceDir(context)
  const arch = ARCH[context.arch] ?? 'x64'
  const removed = pruneOnnxRuntime(resources, context.electronPlatformName, arch)
  if (removed.length) console.log(`onnxruntime: removed other platforms (${removed.join(', ')})`)
  if (context.electronPlatformName === 'win32') {
    const src = bundleVcRuntime(resources, arch)
    if (src) console.log(`onnxruntime: bundled VC++ runtime from ${src}`)
  }
  await audit(context)
}
module.exports.pruneOnnxRuntime = pruneOnnxRuntime
module.exports.findVcRuntime = findVcRuntime
