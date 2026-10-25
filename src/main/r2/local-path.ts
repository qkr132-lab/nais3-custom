import { isAbsolute, relative, resolve, sep } from 'path'

/**
 * R2 내려받기 경로 (커스텀) — 키를 사용자가 고른 폴더 안의 상대 경로로 바꾼다.
 * electron 을 끌어오지 않는 순수 함수라 따로 두었다.
 */

/**
 * 내려받을 때의 상대 경로 — 지금 보고 있는 폴더(base)를 기준으로 하위 구조를 그대로 둔다.
 * Windows에서 못 쓰는 글자는 `_`로. 점과 공백만 있는 조각(`.`·`..`·`...`)은 폴더 밖으로
 * 나가는 길이 되므로 버린다. 남는 조각이 없으면 `_`.
 */
export function localRelative(key: string, base: string): string {
  const rel = base && key.startsWith(base) ? key.slice(base.length) : key
  const parts = rel
    .split('/')
    .filter((seg) => seg !== '' && !/^[. ]+$/.test(seg))
    .map((seg) => seg.replace(/[\\:*?"<>|]/g, '_'))
  return parts.length ? parts.join('/') : '_'
}

/** path 가 dir 안쪽(dir 자신은 제외)인지 */
export function isInsideDir(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
