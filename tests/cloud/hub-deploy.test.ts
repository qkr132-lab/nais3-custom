// cloud/scripts/deploy.mjs 시험 — 진짜 wrangler 도 Cloudflare 계정도 건드리지 않는다.
// 자식 프로세스·파일 쓰기는 전부 가짜 환경(io)으로 바꿔 끼워, 호출 순서와 넘긴 값만 확인한다.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BUCKET_NAME,
  CONNECT_DIR_NAME,
  CONNECT_FILE_NAME,
  StepError,
  UsageError,
  connectFilePath,
  deployedUrls,
  listBucketNames,
  main,
  makeSecret,
  normalizeUrl,
  parseArgs,
  planSteps,
  runDeploy,
  scrubText,
  supportsSecretsFile,
  tailOf
} from '../../cloud/scripts/deploy.mjs'

const SECRET = 'S3cr3t-Value_0123456789abcdefghijklmnopqrstuv'
const HOME = path.join('C:', 'Users', '테스트')
const TMP = path.join('C:', 'Temp')
const CLOUD = path.join('C:', 'repo', 'cloud')
/** 가짜 wrangler deploy 가 출력하는 워커 주소 */
const WORKER_URL = 'https://nais3-cloud.example.workers.dev'
/** wrangler deploy 출력 모양 — 주소 줄만 바꿔 끼운다 */
const DEPLOY_OUTPUT = (urls: string[]): string =>
  ['Deployed nais3-cloud triggers', ...urls.map((u) => `  ${u}`), 'Version ID: abc'].join('\n')

/** wrangler deploy --help 의 해당 줄 (실제 4.114 출력 발췌) */
const HELP_WITH = `OPTIONS
      --dry-run                                    Compile a project and run checks without actually uploading the Worker  [boolean]
      --secrets-file                               Path to a file containing secrets to upload with the version (JSON or .env format).  [string]
      --keep-vars                                  When not used (or set to false)`
const HELP_WITHOUT = `OPTIONS
      --dry-run                                    Compile a project and run checks without actually uploading the Worker  [boolean]
      --keep-vars                                  When not used (or set to false)`

const BUCKET_LIST = (names: string[]): string =>
  names.map((n) => `name:           ${n}\ncreation_date:  2026-01-01T00:00:00.000Z\n`).join('\n')

interface Result {
  status: number | null
  stdout: string
  stderr: string
  error?: string
}
const okResult = (stdout = '', stderr = ''): Result => ({ status: 0, stdout, stderr })
const failResult = (stderr = '', status = 1): Result => ({ status, stdout: '', stderr })

interface Call {
  kind: 'node' | 'wrangler'
  args: string[]
  input?: string
  cwd?: string
}

interface FakeIo {
  io: {
    log(line: string): void
    homedir(): string
    tmpdir(): string
    makeSecret(): string
    cloudDir: string
    node(args: string[], opts: { cwd: string }): Result
    wrangler(args: string[], opts: { cwd: string; input?: string }): Result
    mkdtemp(prefix: string): string
    writeFile(file: string, data: string, mode?: number): void
    mkdir(dir: string): void
    rm(target: string): void
  }
  calls: Call[]
  logs: string[]
  files: Map<string, { data: string; mode?: number }>
  dirs: string[]
  removed: string[]
  /** deploy 가 불린 순간에 보인 임시 비밀 파일 내용 */
  secretFileAtCall: string[]
  tempDirs: string[]
  wranglerCalls(): string[]
}

