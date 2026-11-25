import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { handleAlarm } from '../../cloud/src/core/alarm'
import { runCloudStep } from '../../cloud/src/core/cloudgen'
import {
  Harness,
  NAI_HOST,
  NAI_TOKEN,
  T0,
  enableCloudGen,
  preparedItem,
  sampleRequest,
  sampleSceneRequest,
  seedPc,
  type Dict
} from './helpers/harness'
import { reply, type NaiCall } from './helpers/nai'

/** 라이브러리·씬·완성 요청이 올라가 있고 클라우드 생성이 켜진 허브 + 연결된 폰 */
async function ready(): Promise<{ h: Harness; token: string }> {
  const h = new Harness()
  await seedPc(h)
  await enableCloudGen(h)
  return { h, token: await h.pair() }
}

type Body = {
  target: { type: 'main' } | { type: 'scene'; sceneId: number }
  count: number
  place: string
}
const main = (count: number): Body => ({ target: { type: 'main' }, count, place: 'cloud' })
const scene = (sceneId: number, count: number): Body => ({
  target: { type: 'scene', sceneId },
  count,
  place: 'cloud'
})

async function start(h: Harness, token: string, body: Body): Promise<string> {
  const made = await h.phoneJson(token, 'POST', '/api/jobs', body)
  expect(made.status, JSON.stringify(made.json)).toBe(200)
  return made.json.job.id
}

const payloadOf = (call: NaiCall): Dict => JSON.parse(call.body as string)
const job = (h: Harness, id: string): Dict => h.jobRow(id)

/** 요청 한 건의 prepared 를 바꿔 넣는다 */
async function setPrepared(
  h: Harness,
  key: string,
  request: Record<string, unknown>
): Promise<void> {
  await h.pcJson('PUT', '/api/pc/prepared', {
    items: [preparedItem(key, request, `changed-${key}`)]
  })
}

