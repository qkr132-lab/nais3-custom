// NAIS3 모바일 클라우드 배포 — 설계 cloud/DESIGN.md 12절
//
//   node cloud/scripts/deploy.mjs [--dry-run] [--url <워커 주소>]
//
// 하는 일 (순서대로 — 하나라도 실패하면 거기서 멈추고 어느 단계인지 한국어로 알려 준다):
//   1. 폰 화면 빌드          node scripts/build-web.mjs
//   2. R2 버킷 nais3-cloud   wrangler r2 bucket list 에 없을 때만 create
//   3. PC_SECRET 만들기      무작위 32바이트(base64url) — 화면·로그·오류 문구 어디에도 내보내지 않는다
//   4. 워커 배포             wrangler deploy --help 로 --secrets-file 지원을 확인해
//                            지원하면 코드와 PC_SECRET 을 한 번에(임시 파일은 os.tmpdir() 에 만들고 끝나면 삭제),
//                            아니면 deploy 뒤 wrangler secret put PC_SECRET (표준입력)
//                            --url 을 안 줬으면 배포 출력에 나온 주소(https://….workers.dev)를 워커 주소로 쓴다
//   5. 연결 파일 저장        ~/NAIS3 Custom 폰 연결/cloud-connect.json  { url, secret }
//                            (PC 앱이 다음에 켜질 때 가져가 암호화해 저장하고 파일을 지운다)
//
// --dry-run   아무것도 실행하지 않고 할 일 목록만 출력한다 (Cloudflare 계정에도 닿지 않는다)
// --url       워커 주소 — 연결 파일에 적힌다. 기본값은 없다: 안 주면 배포 출력에 나온 주소를 쓰고,
//             출력에 주소가 없거나 여러 개면 4단계에서 멈추고 --url 로 다시 실행하라고 알린다
//
// 다시 실행하면 비밀값을 새로 만들어 바꿔 배포한다 (기존 연결은 새 연결 파일을 가져가야 이어진다).
// wrangler 는 cloud/·앱 루트의 node_modules 를 먼저 찾고, 없으면 npm 전역 설치본을 쓴다
// (환경변수 NAIS3_WRANGLER_JS 로 bin/wrangler.js 위치를 직접 줄 수도 있다).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BUCKET_NAME = 'nais3-cloud'
/** 연결 파일을 두는 홈 폴더 아래 폴더 이름 — PC 앱(src/main/cloud/config.ts)과 같아야 한다 */
export const CONNECT_DIR_NAME = 'NAIS3 Custom 폰 연결'
export const CONNECT_FILE_NAME = 'cloud-connect.json'

const cloudDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MINUTE = 60 * 1000

// ── 인자·순수 도우미 (테스트 대상) ──────────────────────────────────

/** 인자를 잘못 줬을 때 — 종료 코드 2 */
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** 단계 하나가 실패했을 때 — 어느 단계인지 함께 알린다 */
export class StepError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'StepError'
    this.hint = hint
  }
}

/** 워커 주소를 https 출처(origin)로 정리한다 — 경로·계정 정보가 붙어 있으면 거절 */
export function normalizeUrl(text) {
  let url
  try {
    url = new URL(String(text).trim())
  } catch {
    throw new UsageError(`워커 주소가 올바르지 않습니다: ${text}`)
  }
  if (url.protocol !== 'https:') throw new UsageError('워커 주소는 https:// 로 시작해야 합니다')
  if (url.username || url.password)
    throw new UsageError('워커 주소에는 계정 정보를 넣을 수 없습니다')
  return url.origin
}

/** url 은 --url 을 줬을 때만 채운다 — null 이면 배포 출력에서 주소를 얻는다 */
export function parseArgs(argv) {
  const options = { dryRun: false, help: false, url: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--url') {
      const value = argv[++i]
      if (!value || value.startsWith('--'))
        throw new UsageError('--url 뒤에 워커 주소를 적어 주세요')
      options.url = normalizeUrl(value)
    } else if (arg.startsWith('--url=')) options.url = normalizeUrl(arg.slice('--url='.length))
    else throw new UsageError(`알 수 없는 옵션입니다: ${arg}`)
  }
  return options
}

const ANSI = /\u001b\[[0-9;]*m/g

/** `wrangler r2 bucket list` 출력에서 버킷 이름들을 뽑는다 (`name:  이름` 줄) */
export function listBucketNames(output) {
  const names = []
  for (const match of String(output)
    .replace(ANSI, '')
    .matchAll(/^\s*name:\s*(\S+)\s*$/gm)) {
    names.push(match[1])
  }
  return names
}

/** `wrangler deploy --help` 에 --secrets-file 이 있는가 */
export function supportsSecretsFile(helpText) {
  return /(^|\s)--secrets-file(\s|$)/m.test(String(helpText).replace(ANSI, ''))
}

/** `wrangler deploy` 출력에 나온 워커 주소(https://….workers.dev)들 — 같은 주소는 한 번만 */
export function deployedUrls(output) {
  return [...new Set(String(output).match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/g) ?? [])]
}