/** 가짜 환경. handler 는 wrangler 인자에 따라 결과를 바꾼다 */
function fakeIo(
  handler: (args: string[], call: Call) => Result | undefined = () => undefined,
  options: { nodeResult?: Result; writeFails?: boolean } = {}
): FakeIo {
  const calls: Call[] = []
  const logs: string[] = []
  const files = new Map<string, { data: string; mode?: number }>()
  const dirs: string[] = []
  const removed: string[] = []
  const secretFileAtCall: string[] = []
  const tempDirs: string[] = []

  const defaults = (args: string[]): Result => {
    const key = args.slice(0, 3).join(' ')
    if (key.startsWith('r2 bucket list')) return okResult(BUCKET_LIST([BUCKET_NAME]))
    if (key.startsWith('r2 bucket create')) return okResult('Created bucket')
    if (args[0] === 'deploy' && args[1] === '--help') return okResult(HELP_WITH)
    if (args[0] === 'deploy') return okResult(DEPLOY_OUTPUT([WORKER_URL]))
    if (args[0] === 'secret') return okResult('Success! Uploaded secret PC_SECRET')
    return okResult()
  }

  const io: FakeIo['io'] = {
    log: (line: string) => void logs.push(line),
    homedir: () => HOME,
    tmpdir: () => TMP,
    makeSecret: () => SECRET,
    cloudDir: CLOUD,
    node(args: string[], opts: { cwd: string }): Result {
      calls.push({ kind: 'node', args, cwd: opts.cwd })
      return options.nodeResult ?? okResult('빌드 완료')
    },
    wrangler(args: string[], opts: { cwd: string; input?: string }): Result {
      const call: Call = { kind: 'wrangler', args, input: opts.input, cwd: opts.cwd }
      calls.push(call)
      const i = args.indexOf('--secrets-file')
      if (i >= 0) secretFileAtCall.push(files.get(args[i + 1])?.data ?? '(파일 없음)')
      return handler(args, call) ?? defaults(args)
    },
    mkdtemp(prefix: string): string {
      const dir = `${prefix}ABC123`
      tempDirs.push(dir)
      return dir
    },
    writeFile(file: string, data: string, mode?: number): void {
      if (options.writeFails && file.endsWith(CONNECT_FILE_NAME)) throw new Error('EACCES: 거부됨')
      files.set(file, { data, mode })
    },
    mkdir: (dir: string): void => void dirs.push(dir),
    rm(target: string): void {
      removed.push(target)
      for (const key of [...files.keys()]) if (key.startsWith(target)) files.delete(key)
    }
  }
  const wranglerCalls = (): string[] =>
    calls.filter((c) => c.kind === 'wrangler').map((c) => c.args.join(' '))
  return { io, calls, logs, files, dirs, removed, secretFileAtCall, tempDirs, wranglerCalls }
}

/** 기본은 --url 없이 실행한 것 (url: null → 배포 출력에 나온 주소를 쓴다) */
const options = (
  over: Partial<{ dryRun: boolean; url: string | null }> = {}
): { dryRun: boolean; url: string | null } => ({
  dryRun: false,
  url: null,
  ...over
})

/** wrangler deploy(도움말 제외)의 출력만 바꾼 가짜 환경 */
const fakeIoWithDeployOutput = (stdout: string, stderr = ''): FakeIo =>
  fakeIo((args) =>
    args[0] === 'deploy' && args[1] !== '--help' ? okResult(stdout, stderr) : undefined
  )

const connectFile = path.join(HOME, CONNECT_DIR_NAME, CONNECT_FILE_NAME)