describe('클라우드 생성 — 정상 흐름', () => {
  it('씬 작업 2장: 한 알람에 한 장씩, zip 은 풀지 않고 R2 에 그대로 두고, 요청 모양이 맞다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, scene(1, 2))
    expect(h.alarmLog).toEqual([T0])

    // 한 번 울리면 한 장만 만든다
    await handleAlarm(h.deps)
    expect(h.nai.generateCalls).toHaveLength(1)
    expect(job(h, id)).toMatchObject({
      state: 'cloud',
      done: 1,
      failed: 0,
      in_flight: 0,
      attempts: 0
    })
    expect(h.pendingAlarm).toBe(T0 + 1500)

    await h.runAlarms()
    expect(job(h, id)).toMatchObject({
      state: 'done',
      done: 2,
      failed: 0,
      error: null,
      in_flight: 0
    })
    expect(h.alarmLog).toEqual([T0, T0 + 1500]) // 끝나면 더 걸지 않는다
    expect(h.pendingAlarm).toBeNull()

    // NAI 요청
    const calls = h.nai.generateCalls
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.method).toBe('POST')
      expect(call.url).toBe(`${NAI_HOST}/ai/generate-image`)
      expect(call.headers['authorization']).toBe(`Bearer ${NAI_TOKEN}`)
      expect(call.headers['content-type']).toBe('application/json')
      expect(call.headers['accept']).toBe('application/x-zip-compressed')
      const payload = payloadOf(call)
      expect(payload).toMatchObject({ action: 'generate', model: 'nai-diffusion-4-5-full' })
      expect(payload.parameters).toMatchObject({
        n_samples: 1,
        image_format: 'png',
        width: 832,
        height: 1216,
        steps: 28
      })
      expect(Number.isInteger(payload.parameters.seed)).toBe(true)
      expect(payload.parameters.seed).toBeGreaterThanOrEqual(0)
      expect(payload.parameters.seed).toBeLessThanOrEqual(4294967295)
      // 바이브·캐릭터 레퍼런스는 보내지 않는다
      expect(payload.parameters.reference_image_multiple).toBeUndefined()
      expect(payload.parameters.director_reference_images).toBeUndefined()
    }
    expect(payloadOf(calls[0]).parameters.seed).not.toBe(payloadOf(calls[1]).parameters.seed)

    // 구독 확인: 작업 첫 장 전 + 첫 장 뒤 (2장짜리라 5장 주기는 오지 않는다)
    expect(h.nai.subscriptionCalls).toHaveLength(2)
    expect(h.nai.subscriptionCalls[0].headers['authorization']).toBe(`Bearer ${NAI_TOKEN}`)

    // 그림 행과 R2 — zip 그대로
    const rows = h.imageRows()
    expect(rows).toHaveLength(2)
    for (const [i, row] of rows.entries()) {
      expect(row).toMatchObject({
        source: 'cloud',
        format: 'zip',
        imported: 0,
        pc_image_id: null,
        has_thumb: 0,
        scene_id: 1,
        preset_id: 1,
        job_id: id,
        width: 832,
        height: 1216
      })
      expect(row.id).toMatch(/^c[a-z0-9]{12}$/)
      expect(row.r2_key).toBe(`img/${row.id}.zip`)
      expect(row.sent_payload).toBe(calls[i].body)
      expect(row.seed).toBe(payloadOf(calls[i]).parameters.seed)
      const stored = h.bucket.files.get(row.r2_key as string)!
      expect(stored.contentType).toBe('application/zip')
      expect(Array.from(stored.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 3, 4]) // 풀지 않은 zip
      const zip = await JSZip.loadAsync(stored.bytes)
      expect(Object.keys(zip.files)).toEqual(['image_0.png'])
    }
    expect(h.bucket.keys()).toHaveLength(2)

    // 폰: 목록과 원본
    const list = await h.phoneJson(token, 'GET', '/api/images')
    expect(list.json.items).toHaveLength(2)
    expect(list.json.items[0]).toMatchObject({
      source: 'cloud',
      format: 'zip',
      jobId: id,
      sceneId: 1,
      hasThumb: false
    })
    const file = await h.phone(token, 'GET', `/api/images/${list.json.items[0].id}`)
    expect(file.headers.get('content-type')).toBe('application/zip')
    expect(Array.from(new Uint8Array(await file.arrayBuffer()).slice(0, 4))).toEqual([
      0x50, 0x4b, 3, 4
    ])
    expect(
      (await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')).json.items[0].latestImageId
    ).toBe(list.json.items[0].id)

    // 폰이 썸네일을 한 번 올린다 (클라우드 생성분 · 썸네일 없음일 때만)
    const thumbUrl = `/api/images/${list.json.items[0].id}/thumb`
    const thumb = new Uint8Array([9, 9, 9])
    const put = await h.call('PUT', thumbUrl, { auth: token, raw: thumb as unknown as BodyInit })
    expect(put.status).toBe(200)
    expect(
      (await h.call('PUT', thumbUrl, { auth: token, raw: thumb as unknown as BodyInit })).status
    ).toBe(409)
    expect(
      (
        await h.call('PUT', thumbUrl, {
          auth: token,
          raw: new Uint8Array(256 * 1024 + 1) as unknown as BodyInit
        })
      ).status
    ).toBe(413)
    expect(new Uint8Array(await (await h.phone(token, 'GET', thumbUrl)).arrayBuffer())).toEqual(
      thumb
    )

    // PC 가 켜지면 가져간다: 목록(오래된 순) → 파일 → 가져왔다고 표시
    const pcList = await h.pcJson('GET', '/api/pc/cloud-images')
    expect(pcList.json.items).toHaveLength(2)
    expect(pcList.json.items[0]).toMatchObject({
      id: rows[0].id,
      jobId: id,
      sceneId: 1,
      presetId: 1,
      seed: rows[0].seed,
      sentPayload: calls[0].body,
      createdAt: rows[0].created_at
    })
    expect(pcList.json.items.map((i: Dict) => i.id)).toEqual(rows.map((r) => r.id))
    const pcFile = await h.pc('GET', `/api/pc/cloud-images/${rows[0].id}/file`)
    expect(pcFile.headers.get('content-type')).toBe('application/zip')
    expect(new Uint8Array(await pcFile.arrayBuffer())).toEqual(
      h.bucket.files.get(rows[0].r2_key as string)!.bytes
    )
    expect(
      (await h.pcJson('POST', `/api/pc/cloud-images/${rows[0].id}/imported`, { pcImageId: 321 }))
        .status
    ).toBe(200)
    expect(
      h.sql
        .exec<Dict>(`SELECT imported, pc_image_id FROM images WHERE id = ?`, rows[0].id as string)
        .one()
    ).toEqual({ imported: 1, pc_image_id: 321 })
    expect(
      (await h.pcJson('GET', '/api/pc/cloud-images')).json.items.map((i: Dict) => i.id)
    ).toEqual([rows[1].id])
    expect(
      (await h.pcJson('POST', '/api/pc/cloud-images/cnone/imported', { pcImageId: 1 })).status
    ).toBe(404)
    expect((await h.pcJson('POST', `/api/pc/cloud-images/${rows[1].id}/imported`, {})).status).toBe(
      400
    )
    expect((await h.pcJson('GET', '/api/pc/info')).json).toMatchObject({
      imagesStored: 2,
      cloudJobsActive: 0
    })
  })

  it('NAI_HOST 를 바꾸면 그 주소로 가고, 끝의 슬래시는 정리된다', async () => {
    const { h, token } = await ready()
    h.deps.env.NAI_HOST = 'http://127.0.0.1:8799/'
    await start(h, token, main(1))
    await h.runAlarms()
    expect(h.nai.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8799/user/subscription',
      'http://127.0.0.1:8799/ai/generate-image',
      'http://127.0.0.1:8799/user/subscription'
    ])
  })

  it('작업은 만든 순서대로, 한 알람에 한 장씩 처리한다', async () => {
    const { h, token } = await ready()
    const a = await start(h, token, scene(1, 2))
    h.tick(10)
    const b = await start(h, token, main(1))
    await h.runAlarms()
    const order = h.imageRows().map((r) => r.job_id)
    expect(order).toEqual([a, a, b])
    expect(job(h, a).state).toBe('done')
    expect(job(h, b)).toMatchObject({ state: 'done', done: 1 })
    // 메인 작업의 그림은 씬이 없다
    expect(h.imageRows()[2]).toMatchObject({ scene_id: null, preset_id: null })
  })

  it('구독은 작업 첫 장 전, 첫 장 뒤, 그리고 5장마다 다시 확인한다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, main(11))
    await h.runAlarms(40)
    expect(job(h, id)).toMatchObject({ state: 'done', done: 11 })
    expect(h.nai.generateCalls).toHaveLength(11)
    // 0번째 장 전 · 0번째 장 뒤 · 5번째 장 전 · 10번째 장 전
    expect(h.nai.subscriptionCalls).toHaveLength(4)
    // 구독(S)·생성(G) 순서: 첫 장 전 S, 장, 첫 장 뒤 S, 장 4개, 6번째 장 전 S, 장 5개, 11번째 장 전 S, 장
    const order = h.nai.calls.map((c) => (c.path === '/user/subscription' ? 'S' : 'G')).join('')
    expect(order).toBe('SG' + 'S' + 'GGGG' + 'SG' + 'GGGG' + 'SG')
  })

  it('V4.5 는 무료 사용량 게이지가 없어도(percent 0) 만든다. 정확히 1024×1024 · 28스텝도 무료 범위', async () => {
    const { h, token } = await ready()
    h.nai.usage = { percent: 0, isNegative: false, timeUntilNextPercent: 100 }
    await setPrepared(h, 'main', sampleRequest({ width: 1024, height: 1024, steps: 28 }))
    const id = await start(h, token, main(1))
    await h.runAlarms()
    expect(job(h, id).state).toBe('done')
    expect(payloadOf(h.nai.generateCalls[0]).parameters).toMatchObject({
      width: 1024,
      height: 1024
    })
  })
})

