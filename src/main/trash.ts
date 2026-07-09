import { shell } from 'electron'
import { existsSync } from 'fs'

/**
 * 파일을 OS 휴지통(윈도우 휴지통 / macOS 휴지통)으로 보낸다 (커스텀 — 실수 복원용).
 * 영구 삭제(unlink) 대신 사용 — 사용자가 탐색기 휴지통에서 되살릴 수 있다.
 * 실패해도 throw하지 않음 (best-effort — 파일이 이미 없거나 권한 문제 등).
 */
export async function trashFile(filePath: string): Promise<void> {
  if (!filePath || !existsSync(filePath)) return
  try {
    await shell.trashItem(filePath)
  } catch {
    // 휴지통 이동 실패는 조용히 무시 (레코드는 이미 지워짐)
  }
}
