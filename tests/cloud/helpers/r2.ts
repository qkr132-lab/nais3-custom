// 테스트 전용 — R2 버킷을 Map 으로 흉내 낸다 (put/get/delete 만).
import type { BucketLike, BucketObjectLike } from '../../../cloud/src/core/deps'

function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}

export class MemoryBucket implements BucketLike {
  readonly files = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  /** delete 로 지워진 키 기록 (정리 확인용) */
  readonly deleted: string[] = []

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown> {
    this.files.set(key, { bytes: toBytes(value), contentType: options?.httpMetadata?.contentType })
    return {}
  }

  async get(key: string): Promise<BucketObjectLike | null> {
    const entry = this.files.get(key)
    if (!entry) return null
    const copy = (): Uint8Array => entry.bytes.slice()
    return {
      size: entry.bytes.byteLength,
      get body() {
        return new Response(copy() as unknown as BodyInit).body as ReadableStream<Uint8Array>
      },
      arrayBuffer: async () => copy().buffer as ArrayBuffer,
      text: async () => new TextDecoder().decode(entry.bytes)
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.files.delete(key)
      this.deleted.push(key)
    }
  }

  keys(prefix = ''): string[] {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}
