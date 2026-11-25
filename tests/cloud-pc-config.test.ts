import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_DIR_NAME,
  KEEP_IMAGES_DEFAULT,
  clampKeepImages,
  cloudConfig,
  connectFilePath,
  getPcSecret,
  importConnectFile,
  parseConnectFile
} from '../src/main/cloud/config'

/**
 * 모바일 클라우드 — 연결 설정과 연결 파일 가져오기 (커스텀). 가짜 비밀값·임시 폴더만 쓴다.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  dir: '',
  encryption: true
}))

vi.mock('electron', () => ({
  // 연결 파일은 홈 폴더 아래 「NAIS3 Custom 폰 연결」에서 찾는다 — 시험은 임시 폴더를 홈으로 준다
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => state.encryption,
    encryptString: (s: string) => Buffer.from(`ENC:${s}`),
    decryptString: (b: Buffer) => {
      const text = b.toString()
      if (!text.startsWith('ENC:')) throw new Error('복호화 실패')
      return text.slice(4)
    }
  }
}))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => state.settings[key] ?? null,
  setSetting: (key: string, value: string) => {
    state.settings[key] = value
  }
}))

const SECRET = 'fake-secret-ABCDEFGHIJKLMNOP'

beforeEach(() => {
  state.settings = {}
  state.encryption = true
  state.dir = mkdtempSync(join(tmpdir(), 'nais-cloud-config-'))
})
afterEach(() => rmSync(state.dir, { recursive: true, force: true }))

describe('parseConnectFile', () => {
  it('https 주소와 비밀값을 읽는다 (끝의 / 와 BOM 은 정리)', () => {
    expect(
      parseConnectFile(
        `${String.fromCharCode(0xfeff)}{ "url": " https://nais3-cloud.example.workers.dev/ ", "secret": " ${SECRET} " }`
      )
    ).toEqual({ url: 'https://nais3-cloud.example.workers.dev', secret: SECRET })
  })

  it('로컬 개발 주소(http://localhost 계열)는 허용한다', () => {
    expect(parseConnectFile(`{"url":"http://127.0.0.1:8787","secret":"${SECRET}"}`)?.url).toBe(
      'http://127.0.0.1:8787'
    )
    expect(parseConnectFile(`{"url":"http://localhost:8787/","secret":"${SECRET}"}`)?.url).toBe(
      'http://localhost:8787'
    )
  })

  it('평문 http(원격)·주소 모양이 틀린 것·빈 비밀값·깨진 JSON 은 거부한다', () => {
    for (const text of [
      `{"url":"http://evil.example.com","secret":"${SECRET}"}`,
      `{"url":"ftp://x.example.com","secret":"${SECRET}"}`,
      `{"url":"https://a.example.com/path","secret":"${SECRET}"}`,
      `{"url":"https://a.example.com","secret":""}`,
      `{"url":"https://a.example.com","secret":"has space"}`,
      `{"url":"https://a.example.com"}`,
      `{"url":5,"secret":"${SECRET}"}`,
      `[1,2]`,
      `{깨짐`
    ]) {
      expect(parseConnectFile(text), text).toBeNull()
    }
  })
})

describe('importConnectFile', () => {
  const write = (text: string): void => {
    mkdirSync(dirname(connectFilePath()), { recursive: true })
    writeFileSync(connectFilePath(), text)
  }

  it('파일이 없으면 아무것도 안 한다', () => {
    expect(importConnectFile()).toBe('none')
    expect(state.settings).toEqual({})
  })

  it('읽어서 비밀값은 암호화해 저장하고, 주소를 저장하고, 파일을 지운다', () => {
    write(JSON.stringify({ url: 'https://a.example.workers.dev', secret: SECRET }))
    expect(importConnectFile()).toBe('imported')
    expect(existsSync(connectFilePath())).toBe(false)
    expect(state.settings.cloud_url).toBe('https://a.example.workers.dev')
    // 저장된 값은 평문이 아니다
    expect(state.settings.cloud_pc_secret_encrypted).not.toContain(SECRET)
    expect(Buffer.from(state.settings.cloud_pc_secret_encrypted, 'base64').toString()).toBe(
      `ENC:${SECRET}`
    )
    expect(getPcSecret()).toBe(SECRET)
    expect(cloudConfig.hasSecret()).toBe(true)
    expect(cloudConfig.url()).toBe('https://a.example.workers.dev')
  })

  it('암호화를 못 쓰는 환경에서는 base64 로 저장한다 (r2 인증과 같은 패턴)', () => {
    state.encryption = false
    write(JSON.stringify({ url: 'https://a.example.workers.dev', secret: SECRET }))
    expect(importConnectFile()).toBe('imported')
    expect(Buffer.from(state.settings.cloud_pc_secret_encrypted, 'base64').toString()).toBe(SECRET)
    expect(getPcSecret()).toBe(SECRET)
  })

  it('형식이 틀리면 저장하지 않고 파일도 그대로 둔다', () => {
    write('{"url":"http://evil.example.com","secret":"x"}')
    expect(importConnectFile()).toBe('invalid')
    expect(existsSync(connectFilePath())).toBe(true)
    expect(state.settings).toEqual({})
    expect(cloudConfig.hasSecret()).toBe(false)
  })

  it('새 연결 파일이 오면 이전 연결 정보를 덮어쓴다 (다시 배포한 경우)', () => {
    write(JSON.stringify({ url: 'https://a.example.workers.dev', secret: SECRET }))
    importConnectFile()
    write(JSON.stringify({ url: 'https://b.example.workers.dev', secret: `${SECRET}-new` }))
    expect(importConnectFile()).toBe('imported')
    expect(getPcSecret()).toBe(`${SECRET}-new`)
    expect(cloudConfig.url()).toBe('https://b.example.workers.dev')
  })

  it('저장된 비밀값이 깨졌으면 없는 것으로 본다', () => {
    state.settings.cloud_pc_secret_encrypted = Buffer.from('쓰레기').toString('base64')
    expect(getPcSecret()).toBeNull()
    expect(cloudConfig.hasSecret()).toBe(false)
  })
})

describe('cloudConfig 기본값과 저장', () => {
  it('기본값', () => {
    // 주소 기본값은 없다 — 연결 파일을 가져와야 생긴다
    expect(cloudConfig.url()).toBe('')
    expect(connectFilePath()).toBe(join(state.dir, CONNECT_DIR_NAME, 'cloud-connect.json'))
    expect(cloudConfig.enabled()).toBe(true)
    expect(cloudConfig.uploadImages()).toBe(true)
    expect(cloudConfig.keepImages()).toBe(KEEP_IMAGES_DEFAULT)
    expect(cloudConfig.cloudGenEnabled()).toBe(false)
    expect(cloudConfig.hasSecret()).toBe(false)
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [] })
  })

  it('켜고 끄는 값과 보관 장수(100~20000 으로 자름)', () => {
    cloudConfig.setEnabled(false)
    cloudConfig.setUploadImages(false)
    cloudConfig.setCloudGenEnabled(true)
    expect(state.settings).toMatchObject({
      cloud_enabled: '0',
      cloud_upload_images: '0',
      cloud_gen_enabled: '1'
    })
    expect(cloudConfig.enabled()).toBe(false)
    expect(cloudConfig.uploadImages()).toBe(false)
    expect(cloudConfig.cloudGenEnabled()).toBe(true)

    cloudConfig.setKeepImages(5000)
    expect(cloudConfig.keepImages()).toBe(5000)
    cloudConfig.setKeepImages(5)
    expect(cloudConfig.keepImages()).toBe(100)
    cloudConfig.setKeepImages(10 ** 9)
    expect(cloudConfig.keepImages()).toBe(20000)
    expect(clampKeepImages(NaN)).toBe(KEEP_IMAGES_DEFAULT)
    expect(clampKeepImages(1234.6)).toBe(1235)
  })

  it('올린 그림 id 기록은 정수만 읽고, 깨져도 빈 상태로', () => {
    cloudConfig.saveUploadState({ uploaded: [3, 5, 9] })
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [3, 5, 9] })
    state.settings.cloud_upload_state = '{"uploaded":[1,"x",2.5,null,4]}'
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [1, 4] })
    state.settings.cloud_upload_state = '{깨짐'
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [] })
  })

  it('가져왔다 알림 대기표(클라우드 id → PC id)는 같이 저장하고, 모양이 틀린 항목은 버린다', () => {
    cloudConfig.saveUploadState({ uploaded: [1], pendingImported: { cA: 100, cB: 101 } })
    expect(cloudConfig.loadUploadState()).toEqual({
      uploaded: [1],
      pendingImported: { cA: 100, cB: 101 }
    })
    // 비어 있으면 아예 싣지 않는다
    cloudConfig.saveUploadState({ uploaded: [1], pendingImported: {} })
    expect(state.settings.cloud_upload_state).toBe('{"uploaded":[1]}')
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [1] })

    state.settings.cloud_upload_state =
      '{"uploaded":[2],"pendingImported":{"ok":5,"str":"7","frac":1.5,"nul":null}}'
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [2], pendingImported: { ok: 5 } })
    state.settings.cloud_upload_state = '{"uploaded":[2],"pendingImported":[1,2]}'
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [2] })
    // 옛 모양(알림 대기표 없음)도 그대로 읽는다
    state.settings.cloud_upload_state = '{"uploaded":[3]}'
    expect(cloudConfig.loadUploadState()).toEqual({ uploaded: [3] })
  })

  it('올린 그림 id 기록은 상한을 넘으면 오래된 것부터 잊는다', () => {
    const many = Array.from({ length: 20_050 }, (_, i) => i + 1)
    cloudConfig.saveUploadState({ uploaded: many })
    const back = cloudConfig.loadUploadState().uploaded
    expect(back).toHaveLength(20_000)
    expect(back[0]).toBe(51)
    expect(back.at(-1)).toBe(20_050)
  })
})
