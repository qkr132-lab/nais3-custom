/**
 * NAI 엔드포인트.
 *
 * 2026-06 이전: user 계열이 api.novelai.net에서 image.novelai.net으로 이동했다.
 * NAIS3는 전 호출을 image 호스트 단일로 사용한다. 예외: /ai/upscale은
 * api.novelai.net에만 잔존 (2026-07-04 확인, docs/nai-api-2026-07.md).
 */
export const NAI_HOST = 'https://image.novelai.net'

export const ENDPOINTS = {
  generateImage: `${NAI_HOST}/ai/generate-image`,
  generateImageStream: `${NAI_HOST}/ai/generate-image-stream`,
  suggestTags: `${NAI_HOST}/ai/generate-image/suggest-tags`,
  encodeVibe: `${NAI_HOST}/ai/encode-vibe`,
  augmentImage: `${NAI_HOST}/ai/augment-image`,
  login: `${NAI_HOST}/user/login`,
  userData: `${NAI_HOST}/user/data`,
  userInfo: `${NAI_HOST}/user/information`,
  subscription: `${NAI_HOST}/user/subscription`,
  // 충전 아이템(Opus Usage Boost) 등 인벤토리 — 웹 번들 실측 (2026-10-29).
  // 사용 주소는 이 뒤에 /{id}/consume (client.ts consumeItem). 값은 문자열만 둔다 (모바일 대체본과 대조)
  inventory: `${NAI_HOST}/user/inventory`,
  // 예외: image 호스트에는 없음 (404). api 호스트에 잔존.
  upscale: 'https://api.novelai.net/ai/upscale'
} as const
