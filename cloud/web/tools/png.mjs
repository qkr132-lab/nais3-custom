// 작은 PNG·앱 아이콘을 외부 패키지 없이 만든다 — 웹 빌드(아이콘)와 모의 서버(가짜 그림)가 같이 쓴다.
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
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

/** RGB 8비트 픽셀(너비×높이×3바이트)을 PNG 바이트로 */
export function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 비트 깊이
  ihdr[9] = 2 // 색 유형: RGB
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── 앱 아이콘: 어두운 바탕 + 주황 N (512 기준 좌표) ──────────────────
const ICON_BG = [15, 15, 16]
const ICON_FG = [235, 149, 80]
const ICON_SHAPES = [
  [
    [150, 140],
    [198, 140],
    [198, 372],
    [150, 372]
  ],
  [
    [314, 140],
    [362, 140],
    [362, 372],
    [314, 372]
  ],
  [
    [150, 140],
    [206, 140],
    [362, 372],
    [306, 372]
  ]
]

function insidePolygon(poly, x, y) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 아이콘 SVG — 바탕은 가장자리까지 채워서 maskable 로도 쓴다 */
export function iconSvg() {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
    '<rect width="512" height="512" fill="#0f0f10"/>' +
    '<path d="M150 140h48v232h-48zM314 140h48v232h-48zM150 140h56l156 232h-56z" fill="#eb9550"/>' +
    '</svg>'
  )
}

/** 아이콘 PNG — 4×4 표본으로 가장자리를 부드럽게 */
export function iconPng(size) {
  const scale = 512 / size
  const sub = 4
  const rgb = Buffer.alloc(size * size * 3)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const x = (px + (sx + 0.5) / sub) * scale
          const y = (py + (sy + 0.5) / sub) * scale
          if (ICON_SHAPES.some((poly) => insidePolygon(poly, x, y))) hit++
        }
      }
      const t = hit / (sub * sub)
      const o = (py * size + px) * 3
      for (let c = 0; c < 3; c++)
        rgb[o + c] = Math.round(ICON_BG[c] + (ICON_FG[c] - ICON_BG[c]) * t)
    }
  }
  return encodePng(size, size, rgb)
}

// ── 모의 서버용 가짜 그림 ───────────────────────────────────────────
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

/** 색조(0~360) 하나로 위아래 그라데이션 + 사선 줄무늬를 넣은 작은 PNG */
export function gradientPng(width, height, hue) {
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const top = hslToRgb(hue, 0.45, 0.32 + 0.22 * (1 - y / height))
    for (let x = 0; x < width; x++) {
      const stripe = (x + y) % 24 < 3 ? 14 : 0
      const o = (y * width + x) * 3
      rgb[o] = Math.min(255, top[0] + stripe)
      rgb[o + 1] = Math.min(255, top[1] + stripe)
      rgb[o + 2] = Math.min(255, top[2] + stripe)
    }
  }
  return encodePng(width, height, rgb)
}
