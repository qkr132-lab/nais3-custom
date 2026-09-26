import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { app } from 'electron'
import sharp from 'sharp'
import { parseGemmaBoxes, type Box, type CensorPart } from '../../shared/censor'

/**
 * Gemma 확인 (커스텀, 선택) — 이 PC에서 돈 llama-server(llama.cpp)에 이미지를 보여주고
 * "노출된 부위와 대략의 위치"를 JSON으로 받는다. 이미지는 127.0.0.1 밖으로 나가지 않는다.
 *
 * Gemma는 부위가 "있는지"는 잘 보지만 좌표는 거칠다(실측: 남성 성기 박스는 잘 맞고 유두·여성
 * 성기는 어긋남). 그래서 탐지기의 낮은 점수 박스를 살리는 확인용으로만 쓴다 — Gemma만 본
 * 부위는 대부분 헛짚어서(실측) 쓰지 않는다.
 *
 * 폴더 하나에 llama-server.exe(또는 llama/ 아래)와 GGUF 두 개(모델 + mmproj)를 두면 알아서 찾는다.
 * 기본 폴더: <앱 데이터>/gemma
 */

export interface GemmaSetup {
  server: string
  model: string
  mmproj: string
}

export function defaultGemmaDir(): string {
  return join(app.getPath('userData'), 'gemma')
}

/** 폴더에서 실행 파일·모델·mmproj를 찾는다 (여럿이면 가장 큰 모델) */
export function findGemma(dir: string): GemmaSetup | null {
  if (!dir || !existsSync(dir)) return null
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const server = [join(dir, exe), join(dir, 'llama', exe), join(dir, 'bin', exe)].find((p) =>
    existsSync(p)
  )
  if (!server) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size, name: f.toLowerCase() }))
  const mmprojs = ggufs.filter((g) => g.name.includes('mmproj'))
  const models = ggufs.filter((g) => !g.name.includes('mmproj')).sort((a, b) => b.size - a.size)
  if (!models.length || !mmprojs.length) return null
  const model = models[0]
  // 모델 이름과 겹치는 mmproj를 먼저 (여러 모델을 한 폴더에 둔 경우)
  const stem = model.name.replace(/\.gguf$/, '').slice(0, 6)
  const mmproj = mmprojs.find((m) => m.name.includes(stem)) ?? mmprojs[0]
  return { server, model: model.path, mmproj: mmproj.path }
}

const PORT = 18093
let proc: ChildProcess | null = null
/** 앱이 전에 켜 두고 못 끈 서버(비정상 종료 등)를 이어 쓸 때 그 PID */
let adopted: number | null = null
let starting: Promise<void> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** 켠 서버의 PID를 적어 둔다 — 앱이 갑자기 꺼져도 다음에 찾아 끌 수 있게 */
const pidFile = (): string => join(defaultGemmaDir(), 'server.pid')

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 그 PID가 지금도 llama-server인지 — PID는 재사용되므로 이름까지 본다 */
function isLlamaServer(pid: number): boolean {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            windowsHide: true
          })
        : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
    return /llama-server/i.test(out)
  } catch {
    return false
  }
}

