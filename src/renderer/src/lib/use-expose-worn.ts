import { useOutfitsStore } from '../stores/outfits-store'

/**
 * 「입은 옷 자동 젖힘」 전체 설정 (설정 키 expose_worn_clothes, 기본 꺼짐). 끄면 요청에 메모도 태그도 실리지 않고
 * 출력이 이 기능이 없던 때와 글자 단위로 같다. 설정 창·씬 상세·복장 선택이 같은 값을 본다.
 */
export function useExposeWorn(): [boolean, (on: boolean) => void] {
  const on = useOutfitsStore((s) => s.exposeWorn)
  const set = useOutfitsStore((s) => s.setExposeWorn)
  return [on, set]
}
