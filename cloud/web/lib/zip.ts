/**
 * 클라우드 생성분은 NAI 응답 zip 그대로 저장돼 있다. 폰이 풀어서 첫 PNG 를 꺼낸다.
 * (워커는 무료 요금제 CPU 한도 때문에 압축을 풀지 않는다.)
 */
import { unzipSync } from 'fflate'

/** zip 은 `PK` 로 시작한다 */
export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/** zip 안의 첫 PNG 를 꺼낸다. 다른 파일은 압축을 풀지 않는다 */
export function extractFirstPng(zip: Uint8Array): Uint8Array {
  let picked: string | null = null
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        if (picked || !/\.png$/i.test(file.name)) return false
        picked = file.name
        return true
      }
    })
  } catch {
    throw new Error('그림 압축 파일을 열 수 없습니다')
  }
  const bytes = picked ? files[picked] : undefined
  if (!bytes || bytes.length === 0) throw new Error('압축 파일 안에 그림이 없습니다')
  return bytes
}