/** 글자에서 비밀값을 가린다 */
export function scrubText(text, secrets) {
  let out = String(text)
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***')
  }
  return out
}

/** 자식 프로세스 출력 끝 몇 줄 — 오류 원인 확인용 (비밀값은 가린다) */
export function tailOf(result, secrets, lines = 12) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(ANSI, '')
  return scrubText(text, secrets)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-lines)
    .map((line) => (line.length > 300 ? line.slice(0, 300) + '…' : line))
    .join('\n')
}

/** 새 PC_SECRET — 32바이트 무작위 base64url */
export function makeSecret() {
  return randomBytes(32).toString('base64url')
}

export function connectFilePath(homedir) {
  return path.join(homedir, CONNECT_DIR_NAME, CONNECT_FILE_NAME)
}

/** 할 일 목록 (dry-run 출력과 진행 표시가 같은 이름을 쓴다) */
export function planSteps(options, homedir = os.homedir()) {
  return [
    {
      title: '폰 화면 빌드',
      detail: 'node scripts/build-web.mjs → cloud/public'
    },
    {
      title: `R2 버킷 ${BUCKET_NAME} 확인`,
      detail: `wrangler r2 bucket list 에 없을 때만 wrangler r2 bucket create ${BUCKET_NAME}`
    },
    {
      title: 'PC_SECRET 만들기',
      detail: '무작위 32바이트(base64url) — 화면·로그에 출력하지 않음'
    },
    {
      title: '워커 배포',
      detail:
        'wrangler deploy --help 로 --secrets-file 지원 확인 → 지원하면 임시 파일(os.tmpdir())로 코드와 PC_SECRET 을 한 번에 배포하고 임시 파일 삭제, ' +
        '아니면 wrangler deploy 뒤 wrangler secret put PC_SECRET (표준입력)'
    },
    {
      title: '연결 파일 저장',
      detail: `${connectFilePath(homedir)}  { url: ${options.url ?? '(배포 출력에 나온 주소)'}, secret: (비밀값) }`
    }
  ]
}

// ── 실제 실행 환경 (테스트에서는 가짜로 바꿔 끼운다) ────────────────

/** 따옴표가 붙은 PATH 항목을 정리한 환경변수 (Windows 에서 자식이 node 를 못 찾는 문제 예방) */
function cleanEnv() {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && typeof env[key] === 'string') {
      env[key] = env[key]
        .split(path.delimiter)
        .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
        .join(path.delimiter)
    }
  }
  return env
}