describe('deploy.mjs — 순수 도우미', () => {
  it('상수와 연결 파일 위치', () => {
    expect(BUCKET_NAME).toBe('nais3-cloud')
    expect(CONNECT_DIR_NAME).toBe('NAIS3 Custom 폰 연결')
    expect(CONNECT_FILE_NAME).toBe('cloud-connect.json')
    expect(connectFilePath(HOME)).toBe(connectFile)
  })

  it('인자: 기본값(주소 없음) · --dry-run · --url (두 가지 쓰기) · 도움말', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, help: false, url: null })
    expect(parseArgs(['--dry-run']).url).toBeNull()
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true })
    expect(parseArgs(['--url', 'https://my.example.workers.dev/']).url).toBe(
      'https://my.example.workers.dev'
    )
    expect(parseArgs(['--url=https://x.example.dev', '--dry-run'])).toMatchObject({
      dryRun: true,
      url: 'https://x.example.dev'
    })
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it('인자 오류는 한국어 UsageError', () => {
    for (const argv of [['--nope'], ['--url'], ['--url', '--dry-run'], ['--url', 'not a url']]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(UsageError)
    }
    expect(() => parseArgs(['--nope'])).toThrow('알 수 없는 옵션')
    expect(() => normalizeUrl('http://insecure.example')).toThrow('https://')
    expect(() => normalizeUrl('https://user:pw@example.dev')).toThrow('계정 정보')
    expect(normalizeUrl('https://a.b.workers.dev/path?q=1')).toBe('https://a.b.workers.dev')
  })

  it('버킷 목록 해석: name: 줄만 · 색 코드 제거 · 이름이 부분만 겹치는 것은 다른 버킷', () => {
    expect(listBucketNames(BUCKET_LIST(['my-assets', 'nais3-cloud']))).toEqual([
      'my-assets',
      'nais3-cloud'
    ])
    expect(listBucketNames('\u001b[37mname:\u001b[39m  nais3-cloud\n')).toEqual(['nais3-cloud'])
    expect(listBucketNames(BUCKET_LIST(['nais3-cloud-old', 'my-nais3-cloud']))).not.toContain(
      BUCKET_NAME
    )
    expect(listBucketNames('No R2 buckets found')).toEqual([])
    expect(listBucketNames('')).toEqual([])
  })

  it('배포 출력에서 워커 주소를 뽑는다: workers.dev 만 · 같은 주소는 한 번 · 경로는 뗀다', () => {
    expect(deployedUrls(DEPLOY_OUTPUT([WORKER_URL]))).toEqual([WORKER_URL])
    expect(deployedUrls(`${WORKER_URL}\n${WORKER_URL}/ (재출력)`)).toEqual([WORKER_URL])
    expect(deployedUrls(`${WORKER_URL}/#pair=ABCD`)).toEqual([WORKER_URL])
    expect(deployedUrls(DEPLOY_OUTPUT([WORKER_URL, 'https://b.example.workers.dev']))).toEqual([
      WORKER_URL,
      'https://b.example.workers.dev'
    ])
    // workers.dev 가 아닌 주소(문서 링크·사용자 도메인)는 세지 않는다
    expect(
      deployedUrls('https://developers.cloudflare.com/workers\nhttps://app.example.com')
    ).toEqual([])
    expect(deployedUrls('')).toEqual([])
  })

  it('--secrets-file 지원 여부를 도움말에서 읽는다', () => {
    expect(supportsSecretsFile(HELP_WITH)).toBe(true)
    expect(supportsSecretsFile(HELP_WITHOUT)).toBe(false)
    expect(supportsSecretsFile('')).toBe(false)
    // 비슷한 이름은 인정하지 않는다
    expect(supportsSecretsFile('  --secrets-files  nope')).toBe(false)
  })

  it('비밀값은 base64url 32바이트(43자)이고 매번 다르다', () => {
    const a = makeSecret()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(makeSecret()).not.toBe(a)
  })

  it('글자에서 비밀값을 가리고, 출력 끝은 12줄까지만 싣는다', () => {
    expect(scrubText(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe('a *** b ***')
    expect(scrubText('짧은 값 abc', ['abc'])).toBe('짧은 값 abc') // 4자 미만은 오탐 방지로 건너뜀
    const lines = Array.from({ length: 30 }, (_, i) => `줄 ${i}`).join('\n')
    const tail = tailOf({ stdout: lines, stderr: `오류 ${SECRET}` }, [SECRET])
    expect(tail.split('\n')).toHaveLength(12)
    expect(tail).toContain('오류 ***')
    expect(tail).not.toContain(SECRET)
  })

  it('할 일 목록은 5단계이고 연결 파일 위치와 주소가 보인다', () => {
    const steps = planSteps({ url: 'https://z.example.dev' }, HOME)
    expect(steps).toHaveLength(5)
    expect(steps[4].detail).toContain(connectFile)
    expect(steps[4].detail).toContain('https://z.example.dev')
    expect(steps.map((s) => s.title).join('|')).toContain('PC_SECRET')
    // --url 이 없으면 주소 자리에 「배포 출력에 나온 주소」라고 적는다
    const auto = planSteps({ url: null }, HOME)
    expect(auto[4].detail).toContain(connectFile)
    expect(auto[4].detail).toContain('배포 출력에 나온 주소')
    expect(auto[4].detail).not.toContain('null')
  })
})

