import { describe, expect, it } from 'vitest'
import { metadataFromPayloadJson } from '../src/main/images/metadata'

describe('NAIS3 로컬 메타데이터', () => {
  it('생성 당시 조각 스냅샷을 payload_json에서 복원한다', () => {
    const meta = metadataFromPayloadJson(
      JSON.stringify({
        input: '1girl, long hair',
        model: 'nai-diffusion-4-5-full',
        parameters: { negative_prompt: '', seed: 123 },
        nais3: {
          fragmentPrompts: [
            {
              token: '<hair>',
              path: 'hair',
              location: '프롬프트',
              selected: 'long hair',
              content: 'long hair\nshort hair'
            }
          ]
        }
      })
    )

    expect(meta?.fragmentPrompts).toEqual([
      {
        token: '<hair>',
        path: 'hair',
        location: '프롬프트',
        selected: 'long hair',
        content: 'long hair\nshort hair'
      }
    ])
  })
})
