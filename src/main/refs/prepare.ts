import { readFileSync } from 'fs'
import type { CharacterReferenceOptions, VibeOptions } from '../nai/payload'
import { ENDPOINTS } from '../nai/endpoints'
import { charRefRule, sentCharRefType } from '../../shared/char-refs'
import { processCharRefImage } from './charref-image'
import { enabledCharRefRows, enabledVibeRows, saveVibeEncoding } from './repo'

/** 지금 인코딩 중인 바이브 (바이브 id + 정보 추출값 → 진행 중 요청).
 *  고속 모드로 작업자 둘이 같은 미인코딩 바이브를 동시에 만나도 인코딩(2 Anlas)은 한 번만 나간다 */
const encodingNow = new Map<string, Promise<string>>()

/** 바이브 한 장을 인코딩해 DB 캐시에 저장하고 base64 를 돌려준다 */
async function encodeVibeOnce(
  token: string,
  row: { id: number; filePath: string; infoExtracted: number }
): Promise<string> {
  const res = await fetch(ENDPOINTS.encodeVibe, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: readFileSync(row.filePath).toString('base64'),
      information_extracted: row.infoExtracted,
      model: 'nai-diffusion-4-5-full'
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`바이브 인코딩 실패 ${res.status}: ${text.slice(0, 200)}`)
  }
  const encoded = Buffer.from(await res.arrayBuffer()).toString('base64')
  saveVibeEncoding(row.id, encoded, row.infoExtracted)
  return encoded
}

/** 생성 직전 바이브 준비 — 미인코딩/ie 변경분만 encode-vibe (2 Anlas) 후 캐시.
 *  newlyEncoded: 이번에 새로 인코딩된 바이브 id (카드 표시 갱신 통지용) */
export async function prepareVibes(
  token: string,
  ids?: number[]
): Promise<{ vibes: VibeOptions[]; newlyEncoded: number[] }> {
  const rows = enabledVibeRows(ids)
  const vibes: VibeOptions[] = []
  const newlyEncoded: number[] = []
  for (const row of rows) {
    let encoded = row.encoded
    if (!encoded || row.encodedIe !== row.infoExtracted) {
      const key = `${row.id}:${row.infoExtracted}`
      const pending = encodingNow.get(key)
      if (!pending) {
        // 처음 읽은 목록 뒤에 다른 작업자가 이미 끝냈을 수 있다 — 지금 값을 다시 확인
        const current = enabledVibeRows([row.id])[0]
        if (current?.encoded && current.encodedIe === row.infoExtracted) {
          encoded = current.encoded
        } else {
          const started = encodeVibeOnce(token, row)
          encodingNow.set(key, started)
          // 끝나면(성공이든 실패든) 목록에서 뺀다 — 실패는 기다리던 쪽이 각자 받는다
          const forget = (): void => {
            if (encodingNow.get(key) === started) encodingNow.delete(key)
          }
          started.then(forget, forget)
          encoded = await started
          // 인코딩을 시작한 쪽만 새로 인코딩했다고 알린다
          newlyEncoded.push(row.id)
        }
      } else {
        encoded = await pending
      }
    }
    vibes.push({ strength: row.strength, encodedVibeBase64: encoded })
  }
  return { vibes, newlyEncoded }
}

/**
 * 생성 직전 캐릭레퍼 준비. 이 모델에 실리지 않는 레퍼런스(인페인트 제외·의상 미지원)는
 * 그림을 읽지도 않는다 — 유형·충실도를 모델에 맞추는 것은 payload 가 같은 규칙으로 한다.
 */
export async function prepareCharRefs(
  ids: number[] | undefined,
  model: string,
  hasMask: boolean
): Promise<CharacterReferenceOptions[]> {
  const rule = charRefRule(model, hasMask)
  if (!rule.send) return []
  const result: CharacterReferenceOptions[] = []
  for (const row of enabledCharRefRows(ids)) {
    if (sentCharRefType(rule, row.refType) === null) continue
    result.push({
      referenceType: row.refType as CharacterReferenceOptions['referenceType'],
      strength: row.strength,
      fidelity: row.fidelity,
      imageBase64: (await processCharRefImage(readFileSync(row.filePath), rule.image)).toString(
        'base64'
      )
    })
  }
  return result
}