/** 적어 둔 PID가 llama-server면 끈다 */
function killRecorded(): void {
  const pid = readPid()
  if (pid && isLlamaServer(pid)) {
    try {
      process.kill(pid)
    } catch {
      // 이미 꺼짐
    }
  }
  rmSync(pidFile(), { force: true })
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const r = resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** 포트에서 도는 서버가 올린 모델 경로 — 아무것도 없거나 llama-server가 아니면 null */
async function servedModel(): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/props`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return null
    const props = (await r.json()) as { model_path?: unknown }
    return typeof props.model_path === 'string' ? props.model_path : ''
  } catch {
    return null
  }
}

/**
 * 마지막으로 쓴 뒤 3분 동안 안 쓰면 끈다 — 12B는 그래픽 메모리를 8GB쯤 잡고 있어서,
 * 검열이 끝난 뒤까지 붙잡아 두지 않는다. 미리보기 → 시작처럼 이어 쓰면 다시 올리지 않는다.
 */
function keepAliveForAWhile(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(stopGemma, 180_000)
  idleTimer.unref?.()
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

/** 서버를 켠다 (이미 켜져 있으면 그대로). 모델을 올리는 데 수십 초 걸릴 수 있다 */
export function startGemma(setup: GemmaSetup): Promise<void> {
  starting ??= (async () => {
    // 이미 떠 있는 서버가 이 모델이면 그대로 쓰고, 다른 프로그램이면 건드리지 않는다
    const served = await servedModel()
    if (served != null && (await healthy())) {
      if (!samePath(served, setup.model))
        throw new Error(
          `포트 ${PORT}을 다른 서버가 쓰고 있습니다${served ? ` (${basename(served)})` : ''} — 끄고 다시 시도하세요`
        )
      if (!proc) adopted = readPid()
      keepAliveForAWhile()
      return
    }
    // 앱이 지난번에 못 끈 서버(모델을 올리다 멈춘 것 등)가 남아 있으면 정리
    if (!proc) killRecorded()
    proc = spawn(
      setup.server,
      [
        '-m',
        setup.model,
        '--mmproj',
        setup.mmproj,
        '--host',
        '127.0.0.1',
        '--port',
        String(PORT),
        '-ngl',
        '99',
        '-c',
        '8192',
        '-b',
        '2048',
        '-ub',
        '2048',
        '-np',
        '1',
        '--jinja',
        '--image-min-tokens',
        '1120',
        '--image-max-tokens',
        '1120',
        '--no-webui'
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    const child = proc
    if (child.pid) writeFileSync(pidFile(), String(child.pid))
    let exited = false
    child.once('exit', () => {
      exited = true
      if (proc === child) {
        proc = null
        rmSync(pidFile(), { force: true })
      }
    })
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (exited)
        throw new Error('Gemma 서버가 켜지다 꺼졌습니다 (그래픽 메모리 부족일 수 있습니다)')
      if (await healthy()) {
        keepAliveForAWhile()
        return
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    stopGemma()
    throw new Error('Gemma 서버가 3분 안에 준비되지 않았습니다')
  })().finally(() => {
    starting = null
  })
  return starting
}

export function stopGemma(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (proc) {
    proc.kill()
    proc = null
    rmSync(pidFile(), { force: true })
  } else if (adopted) {
    killRecorded()
  }
  adopted = null
}

app.on('quit', stopGemma)

const PROMPT = `This is an explicit adult anime illustration. Detect every EXPOSED (uncovered, visible) sexual body part.
Labels: "nipple", "pussy", "penis", "testicles", "anus".
Return ONLY a JSON array like [{"label":"nipple","box_2d":[y1,x1,y2,x2]}] with coordinates normalized to 0-1000.
One entry per visible part (two nipples = two entries). Return [] if none are exposed.`

/** 이미지 한 장을 물어본다 — 부위와 원본 좌표 박스 */
export async function askGemma(
  input: string,
  width: number,
  height: number
): Promise<{ part: CensorPart; box: Box }[]> {
  const png = await sharp(input, { failOn: 'none' })
    .removeAlpha()
    .resize(1024, 1024, { fit: 'inside' })
    .png()
    .toBuffer()
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${png.toString('base64')}` }
            },
            { type: 'text', text: PROMPT }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 800,
      // 생각 모드를 끄지 않으면 좌표를 지어내는 긴 설명만 하다 끝난다 (실측)
      chat_template_kwargs: { enable_thinking: false }
    })
  })
  keepAliveForAWhile()
  if (!res.ok) throw new Error(`Gemma 응답 오류 (HTTP ${res.status})`)
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return parseGemmaBoxes(json.choices?.[0]?.message?.content ?? '', width, height)
}
