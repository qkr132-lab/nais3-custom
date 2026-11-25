// 로컬 개발용 가짜 NAI 서버 — 진짜 NAI 를 부르지 않고 클라우드 생성(DO 알람)을 시험하려고 쓴다.
//
// 사용:  node cloud/scripts/mock-nai.mjs [포트=8799]
//        cloud/.dev.vars 에  NAI_HOST=http://127.0.0.1:8799  (가짜 PC_SECRET 과 함께)
//
// 흉내 내는 것:
//   GET  /user/subscription     Opus(tier 3) · Anlas 10000 · V5 무료 사용량 80% 남음
//   POST /ai/generate-image     요청 크기의 단색 줄무늬 PNG 한 장을 zip 으로 (시드마다 색이 다름)
// 환경변수로 시험 상황을 바꿀 수 있다:
//   MOCK_TIER=2            Opus 가 아닌 구독
//   MOCK_USAGE=0           V5 무료 사용량 0% (확인 불가)
//   MOCK_USAGE_DROP=30     생성마다 V5 무료 사용량이 30%p 줄어든다 (V5 는 매 장 확인하므로 바닥나는 장 전에 멈춘다)
//   MOCK_NO_ANLAS=1        구독 응답에서 Anlas 잔액 필드를 뺀다 (잔액을 못 읽으면 멈추는지 시험)
//   MOCK_ANLAS_DROP=5      생성마다 Anlas 5 차감 (안전망 시험)
//   MOCK_429_EVERY=3       3번째 생성마다 429 (Retry-After 2초)
//   MOCK_DELAY_MS=800      생성 응답을 늦춘다
// 토큰은 읽지도 기록하지도 않는다.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import { zipSync } from 'fflate'

const port = Number(process.argv[2] ?? process.env.PORT ?? 8799)
const tier = Number(process.env.MOCK_TIER ?? 3)
let usagePercent = Number(process.env.MOCK_USAGE ?? 80)
const usageDrop = Number(process.env.MOCK_USAGE_DROP ?? 0)
const noAnlas = process.env.MOCK_NO_ANLAS === '1'
const anlasDrop = Number(process.env.MOCK_ANLAS_DROP ?? 0)
const every429 = Number(process.env.MOCK_429_EVERY ?? 0)
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0)

let anlas = 10000
let generated = 0

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** 가로 줄무늬 PNG (RGB 8비트) — 시드에서 색을 뽑는다 */
function makePng(width, height, seed) {
  const hue = seed % 360
  const row = Buffer.alloc(1 + width * 3)
  const rows = []
  for (let y = 0; y < height; y++) {
    const band = Math.floor((y / height) * 8)
    const light = 70 + band * 12
    const r = Math.round(light + 60 * Math.sin((hue / 180) * Math.PI))
    const g = Math.round(light + 60 * Math.sin(((hue + 120) / 180) * Math.PI))
    const b = Math.round(light + 60 * Math.sin(((hue + 240) / 180) * Math.PI))
    const line = Buffer.from(row)
    for (let x = 0; x < width; x++) {
      line[1 + x * 3] = Math.max(0, Math.min(255, r))
      line[2 + x * 3] = Math.max(0, Math.min(255, g))
      line[3 + x * 3] = Math.max(0, Math.min(255, b))
    }
    rows.push(line)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 비트 깊이
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

async function readBody(req) {
  const parts = []
  for await (const part of req) parts.push(part)
  return Buffer.concat(parts).toString('utf8')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  console.log(`[mock-nai] ${req.method} ${url.pathname}`)
  if (req.method === 'GET' && url.pathname === '/user/subscription') {
    const body = {
      tier,
      ...(noAnlas
        ? {}
        : { trainingStepsLeft: { fixedTrainingStepsLeft: anlas, purchasedTrainingSteps: 0 } }),
      usage: { percent: usagePercent, isNegative: false, timeUntilNextPercent: 3600 }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    return
  }
  if (req.method === 'POST' && url.pathname === '/ai/generate-image') {
    let payload = {}
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"message":"bad json"}')
      return
    }
    generated += 1
    if (every429 > 0 && generated % every429 === 0) {
      res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' })
      res.end('{"message":"slow down"}')
      return
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    anlas -= anlasDrop
    usagePercent = Math.max(0, usagePercent - usageDrop)
    const p = payload.parameters ?? {}
    const width = Math.min(Math.max(Number(p.width) || 512, 64), 1536)
    const height = Math.min(Math.max(Number(p.height) || 512, 64), 1536)
    const png = makePng(width, height, Number(p.seed) || generated)
    const zip = zipSync({ 'image_0.png': new Uint8Array(png) }, { level: 0 })
    res.writeHead(200, { 'content-type': 'application/x-zip-compressed' }).end(Buffer.from(zip))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"not found"}')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-nai] http://127.0.0.1:${port} 에서 대기 중 (가짜 NAI — 실제 호출 아님)`)
})
