import { useOutfitsStore } from '../stores/outfits-store'

/**
 * 「눈 감으면 눈 태그 빼기」 (설정 키 eyes_closed_strip, 기본 꺼짐) — 끄면 카드의 눈 외형 태그를 읽지 않아
 * 출력이 이 기능이 없던 때와 글자 단위로 같다. 설정 창·씬 상세·메인 탭이 같은 값을 본다.
 */
export function useEyesClosedStrip(): [boolean, (on: boolean) => void] {
  const on = useOutfitsStore((s) => s.eyesClosedStrip)
  const set = useOutfitsStore((s) => s.setEyesClosedStrip)
  return [on, set]
}

/**
 * 「알몸일 때 pink nipples」 (설정 키 nude_pink_nipples, 기본 꺼짐) — 끄면 알몸 여성 몸에 pink nipples 를 더하지 않아
 * 출력이 이 기능이 없던 때와 글자 단위로 같다. 설정 창·씬 상세·메인 탭이 같은 값을 본다.
 */
export function useNudePinkNipples(): [boolean, (on: boolean) => void] {
  const on = useOutfitsStore((s) => s.nudePinkNipples)
  const set = useOutfitsStore((s) => s.setNudePinkNipples)
  return [on, set]
}
