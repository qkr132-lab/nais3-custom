/** 카드 태그 씬 맞춤 값 (커스텀) — undefined 따름 · true 켬 · false 끔 */
export type CardFitChoice = boolean | undefined

/** 버튼·알림에 쓰는 짧은 이름 */
export const cardFitLabel = (value: CardFitChoice): string =>
  value === undefined ? '따름' : value ? '켬' : '끔'
