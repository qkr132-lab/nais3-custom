import { readFileSync } from 'fs'

/**
 * 스타일(작가) 태그 분석 — Hugging Face Space Kaloscope (NAIS2 스마트 도구 이식).
 * 공개 Gradio API라 별도 키 불필요. 인터넷 연결 필요.
 */

export interface StyleTag {
  label: string
  score: number
}

const SPACE = 'DraconicDragon/Kaloscope-artist-style-classifier'

export async function analyzeStyle(input: {
  filePath?: string
  base64?: string
}): Promise<StyleTag[]> {
  const buf = input.filePath
    ? readFileSync(input.filePath)
    : Buffer.from((input.base64 ?? '').replace(/^data:[^,]+,/, ''), 'base64')
  if (buf.length === 0) throw new Error('분석할 이미지가 없습니다')

  // @gradio/client는 ESM 전용 — CJS 번들에서 동적 import로 로드
  const { Client } = await import('@gradio/client')
  const client = await Client.connect(SPACE)
  const result = await client.predict('/predict', {
    image: new Blob([new Uint8Array(buf)], { type: 'image/png' })
  })

  const raw = (result.data as unknown[])?.[0]
  if (typeof raw === 'string') {
    // "artist_a, artist_b, ..." 형태 — 순서 기반 점수
    return raw
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((artist, i) => ({ label: `artist:${artist}`, score: 1 - i * 0.05 }))
  }
  if (raw && typeof raw === 'object') {
    // { label: score } 형태
    return Object.entries(raw as Record<string, number>)
      .map(([label, score]) => ({ label: `artist:${label}`, score }))
      .sort((a, b) => b.score - a.score)
  }
  return []
}