describe('클라우드 생성 — 요청 만들기', () => {
  it('폰에서 고친 씬 프롬프트가 완성 요청에 다시 합쳐진다', async () => {
    const { h, token } = await ready()
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', {
      prompt: 'new scene prompt',
      negativePrompt: 'bad hands'
    })
    await start(h, token, scene(1, 1))
    await h.runAlarms()
    const payload = payloadOf(h.nai.generateCalls[0])
    expect(payload.input).toBe('base tags, new scene prompt')
    expect(payload.parameters.negative_prompt).toBe('lowres, bad hands')
    // 다른 씬은 자기 프롬프트
    await start(h, token, scene(2, 1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[1]).input).toBe('base tags, scene prompt 2')
  })

  it('폰에서 고친 씬 해상도도 따르고, 무료 범위를 넘게 고쳤다면 만들지 않는다', async () => {
    const { h, token } = await ready()
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { width: 640, height: 960 })
    await start(h, token, scene(1, 1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[0]).parameters).toMatchObject({ width: 640, height: 960 })
    expect(JSON.parse(h.imageRows()[0].sent_payload as string).parameters.width).toBe(640)
    expect(h.imageRows()[0]).toMatchObject({ width: 640, height: 960 })

    // 폰에서 1088×1024 로 키우면 PC 가 올려 둔 요청은 작아도 무료 범위 밖이라 멈춘다
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { width: 1088, height: 1024 })
    const id = await start(h, token, scene(1, 1))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed' })
    expect(String(job(h, id).error)).toContain('해상도가 무료 범위')
    expect(h.nai.generateCalls).toHaveLength(1)
  })

  it('조각·와일드카드: 주석을 먼저 지우고, 순차 조각은 카운터를 이어 간다', async () => {
    const { h, token } = await ready()
    await h.pcJson('PUT', '/api/pc/fragments', {
      byPath: { Colors: ['red', 'blue'], seq: ['a', 'b', 'c'], '폴더/의상': ['교복'] },
      hash: 'f1'
    })
    await setPrepared(
      h,
      'main',
      sampleRequest({
        prompt: '<*seq>, <폴더/의상>, <colors>\n# 주석 줄 <*seq>\nend',
        negativePrompt: 'plain # 뒤는 주석 <*seq>',
        characterPrompts: [
          {
            prompt: '<colors> hair',
            negativePrompt: '<*seq> neg',
            enabled: true,
            center: { x: 0.5, y: 0.5 }
          }
        ]
      })
    )
    await start(h, token, main(3))
    await h.runAlarms()
    const inputs = h.nai.generateCalls.map((c) => payloadOf(c))
    // 주석 줄의 <*seq> 는 카운터를 쓰지 않는다. 장마다 positive → character 순으로 하나씩 소모
    expect(inputs[0].input).toMatch(/^a, 교복, (red|blue)\nend$/)
    expect(inputs[0].parameters.v4_prompt.caption.char_captions[0].char_caption).toMatch(
      /^(red|blue) hair$/
    )
    expect(inputs[0].parameters.v4_negative_prompt.caption.char_captions[0].char_caption).toBe(
      'b neg'
    )
    expect(inputs[1].input).toMatch(/^c, 교복, (red|blue)\nend$/)
    expect(inputs[1].parameters.v4_negative_prompt.caption.char_captions[0].char_caption).toBe(
      'a neg'
    )
    expect(inputs[2].input).toMatch(/^b, 교복, (red|blue)\nend$/)
    expect(inputs[0].parameters.negative_prompt).toBe('plain')
    // 카운터가 저장돼 다음 작업이 이어 간다 (3장 × 2번 = 6 → 한 바퀴 돌아 a)
    expect(h.kv('seq:seq')).toBe('6')
    await start(h, token, main(1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[3]).input).toMatch(/^a, 교복,/)
  })

  it('없는 조각은 원문 그대로 둔다 (조각 파일을 아직 못 받았을 때)', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ prompt: '1girl, <없는조각>' }))
    await start(h, token, main(1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[0]).input).toBe('1girl, <없는조각>')
  })

  it('조각 파일이 바뀌면(해시가 바뀌면) 다시 읽는다', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ prompt: '<x>' }))
    await h.pcJson('PUT', '/api/pc/fragments', { byPath: { x: ['one'] }, hash: 'v1' })
    await start(h, token, main(1))
    await h.runAlarms()
    await h.pcJson('PUT', '/api/pc/fragments', { byPath: { x: ['two'] }, hash: 'v2' })
    await start(h, token, main(1))
    await h.runAlarms()
    expect(h.nai.generateCalls.map((c) => payloadOf(c).input)).toEqual(['one', 'two'])
  })

  it('V5 투명 배경: 배경 태그를 걷고 transparent background 를 붙인다', async () => {
    const { h, token } = await ready()
    await setPrepared(
      h,
      'main',
      sampleRequest({
        model: 'nai-diffusion-5-full',
        prompt: '1girl, simple background',
        transparentBackground: true
      })
    )
    await start(h, token, main(1))
    await h.runAlarms()
    const payload = payloadOf(h.nai.generateCalls[0])
    expect(payload.model).toBe('nai-diffusion-5-full')
    expect(payload.input).toContain('transparent background')
    expect(payload.input).not.toContain('simple background')
  })
})