describe('deploy.mjs — --dry-run', () => {
  it('아무것도 실행하지 않고 할 일만 출력한다', async () => {
    const f = fakeIo()
    const code = await runDeploy(options({ dryRun: true }), f.io)
    expect(code).toBe(0)
    expect(f.calls).toEqual([])
    expect(f.files.size).toBe(0)
    expect(f.dirs).toEqual([])
    expect(f.tempDirs).toEqual([])
    const out = f.logs.join('\n')
    for (const n of ['1/5', '2/5', '3/5', '4/5', '5/5']) expect(out).toContain(n)
    expect(out).toContain('아무것도 실행하지 않았습니다')
    // --url 이 없으면 주소를 지어내지 않고, 배포 출력에서 얻는다고 알린다
    expect(out).toContain('워커 주소: --url 을 주지 않아 배포 출력에 나온 주소')
    expect(out).not.toMatch(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/)
    expect(out).not.toContain('null')
  })

  it('--url 을 주면 미리보기에 그 주소가 보인다', async () => {
    const f = fakeIo()
    const url = 'https://other.example.workers.dev'
    expect(await runDeploy(options({ dryRun: true, url }), f.io)).toBe(0)
    expect(f.calls).toEqual([])
    const out = f.logs.join('\n')
    expect(out).toContain(`워커 주소: ${url}`)
    expect(out).not.toContain('배포 출력에 나온 주소')
  })

  it('main(): --dry-run 은 0, 잘못된 인자는 2 (실행 없음)', async () => {
    const f = fakeIo()
    expect(await main(['--dry-run'], f.io as never)).toBe(0)
    expect(f.calls).toEqual([])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await main(['--nope'], f.io as never)).toBe(2)
      expect(await main(['--help'], f.io as never)).toBe(0)
    } finally {
      error.mockRestore()
      log.mockRestore()
    }
    expect(f.calls).toEqual([])
  })
})

