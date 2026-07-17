import electronUpdater from 'electron-updater'
import { app, shell } from 'electron'
import { execFile } from 'child_process'
import { createWriteStream } from 'fs'
import { access, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { promisify } from 'util'
import { broadcast } from './ipc'
import {
  isNewerVersion,
  releaseVersion,
  type GitHubRelease,
  type GitHubReleaseAsset
} from './update-release'

// electron-updater는 CJS — ESM에서 named import가 깨질 수 있어 default에서 구조분해
const { autoUpdater } = electronUpdater
const execFileP = promisify(execFile)

// NAIS3 Custom 배포 저장소 — 자동 업데이트가 이 저장소의 릴리즈를 확인한다
const REPO = 'qkr132-lab/nais3-custom'
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`

/**
 * 자동 업데이트.
 * - Windows: electron-updater (서명 불필요, 표준 경로)
 * - macOS: 커스텀 — Squirrel.Mac이 Apple 서명을 요구하므로, 앱이 직접 zip을 받아
 *   .app을 교체하고 재시작한다 (Tauri 방식). 최초 설치 때만 Gatekeeper를 넘기면
 *   이후 업데이트 파일은 앱이 받은 것이라 quarantine이 없어 재실행에 문제 없음.
 */
export function setupUpdater(): void {
  if (!app.isPackaged) return // dev에선 확인 안 함

  if (process.platform === 'darwin') {
    void checkPublishedUpdate(true)
    setInterval(() => void checkPublishedUpdate(true), 6 * 60 * 60 * 1000)
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // 실험판 앱도 exp.yml이 아닌 공개 안정판 latest.yml을 확인한다.
  autoUpdater.channel = 'latest'
  autoUpdater.allowPrerelease = false

  autoUpdater.on('update-available', (info) => {
    broadcast('update:status', { state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    broadcast('update:status', { state: 'none' })
  })
  autoUpdater.on('download-progress', (p) => {
    broadcast('update:status', { state: 'downloading', percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', () => {
    broadcast('update:status', { state: 'downloaded' })
    // 자동 진행 — 잠깐 상태를 보여준 뒤 재시작 설치
    setTimeout(() => autoUpdater.quitAndInstall(), 1200)
  })
  autoUpdater.on('error', (err) => {
    broadcast('update:status', { state: 'error', message: readableError(err) })
  })

  void checkPublishedUpdate(true)
  setInterval(
    () => {
      void checkPublishedUpdate(true)
    },
    6 * 60 * 60 * 1000
  )
}

/** 지금 업데이트 확인 (커스텀) — 정보 화면을 열 때마다 실시간 재확인. 결과는 update:status로 */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) {
    broadcast('update:status', { state: 'none' }) // dev에선 확인 안 함
    return
  }
  broadcast('update:status', { state: 'checking' })
  void checkPublishedUpdate(false)
}

/** 다운로드 시작 (타이틀바/설정 버튼 클릭) */
export function startUpdateDownload(): void {
  if (process.platform === 'darwin') {
    void downloadAndInstallMac()
    return
  }
  void autoUpdater.downloadUpdate().catch((err) => {
    broadcast('update:status', { state: 'error', message: readableError(err) })
  })
}

// ─── GitHub 공개 릴리스 확인 ──────────────────────────────────────────

let macAsset: GitHubReleaseAsset | null = null

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/\s+/g, ' ').trim().slice(0, 180) || '알 수 없는 오류'
}

async function fetchLatestPublishedRelease(): Promise<GitHubRelease> {
  const res = await fetch(RELEASE_API, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `NAIS3-Custom/${app.getVersion()}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })
  if (!res.ok) throw new Error(`GitHub 릴리스 응답 ${res.status}`)
  return (await res.json()) as GitHubRelease
}

async function checkPublishedUpdate(silentNetworkError: boolean): Promise<void> {
  try {
    const release = await fetchLatestPublishedRelease()
    const version = releaseVersion(release)
    if (!version) throw new Error('GitHub 릴리스 버전 형식이 올바르지 않습니다')
    if (!isNewerVersion(version, app.getVersion())) {
      broadcast('update:status', { state: 'none' })
      return
    }

    if (process.platform === 'darwin') {
      const asset = (release.assets ?? []).find((a) => a.name.endsWith(`${process.arch}-mac.zip`))
      if (!asset) throw new Error(`버전 ${version}의 ${process.arch} macOS 파일이 없습니다`)
      macAsset = asset
      broadcast('update:status', { state: 'available', version })
      return
    }

    if (process.platform !== 'win32') {
      broadcast('update:status', { state: 'none' })
      return
    }

    const assets = release.assets ?? []
    const hasManifest = assets.some((asset) => asset.name === 'latest.yml')
    const hasInstaller = assets.some(
      (asset) => asset.name.includes(`-${version}-`) && asset.name.endsWith('-setup.exe')
    )
    if (!hasManifest || !hasInstaller) {
      throw new Error(`버전 ${version}의 Windows 업데이트 파일 구성이 올바르지 않습니다`)
    }

    await autoUpdater.checkForUpdates()
  } catch (error) {
    if (silentNetworkError) {
      broadcast('update:status', { state: 'none' })
      return
    }
    broadcast('update:status', { state: 'error', message: readableError(error) })
  }
}

async function downloadAndInstallMac(): Promise<void> {
  const asset = macAsset
  if (!asset) return
  try {
    broadcast('update:status', { state: 'downloading', percent: 0 })

    // 1. zip 다운로드 (진행률 브로드캐스트)
    const res = await fetch(asset.browser_download_url)
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 ${res.status}`)
    const tmp = await mkdtemp(join(tmpdir(), 'nais3-update-'))
    const zipPath = join(tmp, asset.name)
    const out = createWriteStream(zipPath)
    const reader = res.body.getReader()
    let received = 0
    let lastPct = -1
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(value)
      received += value.length
      const pct = Math.min(99, Math.round((received / asset.size) * 100))
      if (pct !== lastPct) {
        lastPct = pct
        broadcast('update:status', { state: 'downloading', percent: pct })
      }
    }
    await new Promise<void>((res2, rej) => out.end((e?: Error) => (e ? rej(e) : res2())))

    // 2. 압축 해제 (ditto — 심볼릭 링크·번들 구조 보존)
    const extractDir = join(tmp, 'extracted')
    await execFileP('ditto', ['-xk', zipPath, extractDir])

    // 3. .app 교체: 현재 번들을 옆으로 치우고 새 번들을 제자리에 (mv는 볼륨 경계도 처리)
    const appBundle = resolve(app.getPath('exe'), '../../..') // .../NAIS3.app
    const newApp = join(extractDir, basename(appBundle))
    await access(join(newApp, 'Contents', 'Info.plist')) // 번들 검증
    const oldApp = `${appBundle}.old-${process.pid}`
    await execFileP('mv', [appBundle, oldApp])
    try {
      await execFileP('mv', [newApp, appBundle])
    } catch (e) {
      await execFileP('mv', [oldApp, appBundle]) // 실패 시 원복
      throw e
    }
    void rm(oldApp, { recursive: true, force: true }).catch(() => {})
    void rm(tmp, { recursive: true, force: true }).catch(() => {})

    // 4. 재시작
    broadcast('update:status', { state: 'downloaded' })
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 1200)
  } catch (e) {
    // 권한 부족 등으로 실패하면 릴리즈 페이지로 폴백
    broadcast('update:status', {
      state: 'error',
      message: `자동 설치 실패 — 릴리즈 페이지를 엽니다 (${e instanceof Error ? e.message : e})`
    })
    void shell.openExternal(RELEASE_PAGE)
  }
}