describe('클라우드 생성 — 무료 조건 검사 (하나라도 어기면 생성하지 않는다)', () => {
  const cases: {
    name: string
    setup: (h: Harness) => Promise<void> | void
    error: string
  }[] = [
    {
      name: '해상도가 1024×1024 를 넘음',
      setup: (h) => setPrepared(h, 'main', sampleRequest({ width: 1088, height: 1024 })),
      error: '해상도가 무료 범위'
    },
    {
      name: '스텝이 28 을 넘음',
      setup: (h) => setPrepared(h, 'main', sampleRequest({ steps: 29 })),
      error: '스텝이 무료 범위'
    },
    {
      name: 'i2i(이미지 변환)',
      setup: (h) =>
        setPrepared(
          h,
          'main',
          sampleRequest({ source: { imageBase64: 'AAAA', strength: 0.5, noise: 0 } })
        ),
      error: 'i2i'
    },
    {
      name: 'Opus 구독이 아님',
      setup: (h) => {
        h.nai.tier = 2
      },
      error: 'Opus 구독이 아니어서'
    },
    {
      name: 'V5 · 무료 사용량 확인 불가(0%)',
      setup: async (h) => {
        await setPrepared(h, 'main', sampleRequest({ model: 'nai-diffusion-5-full' }))
        h.nai.usage = { percent: 0, isNegative: false, timeUntilNextPercent: 100 }
      },
      error: '이번 달 무료 사용량이 확인되지 않아 클라우드 생성을 멈췄습니다'
    },
    {
      name: 'V5 · usage 필드가 없음',
      setup: async (h) => {
        await setPrepared(h, 'main', sampleRequest({ model: 'nai-diffusion-5-curated' }))
        h.nai.usage = null
      },
      error: '이번 달 무료 사용량이 확인되지 않아'
    },
    {
      name: 'V5 · 무료 사용량 소진',
      setup: async (h) => {
        await setPrepared(h, 'main', sampleRequest({ model: 'nai-diffusion-5-full' }))
        h.nai.usage = { percent: 12, isNegative: true, timeUntilNextPercent: 100 }
      },
      error: '무료 사용량을 모두 써서'
    },
    {
      name: '구독 확인에서 토큰 거부(401)',
      setup: (h) => {
        h.nai.subscriptionQueue.push(reply(401, 'no'))
      },
      error: '토큰이 거부'
    },
    {
      name: '생성 정보를 PC 가 아직 안 올림',
      setup: (h) => {
        h.sql.exec(`DELETE FROM prepared WHERE key = 'main'`)
      },
      error: 'PC가 메인 생성 정보를 아직 안 올렸습니다'
    },
    {
      name: '저장된 생성 정보가 깨짐',
      setup: (h) => {
        h.sql.exec(`UPDATE prepared SET request = '{"prompt": 5}' WHERE key = 'main'`)
      },
      error: '올바르지 않습니다'
    }
  ]

  for (const c of cases) {
    it(`${c.name} → 작업 실패 · NAI 생성 호출 없음`, async () => {
      const { h, token } = await ready()
      const id = await start(h, token, main(3))
      await c.setup(h)
      await h.runAlarms()
      expect(job(h, id)).toMatchObject({ state: 'failed', done: 0, in_flight: 0 })
      expect(String(job(h, id).error)).toContain(c.error)
      expect(/[가-힣]/.test(String(job(h, id).error))).toBe(true)
      expect(h.nai.generateCalls).toHaveLength(0)
      expect(h.imageRows()).toHaveLength(0)
      // 폰 작업 목록에도 이유가 보인다
      const shown = (await h.phoneJson(token, 'GET', '/api/state')).json.jobs[0]
      expect(shown).toMatchObject({ id, state: 'failed' })
      expect(h.pendingAlarm).toBeNull() // 실패한 작업은 알람을 더 걸지 않는다
    })
  }

  it('렌더러가 올린 i2i 자리표시(source 객체 · imageBase64 비어 있음)도 i2i 요청으로 거절한다', async () => {
    const { h, token } = await ready()
    // 렌더러는 용량 때문에 원본 그림을 빼고 { strength, noise, imageBase64: '' } 만 남긴다 (시드는 -1)
    const placeholder = { strength: 0.6, noise: 0, imageBase64: '' }
    await setPrepared(h, 'scene:1', sampleSceneRequest(1, { source: placeholder }))
    await setPrepared(h, 'main', sampleRequest({ source: placeholder }))
    expect(
      JSON.parse(h.sql.exec<Dict>(`SELECT request FROM prepared WHERE key = 'main'`).one().request)
    ).toMatchObject({ seed: -1, source: placeholder })
    const a = await start(h, token, scene(1, 2))
    const b = await start(h, token, main(1))
    await h.runAlarms()
    for (const id of [a, b]) {
      expect(job(h, id)).toMatchObject({
        state: 'failed',
        done: 0,
        in_flight: 0,
        error: 'i2i 요청이라 클라우드에서 생성하지 않습니다'
      })
    }
    // 네트워크에 나가기 전에 거절 — 구독 확인도 생성도 없다
    expect(h.nai.calls).toHaveLength(0)
    expect(h.imageRows()).toHaveLength(0)
    expect(h.pendingAlarm).toBeNull()
  })

  it('source 가 빈 객체여도 i2i 로 본다. source 가 없으면(null 포함) 보통 요청이다', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ source: {} }))
    const a = await start(h, token, main(1))
    await h.runAlarms()
    expect(job(h, a)).toMatchObject({
      state: 'failed',
      error: 'i2i 요청이라 클라우드에서 생성하지 않습니다'
    })
    expect(h.nai.calls).toHaveLength(0)

    await setPrepared(h, 'main', sampleRequest({ source: null }))
    const b = await start(h, token, main(1))
    await h.runAlarms()
    expect(job(h, b).state).toBe('done')
    expect(h.nai.generateCalls).toHaveLength(1)
  })

  it('시드 -1 로 올라온 완성 요청은 장마다 새 시드를 뽑아 보낸다 (-1 이 NAI 로 가지 않는다)', async () => {
    const { h, token } = await ready()
    expect(
      JSON.parse(
        h.sql.exec<Dict>(`SELECT request FROM prepared WHERE key = 'scene:1'`).one().request
      ).seed
    ).toBe(-1)
    await start(h, token, scene(1, 3))
    await h.runAlarms()
    const seeds = h.nai.generateCalls.map((c) => payloadOf(c).parameters.seed)
    expect(seeds).toHaveLength(3)
    expect(new Set(seeds).size).toBe(3)
    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThanOrEqual(4294967295)
    }
    // 저장된 완성 요청은 그대로 -1 (다음 장·작업도 새로 뽑는다)
    expect(
      JSON.parse(
        h.sql.exec<Dict>(`SELECT request FROM prepared WHERE key = 'scene:1'`).one().request
      ).seed
    ).toBe(-1)
  })

  it('씬 작업인데 DO 에 그 씬이 없으면 실패', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, scene(1, 1))
    h.sql.exec(`DELETE FROM scenes WHERE id = 1`)
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed' })
    expect(String(job(h, id).error)).toContain('씬이 클라우드에 없습니다')
    expect(h.nai.generateCalls).toHaveLength(0)
  })

  it('무료 사용량 확인 결과는 nai:quota 에 남아 폰에 이유로 보인다', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ model: 'nai-diffusion-5-full' }))
    h.nai.usage = { percent: 12, isNegative: true, timeUntilNextPercent: 100 }
    await start(h, token, main(1))
    await h.runAlarms()
    expect(JSON.parse(h.kv('nai:quota')!)).toEqual({ state: 'exhausted', checkedAt: T0 })
    const cloudGen = (await h.phoneJson(token, 'GET', '/api/state')).json.cloudGen
    expect(cloudGen).toMatchObject({ ready: false, reason: '이번 달 무료 사용량을 모두 썼습니다' })
    // 사용량이 회복되면 다음 작업은 다시 만든다 (확인 결과는 매 작업 첫 장 전에 갱신)
    h.nai.usage = { percent: 40, isNegative: false, timeUntilNextPercent: 100 }
    h.tick(1000)
    const next = await start(h, token, main(1))
    await h.runAlarms()
    expect(job(h, next).state).toBe('done')
    expect(JSON.parse(h.kv('nai:quota')!).state).toBe('available')
  })

  it('작업 도중 요청이 바뀌어도(해상도 초과) 다음 장부터 멈춘다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, main(3))
    await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 1 })
    await setPrepared(h, 'main', sampleRequest({ width: 1472, height: 1472 }))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 1 })
    expect(String(job(h, id).error)).toContain('해상도가 무료 범위')
    expect(h.nai.generateCalls).toHaveLength(1)
  })
})