describe('deploy.mjs — 배포 흐름', () => {
  it('--secrets-file 지원: 코드와 비밀값을 한 번에 배포하고, 임시 파일은 지우고, 연결 파일을 쓴다', async () => {
    const f = fakeIo()
    const code = await runDeploy(options(), f.io)
    expect(code).toBe(0)

    // 순서: 빌드 → 버킷 목록 → (있으니 만들지 않음) → 도움말 → 배포
    expect(f.calls[0]).toMatchObject({ kind: 'node', cwd: CLOUD })
    expect(f.calls[0].args[0]).toBe(path.join(CLOUD, 'scripts', 'build-web.mjs'))
    const w = f.wranglerCalls()
    expect(w[0]).toBe('r2 bucket list')
    expect(w[1]).toBe('deploy --help')
    expect(w).toHaveLength(3)
    expect(w[2]).toMatch(/^deploy --secrets-file /)
    expect(w.some((a) => a.startsWith('secret'))).toBe(false)
    expect(w.some((a) => a.startsWith('r2 bucket create'))).toBe(false)

    // 임시 파일은 os.tmpdir() 아래에 만들어 JSON 으로 비밀값을 담았고, 끝나면 폴더째 지웠다
    expect(f.tempDirs).toHaveLength(1)
    expect(f.tempDirs[0].startsWith(path.join(TMP, 'nais3-cloud-'))).toBe(true)
    expect(JSON.parse(f.secretFileAtCall[0])).toEqual({ PC_SECRET: SECRET })
    expect(f.removed).toEqual(f.tempDirs)
    expect([...f.files.keys()].some((k) => k.startsWith(f.tempDirs[0]))).toBe(false)

    // 연결 파일
    expect(f.dirs).toEqual([path.dirname(connectFile)])
    const saved = f.files.get(connectFile)!
    expect(JSON.parse(saved.data)).toEqual({ url: WORKER_URL, secret: SECRET })
    expect(saved.mode).toBe(0o600)

    // 비밀값은 화면에 나오지 않는다
    expect(f.logs.join('\n')).not.toContain(SECRET)
    expect(f.logs[f.logs.length - 1]).toContain('완료')
  })

  it('--url 로 준 주소가 연결 파일에 적힌다. wrangler 가 알려 준 주소와 다르면 알려 준다', async () => {
    const f = fakeIo()
    const url = 'https://other.example.workers.dev'
    expect(await runDeploy(options({ url }), f.io)).toBe(0)
    expect(JSON.parse(f.files.get(connectFile)!.data).url).toBe(url)
    const out = f.logs.join('\n')
    expect(out).toContain('알림: 배포된 주소는')
    expect(out).toContain(WORKER_URL)
    expect(f.logs[f.logs.length - 1]).toBe(`완료: ${url}`)

    const same = fakeIo()
    expect(await runDeploy(options({ url: WORKER_URL }), same.io)).toBe(0)
    expect(same.logs.join('\n')).not.toContain('알림')
    expect(same.logs.join('\n')).not.toContain('배포 출력에 나온 주소')
    expect(JSON.parse(same.files.get(connectFile)!.data).url).toBe(WORKER_URL)
  })

  it('--url 을 줬으면 배포 출력에 주소가 없거나 여러 개여도 그 주소로 끝낸다', async () => {
    const url = 'https://other.example.workers.dev'
    const none = fakeIoWithDeployOutput('Deployed nais3-cloud triggers\nVersion ID: abc')
    expect(await runDeploy(options({ url }), none.io)).toBe(0)
    expect(JSON.parse(none.files.get(connectFile)!.data)).toEqual({ url, secret: SECRET })
    expect(none.logs.join('\n')).not.toContain('알림')

    const two = fakeIoWithDeployOutput(DEPLOY_OUTPUT([WORKER_URL, 'https://b.example.workers.dev']))
    expect(await runDeploy(options({ url }), two.io)).toBe(0)
    expect(JSON.parse(two.files.get(connectFile)!.data).url).toBe(url)
    expect(two.logs.join('\n')).toContain('알림: 배포된 주소는')
  })

  it('--url 이 없으면 배포 출력에 나온 주소 하나를 연결 파일에 적고 알려 준다', async () => {
    const f = fakeIo()
    expect(await runDeploy(options(), f.io)).toBe(0)
    expect(JSON.parse(f.files.get(connectFile)!.data)).toEqual({ url: WORKER_URL, secret: SECRET })
    const out = f.logs.join('\n')
    expect(out).toContain(`배포 출력에 나온 주소를 워커 주소로 씁니다: ${WORKER_URL}`)
    expect(out).not.toContain('알림')
    expect(out).not.toContain(SECRET)
    expect(f.logs[f.logs.length - 1]).toBe(`완료: ${WORKER_URL}`)

    // 같은 주소가 표준출력·표준오류에 여러 번 나와도 하나로 센다
    const repeated = fakeIoWithDeployOutput(DEPLOY_OUTPUT([WORKER_URL]), `  ${WORKER_URL}\n`)
    expect(await runDeploy(options(), repeated.io)).toBe(0)
    expect(JSON.parse(repeated.files.get(connectFile)!.data).url).toBe(WORKER_URL)

    // main() 도 같다 — 인자 없이 실행
    const viaMain = fakeIo()
    expect(await main([], viaMain.io as never)).toBe(0)
    expect(JSON.parse(viaMain.files.get(connectFile)!.data).url).toBe(WORKER_URL)
  })

  it('버킷이 없을 때만 만든다 (이름이 부분만 겹치는 버킷은 있는 것으로 치지 않는다)', async () => {
    const missing = fakeIo((args) =>
      args.slice(0, 3).join(' ') === 'r2 bucket list'
        ? okResult(BUCKET_LIST(['my-assets', 'nais3-cloud-old']))
        : undefined
    )
    expect(await runDeploy(options(), missing.io)).toBe(0)
    const w = missing.wranglerCalls()
    expect(w.filter((a) => a.startsWith('r2 bucket create'))).toEqual([
      `r2 bucket create ${BUCKET_NAME}`
    ])
    expect(w.indexOf(`r2 bucket create ${BUCKET_NAME}`)).toBeLessThan(
      w.findIndex((a) => a.startsWith('deploy'))
    )

    const empty = fakeIo((args) =>
      args.slice(0, 3).join(' ') === 'r2 bucket list' ? okResult('No R2 buckets found') : undefined
    )
    expect(await runDeploy(options(), empty.io)).toBe(0)
    expect(empty.wranglerCalls().some((a) => a.startsWith('r2 bucket create'))).toBe(true)

    const present = fakeIo()
    await runDeploy(options(), present.io)
    expect(present.wranglerCalls().some((a) => a.startsWith('r2 bucket create'))).toBe(false)
  })

  it('만들려는데 「이미 있음」이면 통과한다 (목록 형식을 못 알아본 경우)', async () => {
    const f = fakeIo((args) => {
      const key = args.slice(0, 3).join(' ')
      if (key === 'r2 bucket list') return okResult('(알 수 없는 형식)')
      if (key === 'r2 bucket create')
        return failResult('The bucket you tried to create already exists [code: 10004]')
      return undefined
    })
    expect(await runDeploy(options(), f.io)).toBe(0)
    expect(f.files.has(connectFile)).toBe(true)
  })

  it('--secrets-file 을 지원하지 않으면 deploy 뒤 secret put 으로 표준입력에 넣는다', async () => {
    const f = fakeIo((args) =>
      args[0] === 'deploy' && args[1] === '--help' ? okResult(HELP_WITHOUT) : undefined
    )
    expect(await runDeploy(options(), f.io)).toBe(0)
    const w = f.wranglerCalls()
    expect(w).toEqual(['r2 bucket list', 'deploy --help', 'deploy', 'secret put PC_SECRET'])
    const put = f.calls.find((c) => c.args[0] === 'secret')!
    expect(put.input).toBe(SECRET) // 인자가 아니라 표준입력
    expect(w.join(' ')).not.toContain(SECRET)
    expect(f.tempDirs).toEqual([]) // 임시 파일을 만들지 않는다
    expect(JSON.parse(f.files.get(connectFile)!.data)).toEqual({ url: WORKER_URL, secret: SECRET })
    expect(f.logs.join('\n')).not.toContain(SECRET)
  })
})

