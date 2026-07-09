import { basename, extname } from 'path'

/** 파일 시스템에서 못 쓰는 문자를 _ 로 치환 (경로 구분자 포함) */
export const safeName = (s: string): string => s.replace(/[/\\:*?"<>|]/g, '_').trim()

/**
 * 내보내기 파일명 = 씬 이름 그대로 (커스텀). 디스크 저장명의 "_번호"(예: 감동_4)는 버리고
 * 씬 이름만 남긴다. 같은 대상(폴더) 안에서 이름이 겹치면(같은 씬 여러 장 등) " (2)", " (3)"…을
 * 붙여 유니크하게 만든다.
 *
 * @param sceneName 씬 이름 (없으면 디스크명에서 끝의 _번호만 떼어 사용)
 * @param filePath  원본 파일 경로 (확장자 추출용)
 * @param used      이미 배정된 이름 집합(폴더별·소문자). 호출 간 공유해 중복 방지
 * @param folderKey 유니크 판정 범위 — 씬별 폴더로 나눌 때 폴더마다 독립 카운트.
 *                  safeName 이 '/'를 제거하므로 구분자로 안전.
 */
export function assignExportName(
  sceneName: string | null,
  filePath: string,
  used: Set<string>,
  folderKey = '.'
): string {
  const ext = extname(filePath) || '.png'
  const base =
    safeName(sceneName ?? '') ||
    basename(filePath, extname(filePath)).replace(/_\d+$/, '') ||
    '이미지'
  let fname = `${base}${ext}`
  let n = 2
  while (used.has(`${folderKey}/${fname.toLowerCase()}`)) {
    fname = `${base} (${n})${ext}`
    n++
  }
  used.add(`${folderKey}/${fname.toLowerCase()}`)
  return fname
}