describe('클라우드 생성 — Anlas 안전망', () => {
  it('첫 장 뒤 Anlas 가 줄었으면 작업을 멈추고 클라우드 생성을 끈다', async () => {
    const { h, token } = await ready()
    h.nai.spendPerImage = 5
    const a = await start(h, token, main(3))
    h.tick(1)
    const b = await start(h, token, main(2))
    await h.runAlarms()
    expect(job(h, a)).toMatchObject({ state: 'failed', done: 1, failed: 0 })
    expect(job(h, a).error).toBe('Anlas가 차감되어 중단했습니다')
    // 기다리던 다른 작업도 생성이 꺼졌으므로 시작하지 않는다
    expect(job(h, b)).toMatchObject({ state: 'failed', done: 0 })
    expect(String(job(h, b).error)).toContain('꺼져')
    expect(h.nai.generateCalls).toHaveLength(1)
    expect((await h.pcJson('GET', '/api/pc/info')).json.settings.cloudGenEnabled).toBe(false)
    expect((await h.phoneJson(token, 'GET', '/api/state')).json.cloudGen.enabled).toBe(false)
    // 이미 만든 한 장은 남는다
    expect(h.imageRows()).toHaveLength(1)
    // 이후 클라우드 작업은 받지 않는다
    const refused = await h.phone(token, 'POST', '/api/jobs', main(1))
    expect(refused.status).toBe(400)
    // 작업 임시값은 치워졌다
    expect(
      h.sql
        .exec(`SELECT k FROM kv WHERE k LIKE 'anlas:%' OR k LIKE 'verify:%' OR k LIKE 'rl:%'`)
        .toArray()
    ).toEqual([])
  })

  it('첫 장 뒤 확인은 통과했어도 5장째 확인에서 잔액이 줄었으면 멈춘다', async () => {
    const { h, token } = await ready()
    h.nai.spendFromImage = 2
    h.nai.spendPerImage = 3
    const id = await start(h, token, main(8))
    await h.runAlarms(40)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 5 })
    expect(job(h, id).error).toBe('Anlas가 차감되어 중단했습니다')
    expect(h.nai.generateCalls).toHaveLength(5)
    expect(h.nai.subscriptionCalls).toHaveLength(3) // 첫 장 전 · 첫 장 뒤 · 6번째 장 전
  })

  it('NAI 가 결제를 요구(402)하면 멈추고 클라우드 생성을 끈다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(402, 'insufficient'))
    const id = await start(h, token, main(2))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 0 })
    expect(String(job(h, id).error)).toContain('Anlas')
    expect((await h.pcJson('GET', '/api/pc/info')).json.settings.cloudGenEnabled).toBe(false)
  })

  it('생성에서 토큰 거부(401·403)면 나머지 장을 시도하지 않는다 (생성은 켜진 채)', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(401, 'bad token'))
    const id = await start(h, token, main(5))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 0 })
    expect(String(job(h, id).error)).toContain('토큰이 거부')
    expect(h.nai.generateCalls).toHaveLength(1)
    expect((await h.pcJson('GET', '/api/pc/info')).json.settings.cloudGenEnabled).toBe(true)
  })
})