/** wrangler 의 bin/wrangler.js 위치 — 못 찾으면 null */
export function findWranglerJs() {
  const given = process.env.NAIS3_WRANGLER_JS
  if (given) return existsSync(given) ? given : null
  const nodeDir = path.dirname(process.execPath)
  const candidates = [
    // 지역 설치 (cloud/ 먼저, 앱 루트 다음)
    path.join(cloudDir, 'node_modules'),
    path.join(cloudDir, '..', 'node_modules'),
    // npm 전역 설치
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    path.join(nodeDir, 'node_modules'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules'
  ].filter(Boolean)
  for (const base of candidates) {
    const file = path.join(base, 'wrangler', 'bin', 'wrangler.js')
    if (existsSync(file)) return file
  }
  return null
}

function spawnResult(command, args, { cwd, input, timeoutMs }) {
  const result = spawnSync(command, args, {
    cwd,
    env: cleanEnv(),
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  let error
  if (result.error) {
    error =
      result.error.code === 'ETIMEDOUT' ? '시간이 너무 오래 걸려 멈췄습니다' : result.error.message
  } else if (result.signal) {
    error = `중간에 끊겼습니다 (${result.signal})`
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error }
}

/** 진짜 환경 */
export function createRealIo() {
  return {
    log: (line) => console.log(line),
    homedir: () => os.homedir(),
    tmpdir: () => os.tmpdir(),
    makeSecret,
    /** node scripts/build-web.mjs 같은 내 스크립트 */
    node(args, { cwd, timeoutMs }) {
      return spawnResult(process.execPath, args, { cwd, timeoutMs })
    },
    /** wrangler — 못 찾으면 StepError */
    wrangler(args, { cwd, input, timeoutMs }) {
      const bin = findWranglerJs()
      if (!bin) {
        throw new StepError(
          'wrangler 를 찾지 못했습니다',
          '전역 설치(npm i -g wrangler) 뒤 다시 실행하거나, NAIS3_WRANGLER_JS 에 bin/wrangler.js 위치를 주세요'
        )
      }
      return spawnResult(process.execPath, [bin, ...args], { cwd, input, timeoutMs })
    },
    mkdtemp: (prefix) => mkdtempSync(prefix),
    writeFile: (file, data, mode) => writeFileSync(file, data, { mode }),
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    rm: (target) => rmSync(target, { recursive: true, force: true }),
    cloudDir
  }
}

// ── 본 흐름 ─────────────────────────────────────────────────────────

/** 자식 프로세스가 성공했는지 보고, 아니면 StepError (출력 끝부분은 비밀값을 가려서 붙인다) */
function requireOk(result, what, secrets) {
  if (result.status === 0 && !result.error) return result
  const reason = result.error ?? `종료 코드 ${result.status}`
  const tail = tailOf(result, secrets)
  throw new StepError(`${what} 실패 (${reason})${tail ? `\n${tail}` : ''}`)
}

/**
 * 배포를 실행한다. 돌려주는 값 = 종료 코드 (0 성공 / 1 단계 실패)
 * @param {{ dryRun: boolean, url: string | null }} options url 이 null 이면 배포 출력에 나온 주소를 쓴다
 * @param {ReturnType<typeof createRealIo>} io
 */
export async function runDeploy(options, io) {
  const homedir = io.homedir()
  const steps = planSteps(options, homedir)
  const total = steps.length

  if (options.dryRun) {
    io.log('[배포 미리보기] 아무것도 실행하지 않았습니다. 실제로 하면 아래 순서로 진행합니다.')
    steps.forEach((step, i) => io.log(`  ${i + 1}/${total} ${step.title}\n       ${step.detail}`))
    io.log(
      options.url
        ? `워커 주소: ${options.url}`
        : '워커 주소: --url 을 주지 않아 배포 출력에 나온 주소(https://….workers.dev)를 씁니다'
    )
    return 0
  }

  const secrets = []
  let tempDir = null
  let current = 0
  const begin = (n) => {
    current = n
    io.log(`[${n}/${total}] ${steps[n - 1].title} ...`)
  }

  try {
    // 1) 폰 화면 빌드
    begin(1)
    requireOk(
      io.node([path.join(io.cloudDir, 'scripts', 'build-web.mjs')], {
        cwd: io.cloudDir,
        timeoutMs: 5 * MINUTE
      }),
      '폰 화면 빌드',
      secrets
    )

    // 2) R2 버킷 — 목록에 없을 때만 만든다
    begin(2)
    const listed = requireOk(
      io.wrangler(['r2', 'bucket', 'list'], { cwd: io.cloudDir, timeoutMs: 2 * MINUTE }),
      'R2 버킷 목록 확인',
      secrets
    )
    if (listBucketNames(listed.stdout).includes(BUCKET_NAME)) {
      io.log(`      버킷 ${BUCKET_NAME} 이 이미 있어 그대로 씁니다`)
    } else {
      const created = io.wrangler(['r2', 'bucket', 'create', BUCKET_NAME], {
        cwd: io.cloudDir,
        timeoutMs: 2 * MINUTE
      })
      // 목록 형식이 바뀌어 못 알아봤더라도 「이미 있음」이면 통과
      const text = `${created.stdout}\n${created.stderr}`
      if (created.status !== 0 && /already exists|10004/i.test(text)) {
        io.log(`      버킷 ${BUCKET_NAME} 이 이미 있어 그대로 씁니다`)
      } else {
        requireOk(created, `R2 버킷 ${BUCKET_NAME} 만들기`, secrets)
        io.log(`      버킷 ${BUCKET_NAME} 을 만들었습니다`)
      }
    }

    // 3) 비밀값 — 메모리에만 두고 출력하지 않는다
    begin(3)
    const secret = io.makeSecret()
    secrets.push(secret)

    // 4) 워커 배포
    begin(4)
    const help = requireOk(
      io.wrangler(['deploy', '--help'], { cwd: io.cloudDir, timeoutMs: 2 * MINUTE }),
      'wrangler 도움말 확인',
      secrets
    )
    const viaFile = supportsSecretsFile(`${help.stdout}\n${help.stderr}`)
    let deployed
    if (viaFile) {
      tempDir = io.mkdtemp(path.join(io.tmpdir(), 'nais3-cloud-'))
      const secretsFile = path.join(tempDir, 'secrets.json')
      io.writeFile(secretsFile, JSON.stringify({ PC_SECRET: secret }), 0o600)
      deployed = requireOk(
        io.wrangler(['deploy', '--secrets-file', secretsFile], {
          cwd: io.cloudDir,
          timeoutMs: 10 * MINUTE
        }),
        '워커 배포',
        secrets
      )
      io.log('      코드와 PC_SECRET 을 한 번에 배포했습니다')
    } else {
      deployed = requireOk(
        io.wrangler(['deploy'], { cwd: io.cloudDir, timeoutMs: 10 * MINUTE }),
        '워커 배포',
        secrets
      )
      requireOk(
        io.wrangler(['secret', 'put', 'PC_SECRET'], {
          cwd: io.cloudDir,
          input: secret,
          timeoutMs: 2 * MINUTE
        }),
        'PC_SECRET 등록',
        secrets
      )
      io.log('      배포한 뒤 PC_SECRET 을 등록했습니다 (표준입력)')
    }
    // 워커 주소 — --url 로 받았으면 그대로, 아니면 wrangler 가 알려 준 주소
    const seen = deployedUrls(`${deployed.stdout}\n${deployed.stderr}`)
    let url = options.url
    if (url) {
      // wrangler 가 알려 준 주소가 연결 파일에 적을 주소와 다르면 알린다 (실패는 아님)
      if (seen.length > 0 && !seen.includes(url)) {
        io.log(
          `      알림: 배포된 주소는 ${seen.join(', ')} 입니다. 연결 파일에는 ${url} 이 적힙니다 ` +
            '(다르면 --url 로 다시 실행하세요)'
        )
      }
    } else if (seen.length === 1) {
      url = seen[0]
      io.log(`      배포 출력에 나온 주소를 워커 주소로 씁니다: ${url}`)
    } else {
      throw new StepError(
        seen.length === 0
          ? '배포 출력에서 워커 주소(https://….workers.dev)를 찾지 못했습니다'
          : `배포 출력에 워커 주소가 여러 개라 하나로 정하지 못했습니다: ${seen.join(', ')}`,
        '워커 배포는 끝났습니다. --url <주소> 를 붙여 다시 실행하면 비밀값을 새로 만들어 바꿔 배포하고 연결 파일을 씁니다'
      )
    }

    // 5) 연결 파일 — 앱이 가져가고 지운다
    begin(5)
    const file = connectFilePath(homedir)
    try {
      io.mkdir(path.dirname(file))
      io.writeFile(file, JSON.stringify({ url, secret }, null, 2) + '\n', 0o600)
    } catch (error) {
      throw new StepError(
        `연결 파일을 쓰지 못했습니다 (${error instanceof Error ? error.message : String(error)})`,
        '워커 배포는 끝났습니다. 다시 실행하면 비밀값을 새로 만들어 바꿔 배포하고 연결 파일을 씁니다'
      )
    }
    io.log(
      `      ${file} 에 저장했습니다. PC NAIS3 를 켜면 가져가 암호화해 저장하고 파일을 지웁니다`
    )
    io.log(`완료: ${url}`)
    return 0
  } catch (error) {
    const message = scrubText(error instanceof Error ? error.message : String(error), secrets)
    io.log(`실패: ${current}/${total} ${steps[Math.max(current, 1) - 1].title} 단계에서 멈췄습니다`)
    io.log(message)
    const hint =
      error instanceof StepError && error.hint
        ? error.hint
        : current >= 2 && current <= 4
          ? 'Cloudflare 로그인이 필요하면 wrangler login 을 먼저 실행해 주세요'
          : ''
    if (hint) io.log(`안내: ${hint}`)
    return 1
  } finally {
    if (tempDir) {
      try {
        io.rm(tempDir)
      } catch {
        io.log(`주의: 임시 폴더를 지우지 못했습니다. 직접 지워 주세요: ${tempDir}`)
      }
    }
  }
}

const HELP = `사용법: node cloud/scripts/deploy.mjs [--dry-run] [--url <워커 주소>]
  --dry-run   아무것도 실행하지 않고 할 일 목록만 출력
  --url       워커 주소 (안 주면 배포 출력에 나온 주소를 씀)
  -h, --help  이 도움말`

export async function main(argv, io = createRealIo()) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(HELP)
    return 2
  }
  if (options.help) {
    console.log(HELP)
    return 0
  }
  return runDeploy(options, io)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  // 실행 중 Ctrl+C 를 받아도 임시 파일 정리(finally)까지 돌도록 기본 종료를 막는다
  // (자식이 끊기면 그 단계가 실패로 끝나고 finally 가 지운다)
  process.on('SIGINT', () => {})
  process.exitCode = await main(process.argv.slice(2))
}
