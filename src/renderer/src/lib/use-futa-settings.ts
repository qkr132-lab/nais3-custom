import { useOutfitsStore } from '../stores/outfits-store'

/**
 * 「후타 자동 재조립」 (설정 키 futa_reassembly, 기본 꺼짐) — 끄면 후타 재조립 전부 꺼져
 * 출력이 이 기능이 없던 때와 글자 단위로 같다. 설정 창·씬 상세·메인 탭이 같은 값을 본다.
 */
export function useFutaReassembly(): [boolean, (on: boolean) => void] {
  const on = useOutfitsStore((s) => s.futaReassembly)
  const set = useOutfitsStore((s) => s.setFutaReassembly)
  return [on, set]
}

/**
 * 「후타 시점·구도 정리」 (설정 키 futa_view_fix, 기본 켬) — 후타 재조립 가운데 시점·구도(pov → from side,
 * head out of frame·lower body·penis focus 빼기)만 따로 끈다. 후타 재조립이 꺼져 있으면 아무 일도 하지 않는다.
 */
export function useFutaViewFix(): [boolean, (on: boolean) => void] {
  const on = useOutfitsStore((s) => s.futaViewFix)
  const set = useOutfitsStore((s) => s.setFutaViewFix)
  return [on, set]
}