describe('클라우드 생성 — 속도 제한(429)', () => {
  it('Retry-After 만큼 미루고 같은 장을 다시 만든다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(429, 'slow down', { 'retry-after': '7' }))
    const id = await start(h, token, main(1))
    await handleAlarm(h.deps)
    expect(h.pendingAlarm).toBe(T0 + 7000)
    expect(job(h, id)).toMatchObject({
      state: 'cloud',
      done: 0,
      failed: 0,
      in_flight: 0,
      attempts: 0
    })
    expect(h.imageRows()).toHaveLength(0)
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1, failed: 0 })
    expect(h.nai.generateCalls).toHaveLength(2) // 같은 장을 두 번 시도
    expect(h.imageRows()).toHaveLength(1)
    expect(h.sql.exec(`SELECT k FROM kv WHERE k LIKE 'rl:%'`).toArray()).toEqual([])
  })

  it('Retry-After 가 없으면 5초, 터무니없이 길면 5분까지만', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(429))
    await start(h, token, main(1))
    await handleAlarm(h.deps)
    expect(h.pendingAlarm).toBe(T0 + 5000)
    h.nai.generateQueue.push(reply(429, '', { 'retry-after': '99999' }))
    await h.runAlarms(1)
    expect(h.pendingAlarm).toBe(T0 + 5000 + 300_000)
  })

  it('429 가 6번을 넘게 이어지면 그 장을 실패로 넘긴다', async () => {
    const { h, token } = await ready()
    for (let i = 0; i < 7; i++) h.nai.generateQueue.push(reply(429, '', { 'retry-after': '1' }))
    const id = await start(h, token, main(2))
    await h.runAlarms(60)
    // 첫 장은 429×7 로 실패, 둘째 장은 정상
    expect(h.nai.generateCalls).toHaveLength(8)
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1, failed: 1 })
    expect(String(job(h, id).error)).toContain('속도 제한(429)')
  })
})

