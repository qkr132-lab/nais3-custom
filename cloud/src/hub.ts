/**
 * Hub — 모든 /api/* 를 받는 단일 Durable Object (SQLite 저장).
 * 얇은 껍데기다: ctx.storage.sql·R2·fetch 를 HubDeps 로 묶어 core 에 넘길 뿐이다.
 */
import { DurableObject } from 'cloudflare:workers'
import { handleAlarm } from './core/alarm'
import type { BucketLike, HubDeps } from './core/deps'
import { handleRequest } from './core/router'
import { ensureSchema } from './core/schema'

export interface Env {
  HUB: DurableObjectNamespace<Hub>
  BUCKET: R2Bucket
  ASSETS: Fetcher
  /** wrangler secret — 설정 파일에 두지 않는다 */
  PC_SECRET: string
  NAI_HOST: string
}

export class Hub extends DurableObject<Env> {
  private readonly deps: HubDeps

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ensureSchema(ctx.storage.sql)
    })
    this.deps = {
      sql: ctx.storage.sql,
      bucket: env.BUCKET as unknown as BucketLike,
      now: () => Date.now(),
      random: () => Math.random(),
      fetch: (input, init) => fetch(input, init),
      env: { PC_SECRET: env.PC_SECRET, NAI_HOST: env.NAI_HOST },
      setAlarm: (at) => ctx.storage.setAlarm(at)
    }
  }

  async fetch(request: Request): Promise<Response> {
    return handleRequest({ ...this.deps, origin: new URL(request.url).origin }, request)
  }

  async alarm(): Promise<void> {
    await handleAlarm(this.deps)
  }
}
