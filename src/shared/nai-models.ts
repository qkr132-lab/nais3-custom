/**
 * NAI 모델 목록과 모델별 기능표.
 *
 * 확정 소스: NAI 웹 번들(`_app-*.js`)의 모델 기능 switch 문 실측 (2026-08-21).
 * 웹이 모델별로 어떤 UI를 켜고 끄는지가 그대로 들어 있어, 추측 없이 이식했다.
 * V4.5 → V5 차이는 정확히 12개 항목이고 나머지는 동일하다.
 *
 * 2026-11-25 재실측(b2fe159-production): V5 에 캐릭터 레퍼런스가 열렸다 —
 * characterReferences ✗→✓ 와 함께 레퍼런스 세부 키 5개(인페인트·그림 다듬기·충실도·강도 상한·의상)가
 * V4.5 와 다르다. 바이브 트랜스퍼는 여전히 V5 에 없다.
 *
 * 생성물 메타데이터(webp EXIF UserComment)로 교차 검증:
 * tests/fixtures/v5/ 4장 + 사용자 라이브러리 V4.5 이미지.
 */

export type NaiModelId =
  | 'nai-diffusion-4-5-full'
  | 'nai-diffusion-4-5-curated'
  | 'nai-diffusion-5-full'
  | 'nai-diffusion-5-curated'

export interface ModelCapabilities {
  /** 바이브 트랜스퍼 (V5 미지원) */
  vibeTransfer: boolean
  /** 캐릭터 레퍼런스 */
  characterReferences: boolean
  /** 인페인트(마스크) 요청에도 캐릭터 레퍼런스를 싣는가 (웹 기능표 charRefInpainting) */
  charRefInpainting: boolean
  /**
   * 레퍼런스 그림 다듬기 — canvas: 정해진 캔버스에 여백을 채워 맞춤(웹 resizeCharacterReferences) /
   * bucket: 비율이 가장 가까운 크기로 줄여 가운데를 자름(웹 bucketCharacterReferences)
   */
  charRefImage: 'canvas' | 'bucket'
  /** 충실도 조절 (웹 characterReferenceFidelity). 없는 모델은 늘 1로 보낸다 */
  charRefFidelity: boolean
  /** 강도 슬라이더 상한 (웹 characterReferenceStrengthMax) */
  charRefStrengthMax: number
  /** 의상 레퍼런스·「같은 옷 선호」 (웹 outfitReferences) */
  outfitReferences: boolean
  /** Variety+ (웹 기능표의 cfgDelay). V5는 UI 자체가 없다 */
  variety: boolean
  /** Variety+ 계수 (웹 기능표의 cfgDelaySigma). V4.5=58, V4=19 */
  varietySigma: number
  /** 노이즈 스케줄 선택 (V5는 고정) */
  noiseSchedule: boolean
  /** 활성 캐릭터 상한 */
  maxCharacters: number
  /** 캐릭터 1명일 때도 위치 지정 가능 */
  canPositionOneCharacter: boolean
  /** 좌표가 5×5 격자가 아니라 캔버스 자유 배치 */
  freeformCharacterPosition: boolean
  /** 투명 배경 (straight_alpha) */
  transparency: boolean
  /** Max 업스케일 강화 */
  maxEnhance: boolean
  /** Opus 무료 생성 한도 대상 모델 */
  opusUsageLimit: boolean
  /** SMEA 계열 */
  smea: boolean
  /** 인페인트용 짝 모델 id */
  inpaintModel: string
}

const V45: ModelCapabilities = {
  vibeTransfer: true,
  characterReferences: true,
  charRefInpainting: true,
  charRefImage: 'canvas',
  charRefFidelity: true,
  charRefStrengthMax: 1,
  outfitReferences: false,
  variety: true,
  varietySigma: 58,
  noiseSchedule: true,
  maxCharacters: 6,
  canPositionOneCharacter: false,
  freeformCharacterPosition: false,
  transparency: false,
  maxEnhance: false,
  opusUsageLimit: false,
  smea: false,
  inpaintModel: 'nai-diffusion-4-5-full-inpainting'
}

const V5: ModelCapabilities = {
  vibeTransfer: false,
  characterReferences: true,
  charRefInpainting: false,
  charRefImage: 'bucket',
  charRefFidelity: false,
  charRefStrengthMax: 5,
  outfitReferences: true,
  variety: false,
  varietySigma: 58,
  noiseSchedule: false,
  maxCharacters: 32,
  canPositionOneCharacter: true,
  freeformCharacterPosition: true,
  transparency: true,
  maxEnhance: true,
  opusUsageLimit: true,
  smea: false,
  inpaintModel: 'nai-diffusion-5-full-inpainting'
}

export const MODEL_CAPABILITIES: Record<NaiModelId, ModelCapabilities> = {
  'nai-diffusion-4-5-full': V45,
  'nai-diffusion-4-5-curated': {
    ...V45,
    inpaintModel: 'nai-diffusion-4-5-curated-inpainting'
  },
  'nai-diffusion-5-full': V5,
  'nai-diffusion-5-curated': {
    ...V5,
    // 출시 시점엔 V5 Curated 인페인트가 없어 V4.5 Curated로 대체된다 (공식 안내)
    inpaintModel: 'nai-diffusion-4-5-curated-inpainting'
  }
}

export const MODEL_OPTIONS: { value: NaiModelId; label: string }[] = [
  { value: 'nai-diffusion-5-full', label: 'V5 Full' },
  { value: 'nai-diffusion-5-curated', label: 'V5 Curated' },
  { value: 'nai-diffusion-4-5-full', label: 'V4.5 Full' },
  { value: 'nai-diffusion-4-5-curated', label: 'V4.5 Curated' }
]

/**
 * 모르는 모델 id는 V4.5 Full 기준으로 (구버전 예약·메타데이터 복원 대비).
 * 인페인트 짝 모델(`…-inpainting`)은 웹 기능표에서 본 모델과 같은 칸이라 본 모델 것을 돌려준다
 * (예전엔 V5 인페인트가 V4.5 기준으로 떨어져 바이브·Variety+·노이즈 스케줄이 V4.5 식으로 나갔다).
 */
export function modelCaps(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model.replace(/-inpainting$/, '') as NaiModelId] ?? V45
}

/** 실제로 보낼 모델 — 마스크가 있으면 인페인트 짝 모델 (V5 Curated 는 V4.5 Curated 인페인트) */
export function sentModel(model: string, hasMask: boolean): string {
  return hasMask && !model.includes('inpainting') ? modelCaps(model).inpaintModel : model
}

export function isV5(model: string): boolean {
  return model.startsWith('nai-diffusion-5')
}

/** V5는 노이즈 스케줄 선택이 없다 — 웹 실측값(karras) 고정 */
export function effectiveNoiseSchedule(model: string, noiseSchedule: string): string {
  return modelCaps(model).noiseSchedule ? noiseSchedule : 'karras'
}