describe('클라우드 생성 — 응답이 이상할 때', () => {
  it('HTTP 오류는 그 장만 실패: 본문 앞 200자만 싣고 토큰은 가린다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(500, `boom ${NAI_TOKEN} ` + 'x'.repeat(500)))
    const id = await start(h, token, main(2))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1, failed: 1 })
    const error = String(job(h, id).error)
    expect(error.startsWith('생성 실패 500: boom ***')).toBe(true)
    expect(error).not.toContain(NAI_TOKEN)
    expect(error.length).toBeLessThanOrEqual('생성 실패 500: '.length + 200)
    expect(JSON.stringify((await h.phoneJson(token, 'GET', '/api/state')).json)).not.toContain(
      NAI_TOKEN
    )
  })

  it('모든 장이 실패하면 작업도 failed', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(400, 'bad prompt'), reply(400, 'bad prompt'))
    const id = await start(h, token, main(2))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 0, failed: 2 })
    expect(job(h, id).error).toBe('생성 실패 400: bad prompt')
  })

  it('zip 이 아닌 응답(JSON · 내용이 PK 가 아님)은 R2 에 저장하지 않고 그 장을 실패 처리', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(
      reply(200, '{"error":"nope"}', { 'content-type': 'application/json' }),
      reply(200, new Uint8Array([1, 2, 3, 4, 5]), {
        'content-type': 'application/x-zip-compressed'
      })
    )
    const id = await start(h, token, main(2))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 0, failed: 2 })
    expect(String(job(h, id).error)).toContain('zip')
    expect(h.bucket.keys()).toEqual([])
    expect(h.imageRows()).toHaveLength(0)
  })
})

describe('클라우드 생성 — 알람 재진입 · 중복 방지 (at-least-once)', () => {
  it('장을 시작하기 전에 in_flight=1 · attempts+1 을 먼저 저장한다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, main(1))
    let seen: Dict | null = null
    h.nai.generateQueue.push(async () => {
      seen = job(h, id)
      return new Response(new Uint8Array([80, 75, 3, 4, 0]), {
        headers: { 'content-type': 'application/zip' }
      })
    })
    await h.runAlarms()
    expect(seen).toMatchObject({ in_flight: 1, attempts: 1, state: 'cloud' })
    expect(job(h, id)).toMatchObject({ in_flight: 0, attempts: 0, state: 'done' })
  })

  it('이미 시작된 채(in_flight=1)로 3번을 넘긴 장은 NAI 를 부르지 않고 실패로 넘긴다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, main(2))
    h.sql.exec(
      `UPDATE jobs SET in_flight = 1, attempts = 4, error = '이전 시도 오류' WHERE id = ?`,
      id
    )
    await handleAlarm(h.deps)
    expect(h.nai.generateCalls).toHaveLength(0)
    expect(job(h, id)).toMatchObject({
      state: 'cloud',
      done: 0,
      failed: 1,
      in_flight: 0,
      attempts: 0
    })
    expect(String(job(h, id).error)).toContain('이전 시도 오류')
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1, failed: 1 })
  })

  it('attempts 가 3 이하면 다시 시도한다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, main(1))
    h.sql.exec(`UPDATE jobs SET in_flight = 1, attempts = 3 WHERE id = ?`, id)
    await h.runAlarms()
    expect(h.nai.generateCalls).toHaveLength(1)
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1, failed: 0, attempts: 0 })
  })

  it('네트워크 예외가 계속되면 기록하고 다시 시도하되 4번째 뒤에는 그 장을 포기한다', async () => {
    const { h, token } = await ready()
    for (let i = 0; i < 10; i++) {
      h.nai.generateQueue.push(() => {
        throw new TypeError(`network down ${NAI_TOKEN}`)
      })
    }
    const id = await start(h, token, main(1))
    await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', in_flight: 1, attempts: 1 })
    expect(String(job(h, id).error)).toContain('network down ***')
    expect(String(job(h, id).error)).not.toContain(NAI_TOKEN)
    expect(h.pendingAlarm).toBe(T0 + 5000) // 예외 뒤에는 5초 후 다시
    await h.runAlarms(20)
    expect(h.nai.generateCalls).toHaveLength(4) // 시작 4번까지만
    expect(job(h, id)).toMatchObject({
      state: 'failed',
      done: 0,
      failed: 1,
      in_flight: 0,
      attempts: 0
    })
    expect(h.pendingAlarm).toBeNull() // 무한 재시도 없음
  })

  it('구독 확인이 일시적으로 실패해도 같은 방식으로 다시 시도하다 끊는다', async () => {
    const { h, token } = await ready()
    for (let i = 0; i < 4; i++) h.nai.subscriptionQueue.push(reply(500, 'oops'))
    const id = await start(h, token, main(1))
    await h.runAlarms(20)
    expect(h.nai.generateCalls).toHaveLength(0)
    expect(job(h, id)).toMatchObject({ state: 'failed' })
    expect(String(job(h, id).error)).toContain('3번 넘게')
    expect(String(job(h, id).error)).toContain('NAI 구독 정보를 확인하지 못했습니다 (HTTP 500)')
  })

  it('R2 저장이 한 번 실패해도 다시 시도해 그림은 한 장만 남는다', async () => {
    const { h, token } = await ready()
    const originalPut = h.bucket.put.bind(h.bucket)
    let failures = 1
    h.bucket.put = async (...args: Parameters<typeof originalPut>) => {
      if (failures-- > 0) throw new Error('R2 일시 오류')
      return originalPut(...args)
    }
    const id = await start(h, token, main(1))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1, failed: 0 })
    expect(h.imageRows()).toHaveLength(1)
    expect(h.bucket.keys()).toHaveLength(1)
    expect(job(h, id).error).toBeNull()
  })

  it('만드는 도중 취소하면 결과를 버리고 그림 행·R2 파일을 남기지 않는다', async () => {
    const { h, token } = await ready()
    let release: () => void = () => {}
    h.nai.generateQueue.push(
      () =>
        new Promise<Response>((resolve) => {
          release = (): void =>
            resolve(
              new Response(new Uint8Array([80, 75, 3, 4, 1]), {
                headers: { 'content-type': 'application/zip' }
              })
            )
        })
    )
    const id = await start(h, token, main(2))
    h.pendingAlarm = null
    const running = handleAlarm(h.deps)
    for (let i = 0; i < 100 && h.nai.generateCalls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 1))
    expect(h.nai.generateCalls).toHaveLength(1)
    expect((await h.phoneJson(token, 'POST', `/api/jobs/${id}/cancel`)).json.job.state).toBe(
      'cancelled'
    )
    release()
    await running
    expect(job(h, id)).toMatchObject({ state: 'cancelled', done: 0 })
    expect(h.imageRows()).toHaveLength(0)
    expect(h.bucket.keys()).toEqual([])
    expect(h.pendingAlarm).toBeNull()
    await h.runAlarms()
    expect(h.nai.generateCalls).toHaveLength(1) // 취소된 작업은 더 만들지 않는다
  })

  it('생성 끔 · 토큰 없음이면 대기 중인 클라우드 작업을 실패로 닫는다', async () => {
    const { h, token } = await ready()
    const a = await start(h, token, main(2))
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: false, keepImages: 2000 })
    await h.runAlarms()
    expect(job(h, a)).toMatchObject({ state: 'failed' })
    expect(String(job(h, a).error)).toContain('꺼져')
    expect(h.nai.calls).toHaveLength(0)

    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 2000 })
    const b = await start(h, token, main(1))
    h.sql.exec(`DELETE FROM kv WHERE k = 'secret:nai'`)
    await h.runAlarms()
    expect(job(h, b)).toMatchObject({ state: 'failed', error: 'NAI 토큰이 없음' })
  })

  it('알람 처리 자체가 계속 실패해도 알람을 끊지 않는다 — 간격만 늘려(최대 10분) 계속 건다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, main(1))
    let broken = true
    const exec = h.sql.exec.bind(h.sql)
    h.sql.exec = ((query: string, ...bindings: unknown[]) => {
      if (broken && /FROM jobs/.test(query)) throw new Error('disk I/O error: jobs')
      return exec(query, ...bindings)
    }) as typeof h.sql.exec

    const count = await h.runAlarms(9)
    expect(count).toBe(9) // 5번에서 멈추지 않는다
    const gaps = h.alarmLog.slice(1).map((at, i) => at - h.alarmLog[i])
    expect(gaps).toEqual([
      10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000
    ])
    expect(h.pendingAlarm).not.toBeNull()
    expect(h.kv('alarm:fail')).toBe('9')
    expect(h.kv('alarm:lastError')).toContain('jobs')

    // 저장소가 되살아나면 다음 알람에서 바로 이어 가고, 실패 횟수는 지워진다
    broken = false
    await h.runAlarms()
    expect(job(h, id).state).toBe('done')
    expect(h.kv('alarm:fail')).toBeNull()
    expect(h.pendingAlarm).toBeNull()
  })

  it('runCloudStep 은 할 일이 없으면 { again: false }', async () => {
    const { h } = await ready()
    expect(await runCloudStep(h.deps)).toEqual({ again: false, delayMs: 0 })
  })
})

