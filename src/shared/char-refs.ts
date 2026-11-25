import { CHARREF_BUCKETS } from './char-ref-buckets'
import { modelCaps, sentModel } from './nai-models'
import type { CharRefType } from './types'

/**
 * 캐릭터 레퍼런스의 모델별 전송 규칙 — NAI 웹 번들(2026-11-25) 실측을 그대로 옮긴 것.
 *
 * 웹이 생성 직전에 하는 일:
 * - 마스크(인페인트)가 있는데 그 모델이 인페인트 레퍼런스를 못 받으면 레퍼런스를 통째로 뺀다
 * - 의상 레퍼런스를 못 받는 모델(V4.5)이면 `costume` 은 빼고, 「같은 옷 선호」로 갈린 유형은
 *   기본 유형으로 내린다 (character_mainoutfit → character, character&style_anyoutfit → character&style)
 * - 충실도가 없는 모델(V5)이면 충실도를 1로 보낸다
 */
export interface CharRefRule {
  /** 이 요청에 레퍼런스가 실리는가 */
  send: boolean
  /** 의상 레퍼런스·「같은 옷 선호」를 받는가 */
  outfit: boolean
  /** 충실도를 조절할 수 있는가 */
  fidelity: boolean
  /** 강도 슬라이더 상한 */
  strengthMax: number
  /** 그림 다듬기 방식 */
  image: 'canvas' | 'bucket'
}

/** model 은 고른 모델 그대로 넘겨도 되고(마스크가 있으면 짝 모델로 바꿔 본다) 이미 바꾼 짝 모델이어도 된다 */
export function charRefRule(model: string, hasMask = false): CharRefRule {
  const caps = modelCaps(sentModel(model, hasMask))
  return {
    send: caps.characterReferences && (!hasMask || caps.charRefInpainting),
    outfit: caps.outfitReferences,
    fidelity: caps.charRefFidelity,
    strengthMax: caps.charRefStrengthMax,
    image: caps.charRefImage
  }
}

/** 이 규칙으로 실제로 보낼 유형. null 이면 이 모델에는 실리지 않는다 */
export function sentCharRefType(rule: CharRefRule, type: string): string | null {
  if (!rule.send) return null
  if (rule.outfit) return type
  if (type === 'costume') return null
  return charRefFamily(type)
}

/** 보낼 충실도 — 충실도가 없는 모델은 1 */
export function sentCharRefFidelity(rule: CharRefRule, fidelity: number): number {
  return rule.fidelity ? fidelity : 1
}

/** 켜 둔 레퍼런스 가운데 이 모델에 실제로 실리는 수 (사용료 추정용) */
export function countSentCharRefs(
  model: string,
  refs: readonly { refType: string }[],
  hasMask = false
): number {
  const rule = charRefRule(model, hasMask)
  return refs.filter((r) => sentCharRefType(rule, r.refType) !== null).length
}

/** 「같은 옷 선호」로 갈린 유형을 기본 유형으로 (유형 고르기 칸에 보이는 값) */
export function charRefFamily(type: string): string {
  if (type === 'character_mainoutfit') return 'character'
  if (type === 'character&style_anyoutfit') return 'character&style'
  return type
}

/**
 * 「같은 옷 선호」 상태. 이 스위치가 없는 유형(스타일·의상·델타)은 null.
 * 웹과 같게 캐릭터는 character_mainoutfit 이 켬, 캐릭터+스타일은 character&style 이 켬이다.
 */
export function prefersSameOutfit(type: string): boolean | null {
  if (type === 'character') return false
  if (type === 'character_mainoutfit') return true
  if (type === 'character&style') return true
  if (type === 'character&style_anyoutfit') return false
  return null
}

/** 「같은 옷 선호」를 켜고 끈 유형. 스위치가 없는 유형은 그대로 */
export function withSameOutfit(type: CharRefType, on: boolean): CharRefType {
  const family = charRefFamily(type)
  if (family === 'character') return on ? 'character_mainoutfit' : 'character'
  if (family === 'character&style') return on ? 'character&style' : 'character&style_anyoutfit'
  return type
}

export interface CharRefBucket {
  /** 보낼 크기 */
  width: number
  height: number
  /** 이 크기로 먼저 줄이고(늘리고) */
  resizeWidth: number
  resizeHeight: number
  /** 여기서부터 보낼 크기만큼 자른다 */
  left: number
  top: number
  /** 이미 버킷 크기 그대로라 손댈 것이 없다 */
  unchanged: boolean
}

/** V5 레퍼런스 그림을 맞출 버킷 — 비율(로그 차)이 가장 가까운 크기를 덮도록 줄여 가운데를 자른다 */
export function charRefBucket(width: number, height: number): CharRefBucket {
  const ratio = Math.log(Math.max(width, 1) / Math.max(height, 1))
  let best = CHARREF_BUCKETS[0]
  let bestDiff = Math.abs(ratio - Math.log(best[0] / best[1]))
  for (const bucket of CHARREF_BUCKETS) {
    const diff = Math.abs(ratio - Math.log(bucket[0] / bucket[1]))
    if (diff < bestDiff) {
      best = bucket
      bestDiff = diff
    }
  }
  const [w, h] = best
  const scale = Math.max(w / width, h / height)
  const resizeWidth = Math.max(Math.floor(width * scale + 0.5), w)
  const resizeHeight = Math.max(Math.floor(height * scale + 0.5), h)
  return {
    width: w,
    height: h,
    resizeWidth,
    resizeHeight,
    left: Math.floor((resizeWidth - w) / 2),
    top: Math.floor((resizeHeight - h) / 2),
    unchanged: width === w && height === h
  }
}
