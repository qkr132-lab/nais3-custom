/**
 * NAI 모델 목록과 모델별 기능표.
 *
 * 확정 소스: NAI 웹 번들(`_app-*.js`)의 모델 기능 switch 문 실측 (2026-08-21).
 * 웹이 모델별로 어떤 UI를 켜고 끄는지가 그대로 들어 있어, 추측 없이 이식했다.
 * V4.5 → V5 차이는 정확히 12개 항목이고 나머지는 동일하다.
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
  /** 바이브 트랜스퍼 (V5 미지원 — "still cooking") */
  vibeTransfer: boolean
  /** 캐릭터 레퍼런스 (V5 미지원) */
  characterReferences: boolean
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
  characterReferences: false,
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

/** 모르는 모델 id는 V4.5 Full 기준으로 (구버전 예약·메타데이터 복원 대비) */
export function modelCaps(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model as NaiModelId] ?? V45
}

export function isV5(model: string): boolean {
  return model.startsWith('nai-diffusion-5')
}

/** V5는 노이즈 스케줄 선택이 없다 — 웹 실측값(karras) 고정 */
export function effectiveNoiseSchedule(model: string, noiseSchedule: string): string {
  return modelCaps(model).noiseSchedule ? noiseSchedule : 'karras'
}