describe('클라우드 생성 — 토큰 비노출', () => {
  it('전체 흐름 뒤 모든 응답과 저장된 작업·그림 행에 토큰이 없다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(500, `echo ${NAI_TOKEN}`))
    const id = await start(h, token, main(3))
    await h.runAlarms()
    expect(job(h, id).state).toBe('done')
    const paths: [string, string][] = [
      ['phone', '/api/state'],
      ['phone', '/api/images'],
      ['phone', '/api/scenes?presetId=1'],
      ['pc', '/api/pc/info'],
      ['pc', '/api/pc/cloud-images'],
      ['pc', '/api/pc/hashes']
    ]
    for (const [who, path] of paths) {
      const response = who === 'pc' ? await h.pc('GET', path) : await h.phone(token, 'GET', path)
      expect(await response.text(), path).not.toContain(NAI_TOKEN)
    }
    const dump = JSON.stringify([
      h.sql.exec(`SELECT * FROM jobs`).toArray(),
      h.sql.exec(`SELECT * FROM images`).toArray(),
      h.sql.exec(`SELECT * FROM ops`).toArray(),
      h.sql.exec(`SELECT k, v FROM kv WHERE k <> 'secret:nai'`).toArray()
    ])
    expect(dump).not.toContain(NAI_TOKEN)
    // 보낸 payload 에도 토큰은 없다 (Authorization 헤더로만 나간다)
    for (const call of h.nai.generateCalls) expect(call.body).not.toContain(NAI_TOKEN)
  })
})

describe('클라우드 생성 — 씬 준비물', () => {
  it('prepared 는 씬마다 따로 쓴다 (scene:2 요청은 scene:2 프롬프트)', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'scene:2', sampleSceneRequest(2, { steps: 20 }))
    await start(h, token, scene(2, 1))
    await h.runAlarms()
    const payload = payloadOf(h.nai.generateCalls[0])
    expect(payload.input).toBe('base tags, scene prompt 2')
    expect(payload.parameters.steps).toBe(20)
  })
})