describe('deploy.mjs — 실패하면 그 자리에서 멈춘다', () => {
  /** 실패 뒤에는 연결 파일이 없고, 어느 단계인지 한국어로 나오고, 비밀값은 어디에도 없다 */
  function expectStopped(f: ReturnType<typeof fakeIo>, step: string): void {
    expect(f.files.has(connectFile)).toBe(false)
    const out = f.logs.join('\n')
    expect(out).toContain(`실패: ${step}`)
    expect(out).toContain('단계에서 멈췄습니다')
    expect(out).not.toContain(SECRET)
    expect(/[가-힣]/.test(out)).toBe(true)
  }

  it('1단계 빌드 실패 → wrangler 는 부르지 않는다', async () => {
    const f = fakeIo(undefined, { nodeResult: failResult('esbuild 오류') })
    expect(await runDeploy(options(), f.io)).toBe(1)
    expect(f.wranglerCalls()).toEqual([])
    expectStopped(f, '1/5')
    expect(f.logs.join('\n')).toContain('esbuild 오류')
  })

  it('2단계 버킷 목록 실패 → 배포하지 않는다 (로그인 안내가 붙는다)', async () => {
    const f = fakeIo((args) =>
      args.slice(0, 3).join(' ') === 'r2 bucket list' ? failResult('Not logged in') : undefined
    )
    expect(await runDeploy(options(), f.io)).toBe(1)
    expect(f.wranglerCalls()).toEqual(['r2 bucket list'])
    expectStopped(f, '2/5')
    expect(f.logs.join('\n')).toContain('wrangler login')
  })

  it('2단계 버킷 만들기 실패(이미 있음이 아닌 오류) → 배포하지 않는다', async () => {
    const f = fakeIo((args) => {
      const key = args.slice(0, 3).join(' ')
      if (key === 'r2 bucket list') return okResult(BUCKET_LIST([]))
      if (key === 'r2 bucket create') return failResult('R2 is not enabled for this account')
      return undefined
    })
    expect(await runDeploy(options(), f.io)).toBe(1)
    expect(f.wranglerCalls()).toEqual(['r2 bucket list', `r2 bucket create ${BUCKET_NAME}`])
    expectStopped(f, '2/5')
    expect(f.logs.join('\n')).toContain('R2 is not enabled')
  })

  it('4단계 배포 실패 → 임시 비밀 파일을 지우고, 출력에 비밀값이 섞여도 가린다', async () => {
    const f = fakeIo((args) =>
      args[0] === 'deploy' && args.includes('--secrets-file')
        ? failResult(`Uncaught error: ${SECRET} 가 거부됨`, 1)
        : undefined
    )
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '4/5')
    expect(f.tempDirs).toHaveLength(1)
    expect(f.removed).toEqual(f.tempDirs)
    expect(f.logs.join('\n')).toContain('Uncaught error: *** 가 거부됨')
  })

  it('4단계 도움말 확인 실패 → 배포하지 않는다', async () => {
    const f = fakeIo((args) =>
      args[0] === 'deploy' && args[1] === '--help' ? failResult('wrangler 오류') : undefined
    )
    expect(await runDeploy(options(), f.io)).toBe(1)
    expect(f.wranglerCalls()).toEqual(['r2 bucket list', 'deploy --help'])
    expectStopped(f, '4/5')
  })

  it('4단계 비밀값 등록(secret put) 실패 → 연결 파일을 쓰지 않는다', async () => {
    const f = fakeIo((args) => {
      if (args[0] === 'deploy' && args[1] === '--help') return okResult(HELP_WITHOUT)
      if (args[0] === 'secret') return failResult('등록 실패', 1)
      return undefined
    })
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '4/5')
  })

  it('--url 없이 배포했는데 출력에 워커 주소가 없으면 4단계에서 멈추고 --url 로 다시 실행하라고 알린다', async () => {
    const f = fakeIoWithDeployOutput('Deployed nais3-cloud triggers\nVersion ID: abc')
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '4/5')
    const out = f.logs.join('\n')
    expect(out).toContain('배포 출력에서 워커 주소(https://….workers.dev)를 찾지 못했습니다')
    expect(out).toContain('안내: 워커 배포는 끝났습니다. --url <주소> 를 붙여 다시 실행하면')
    expect(out).not.toContain('wrangler login') // 로그인 안내가 아니라 --url 안내가 나온다
    expect(out).not.toContain('완료')
    // 배포까지는 실제로 했고, 임시 비밀 파일은 지웠다
    expect(f.wranglerCalls().some((a) => a.startsWith('deploy --secrets-file'))).toBe(true)
    expect(f.tempDirs).toHaveLength(1)
    expect(f.removed).toEqual(f.tempDirs)
  })

  it('--url 없이 배포했는데 출력에 서로 다른 워커 주소가 둘이면 고르지 않고 멈춘다', async () => {
    const other = 'https://b.example.workers.dev'
    const f = fakeIoWithDeployOutput(DEPLOY_OUTPUT([WORKER_URL, other]))
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '4/5')
    const out = f.logs.join('\n')
    expect(out).toContain('배포 출력에 워커 주소가 여러 개라 하나로 정하지 못했습니다')
    expect(out).toContain(WORKER_URL)
    expect(out).toContain(other)
    expect(out).toContain('안내: 워커 배포는 끝났습니다. --url <주소> 를 붙여 다시 실행하면')
    expect(f.removed).toEqual(f.tempDirs)

    // main() 으로 인자 없이 실행해도 같은 자리에서 멈춘다
    const viaMain = fakeIoWithDeployOutput(DEPLOY_OUTPUT([WORKER_URL, other]))
    expect(await main([], viaMain.io as never)).toBe(1)
    expectStopped(viaMain, '4/5')
  })

  it('--url 없이 secret put 방식으로 배포했을 때도 주소를 못 찾으면 비밀값 등록 뒤에 멈춘다', async () => {
    const f = fakeIo((args) => {
      if (args[0] === 'deploy' && args[1] === '--help') return okResult(HELP_WITHOUT)
      if (args[0] === 'deploy') return okResult('Deployed nais3-cloud triggers')
      return undefined
    })
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '4/5')
    expect(f.wranglerCalls()).toEqual([
      'r2 bucket list',
      'deploy --help',
      'deploy',
      'secret put PC_SECRET'
    ])
    expect(f.logs.join('\n')).toContain('--url <주소>')
  })

  it('시간 초과나 끊김은 이유로 나온다', async () => {
    const f = fakeIo((args) =>
      args[0] === 'deploy' && args.includes('--secrets-file')
        ? { status: null, stdout: '', stderr: '', error: '시간이 너무 오래 걸려 멈췄습니다' }
        : undefined
    )
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '4/5')
    expect(f.logs.join('\n')).toContain('시간이 너무 오래 걸려 멈췄습니다')
  })

  it('wrangler 를 못 찾으면 안내와 함께 멈춘다', async () => {
    const f = fakeIo()
    f.io.wrangler = () => {
      throw new StepError('wrangler 를 찾지 못했습니다', 'npm i -g wrangler 로 설치해 주세요')
    }
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '2/5')
    expect(f.logs.join('\n')).toContain('안내: npm i -g wrangler')
  })

  it('5단계 연결 파일을 못 써도 비밀값은 안 보이고, 배포는 끝났다고 알린다', async () => {
    const f = fakeIo(undefined, { writeFails: true })
    expect(await runDeploy(options(), f.io)).toBe(1)
    expectStopped(f, '5/5')
    const out = f.logs.join('\n')
    expect(out).toContain('연결 파일을 쓰지 못했습니다')
    expect(out).toContain('워커 배포는 끝났습니다')
    expect(f.removed).toEqual(f.tempDirs) // 임시 파일은 여전히 지워진다
  })
})
