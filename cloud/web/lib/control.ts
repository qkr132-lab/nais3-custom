/**
 * 폰 → PC 제어 명령 만들기 — 폰이 보내는 제어는 전부 여기서만 만든다.
 * 종류(kind)와 필드 이름은 src/shared/cloud-contract.ts 의 CloudControlAction 과
 * PC 처리부(src/main/cloud/index.ts 의 handleControlOp)를 그대로 따른다.
 */
import type { CloudControlAction } from '@shared/cloud-contract'

/** 「PC 그림 동기화」가 PC에 올려 달라고 하는 최근 그림 장수 — PC 처리부가 장수 없이 받았을 때 쓰는 값과 같다 */
export const RECENT_UPLOAD_COUNT = 200

export const pcControl = {
  /** 모든 계정의 잔액·게이지를 다시 조회 */
  refreshAccounts: (): CloudControlAction => ({ kind: 'accounts:refresh' }),
  /** 쓸 계정 바꾸기 */
  setActiveAccount: (accountId: string): CloudControlAction => ({
    kind: 'account:setActive',
    accountId
  }),
  /** 고속 모드 켜기/끄기 */
  setTurbo: (enabled: boolean): CloudControlAction => ({ kind: 'turbo:set', enabled }),
  /** 자동 계정 전환 켜기/끄기 */
  setAutoSwitch: (enabled: boolean): CloudControlAction => ({ kind: 'autoSwitch:set', enabled }),
  /** PC가 만든 최근 그림을 클라우드로 올리기 */
  uploadRecentImages: (): CloudControlAction => ({
    kind: 'images:uploadRecent',
    count: RECENT_UPLOAD_COUNT
  }),
  /** PC 폴더 색인을 다시 훑어 올리기 */
  refreshDriveIndex: (): CloudControlAction => ({ kind: 'drive:refreshIndex' }),
  /** PC 폴더 안에 하위 폴더 만들기 */
  makeDriveFolder: (relPath: string): CloudControlAction => ({ kind: 'drive:mkdir', relPath }),
  /** 프리셋 그림을 PC 폴더의 하위 경로로 내보내기 */
  exportPresetToDrive: (presetId: number, relPath: string): CloudControlAction => ({
    kind: 'drive:exportPreset',
    presetId,
    relPath
  }),
  /** 폴더 안 그림의 미리보기를 클라우드로 올리기 */
  syncDriveFolder: (relPath: string): CloudControlAction => ({ kind: 'drive:syncFolder', relPath })
}
