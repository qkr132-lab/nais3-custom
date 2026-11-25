# NAIS3 모바일 클라우드 — 설계 명세

목표: **PC가 꺼져 있어도 폰에서 쓸 수 있는 클라우드 + 폰 전용 화면**.
이 문서와 `src/shared/cloud-contract.ts`(타입 계약)가 기준이다. 둘이 어긋나면 계약 파일이 이긴다.

## 0. 절대 규칙

- **NAI 토큰**: 코드는 토큰을 다루되, 사람(로그·화면·응답·오류 메시지)에는 절대 내보내지 않는다. 클라우드는 토큰을 받기만 하고 어떤 API로도 돌려주지 않는다. 테스트는 가짜 값만 쓴다.
- **NAI 실제 호출 금지(개발·테스트)**: 테스트·로컬 실행은 가짜 NAI(주입한 fetch 또는 `NAI_HOST` 환경변수로 로컬 모의 서버)만 쓴다.
- **Anlas를 쓰지 않는다**: 클라우드 생성은 무료 조건(아래 6절)을 매 장 확인하고, 하나라도 불확실하면 생성하지 않는다.
- **공개 경로 금지**: 그림·상태는 새 비공개 R2 버킷(`nais3-cloud`, 공개 도메인 없음)과 Durable Object 저장소에만 둔다.
- 사용자에게 보이는 글은 전부 한국어. UI 문구는 짧은 명사형 버튼(`저장`, `삭제`).
- 코드 스타일: prettier(singleQuote, semi false, printWidth 100, trailingComma none), 주석 한국어, 커스텀 표시 관례 유지.

## 1. 전체 구조

```
[폰 브라우저]  ──HTTPS──▶  [워커 nais3-cloud] ──▶ [Durable Object "hub" (SQLite)]  ──▶ [R2 nais3-cloud (비공개)]
   폰 전용 화면(정적 자산)        /api/* 만 워커 코드              상태·기기·편집 줄·작업·그림 목록          그림 파일
                                                                   alarm() = 클라우드 생성 실행기 ──▶ NAI
[PC 앱 메인] ──HTTPS(x-nais-pc 비밀값)──▶ 같은 워커
   └ 렌더러(스토어) ◀─IPC─▶ 메인  (폰 편집 반영·폰 작업 생성·클라우드용 완성 요청 계산)
```

- 워커 하나(`nais3-cloud`, 사용자 본인 Cloudflare 계정의 workers.dev)에 정적 자산(폰 화면)과 API를 같이 둔다. `assets.run_worker_first: ["/api/*"]`, SPA 폴백.
- API는 전부 단일 DO 인스턴스(`env.HUB.getByName('hub')`)로 넘긴다. DO가 인증·저장·라우팅을 한다. R2 바인딩은 DO에서도 `this.env.BUCKET`로 쓴다.
- **PC 켜짐**: 폰의 생성 요청 → DO가 작업을 `queued`로 → PC가 poll 로 가져감 → 렌더러가 원래 경로(`buildSceneRequest` → `queue:enqueueMany`)로 생성 → PC가 새 그림을 클라우드에 올림 → 폰 갤러리에 뜸.
- **PC 꺼짐**: 작업이 `cloud`로 → DO `alarm()`이 한 장씩 생성: PC가 미리 올린 「완성 요청」 + 폰 편집 재병합 + 조각 치환 + 새 시드 → NAI `/ai/generate-image` → zip을 R2에 그대로 저장(워커는 압축을 풀지 않는다 — 무료 요금제 CPU 10ms) → 폰은 fflate로 풀어 보여 주고, PC는 켜질 때 가져가 원래 씬 폴더에 저장.

## 2. 파일 소유 (병렬 작업 분담)

| 갈래 | 파일 | 하지 말 것 |
|---|---|---|
| A 워커·DO | `cloud/package.json`, `cloud/wrangler.jsonc`, `cloud/tsconfig.json`, `cloud/src/**`, `cloud/scripts/**`(웹 빌드 제외), `tests/cloud/hub*.test.ts`, `tests/cloud/cloudgen*.test.ts`, `tests/cloud/helpers/**` | 앱 `src/` 수정 금지(읽기·import만) |
| B 폰 화면 | `cloud/web/**`, `cloud/scripts/build-web.mjs`, `cloud/tsconfig.web.json`, `tests/cloud/web*.test.ts` | 워커 코드·앱 코드 수정 금지 |
| C PC 메인 | `src/main/cloud/**`, `src/main/index.ts`·`src/main/ipc.ts`의 클라우드 연결 줄, `src/main/scenes/repo.ts`에 `listAllScenesLite()` 추가, `tests/cloud-pc*.test.ts` | 렌더러 수정 금지 |
| D PC 렌더러 | `src/renderer/src/lib/cloud-bridge.ts`, `src/renderer/src/lib/cloud-prepared.ts`, `src/renderer/src/components/cloud-section.tsx`, `token-dialog.tsx`에 섹션 연결, `generation-store.ts`·`scenes-store.ts`의 최소 리팩터(아래 9절), `App.tsx`에 bridge 시작 한 줄 | 메인 수정 금지 |

계약(`src/shared/cloud-contract.ts`)과 IPC 타입(`src/shared/types.ts`의 `cloud:*`, `scenes:listAllLite`)은 이미 들어가 있다. 바꿔야 하면 직접 고치지 말고 보고서에 「계약 변경 요청」으로 적는다.

## 3. 인증

- **PC**: 헤더 `x-nais-pc: <PC_SECRET>`. 워커 비밀값 `PC_SECRET`(32바이트 무작위 base64url)과 상수 시간 비교. 틀리면 401. **PC_SECRET 이 없거나 비면 모든 `/api/pc/*` 는 503**(빈 값끼리 일치해 통과하는 일이 없게).
  - PC 앱은 첫 실행 때 `~/NAIS3 Custom 폰 연결/cloud-connect.json`(`{ "url": "...", "secret": "..." }`)이 있으면 읽어 safeStorage로 암호화 저장(설정 키 `cloud_pc_secret_encrypted`, `cloud_url`)하고 파일을 지운다. 배포 스크립트가 이 파일을 만든다(홈 폴더 아래 「NAIS3 Custom 폰 연결」).
- **폰**: 헤더 `authorization: Bearer <deviceToken>`. 토큰은 32바이트 무작위 base64url, DO에는 SHA-256 hex만 저장. 기기마다 `last_seen` 갱신(1분에 한 번만 쓰기).
- **연결(페어링)**: PC가 `POST /api/pc/pairing` → 8자리 코드(혼동 없는 31자: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` 중), 10분 유효, 1회용. 응답에 QR SVG 포함(워커가 생성, 순수 JS QR 인코더를 `cloud/src/qr.ts`에 직접 구현하거나 MIT 라이브러리 소스를 번들 — 외부 서비스 호출 금지). QR 내용 = `<워커 주소>/#pair=<코드>`.
  - 폰 `POST /api/pair { code, name }` → `{ token, deviceId }`. 코드당 실패 5회면 그 코드 폐기, 전체 페어링 시도 시간당 30회 제한(DO `ratelimit` 표).
- 응답은 전부 `cache-control: no-store`, CORS 헤더 없음(같은 출처 SPA). 오류 본문 `{ ok: false, error: '<한국어 문장>' }`, 성공 `{ ok: true, ... }`.

## 4. DO 저장소 (SQLite) — 스키마

```sql
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- k: library(JSON CloudLibrary) / hash:library / hash:fragments / settings(JSON CloudSettings)
--    pc:lastSeen / pc:queue(JSON) / pc:acceptsJobs('1'|'0') / pc:appVersion / secret:nai (NAI 토큰 — 어떤 응답에도 넣지 않음)
--    nai:quota(JSON {state, checkedAt}) / nai:epoch(NAI 토큰을 바꾸거나 지울 때마다 +1, 7-2) / main:lastPatch(JSON {patch, ackedAt}, 7-2) / schema:version
CREATE TABLE IF NOT EXISTS scenes (id INTEGER PRIMARY KEY, preset_id INTEGER NOT NULL, sort_order INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS scenes_preset ON scenes(preset_id, sort_order);
CREATE TABLE IF NOT EXISTS scene_hash (preset_id INTEGER PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prepared (key TEXT PRIMARY KEY, hash TEXT NOT NULL, request TEXT NOT NULL, updated_at INTEGER); -- updated_at = 내용이 마지막으로 바뀐 시각(같은 내용 재전송은 갱신 안 함)
CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, target TEXT NOT NULL, label TEXT NOT NULL, count INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, place TEXT NOT NULL,
  runner TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  in_flight INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, source TEXT NOT NULL, scene_id INTEGER, preset_id INTEGER, job_id TEXT,
  seed INTEGER, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, has_thumb INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL, r2_key TEXT NOT NULL, sent_payload TEXT, imported INTEGER NOT NULL DEFAULT 0, pc_image_id INTEGER);
CREATE INDEX IF NOT EXISTS images_created ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS images_scene ON images(scene_id, created_at DESC);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS pairing (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ratelimit (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL);
```

- 그림 id: PC 업로드 = `p<pcImageId>`, 클라우드 생성 = `c<무작위 12자>`. R2 키: `img/<id>.webp`, `img/<id>.zip`, 썸네일 `thumb/<id>.webp`, 조각 `meta/fragments.json`.
- 보관 정리: 그림을 넣을 때마다 `keepImages`(기본 2000)를 넘는 가장 오래된 것부터 R2·행 삭제. 단 `source='cloud' AND imported=0`은 절대 지우지 않는다.

## 5. API

공통: 본문 JSON, 성공 `{ ok: true, ...값 }`. 아래 응답 표기는 `ok` 외 필드.

### 5-1. PC (`x-nais-pc`)
| 메서드 경로 | 본문 | 응답 | 동작 |
|---|---|---|---|
| GET `/api/pc/info` | – | `CloudPcInfo` | |
| GET `/api/pc/hashes` | – | `CloudHashes` | PC가 재시작 뒤 이어서 차분 업로드 |
| PUT `/api/pc/library` | `{ library, hash }` | – | 저장 후 **미반영 편집 줄(ops acked=0) 중 char·main 패치를 다시 덧입힌다** |
| PUT `/api/pc/scenes` | `{ presetId, scenes: CloudSceneLite[], hash }` | – | 그 프리셋 씬 통째 교체 + 미반영 scene 패치 덧입힘. library.presets에 없는 프리셋의 씬·해시는 library 저장 때 지운다 |
| PUT `/api/pc/prepared` | `{ items: CloudPreparedItem[], allKeys?: string[] }` | – | upsert. allKeys가 있으면 그 밖의 키 삭제. 한 번에 200개 이하·본문 2MB 이하(넘으면 413) |
| PUT `/api/pc/fragments` | `{ byPath: Record<string,string[]>, hash }` | – | R2 `meta/fragments.json` |
| POST `/api/pc/poll` | `CloudPollRequest` | `CloudPollResponse` 필드 | lastSeen·queue·acceptsJobs 저장. ops = acked=0 전부(최대 200, id 순), jobs = state='queued' AND runner='pc'(최대 50). needsFullSync = library 없음. **state 'pc' 인데 activeJobIds 에 없고 accepted 뒤 60초가 지난 작업 → failed 「PC가 작업을 잃었습니다 (앱을 다시 켰거나 큐를 비움)」** |
| POST `/api/pc/ack` | `CloudAckRequest` | – | ops acked=1. jobs: accepted→state 'pc', done/failed→끝 상태와 개수 |
| PUT `/api/pc/images/:id` | 본문 = WebP 바이트, 헤더 `x-nais-meta`(base64url JSON `CloudImageMeta`) | – | id는 `p\d+`만. 10MB 이하. 같은 id면 덮어씀 |
| PUT `/api/pc/images/:id/thumb` | WebP 바이트(512KB 이하) | – | has_thumb=1 |
| GET `/api/pc/cloud-images` | – | `{ items: CloudGeneratedImage[] }` | source='cloud' AND imported=0, 오래된 순 최대 50 |
| GET `/api/pc/cloud-images/:id/file` | – | zip 바이트 | |
| POST `/api/pc/cloud-images/:id/imported` | `{ pcImageId }` | – | imported=1, pc_image_id 기록 |
| PUT `/api/pc/nai-token` | `{ token }` | – | `secret:nai` 저장(앞뒤 공백 제거, 비면 400). 응답에 토큰 없음 |
| DELETE `/api/pc/nai-token` | – | – | 삭제 + cloud 작업 중지(실패 처리 「NAI 토큰이 없음」) |
| PUT `/api/pc/settings` | `CloudSettings` | – | keepImages 100~20000 |
| PUT `/api/pc/scene-counts` | `CloudSceneCounts` | – | kv `scene:counts` 한 행. PC는 60초에 한 번 이하·바뀌었을 때만 |
| POST `/api/pc/pairing` | – | `{ code, url, expiresAt, qrSvg }` | url = 요청 Origin 기준 `/#pair=` |
| GET `/api/pc/devices` | – | `{ items: CloudDevice[] }` | |
| DELETE `/api/pc/devices/:id` | – | `{ items }` | |

### 5-2. 폰 (`authorization: Bearer`)
| 메서드 경로 | 본문 | 응답 | 동작 |
|---|---|---|---|
| POST `/api/pair` (인증 없음) | `{ code, name }` | `{ token, deviceId }` | name 1~40자 |
| GET `/api/me` | – | `{ deviceId, name }` | |
| GET `/api/state` | – | `CloudPhoneState` 필드 | jobs = 최근 30개(갱신 순) |
| GET `/api/scenes?presetId=` | – | `{ items: CloudPhoneScene[] }` | sort_order 순. latestImageId = 그 씬 최신 그림 |
| PATCH `/api/scenes/:id` | `CloudScenePatch` | `{ scene: CloudPhoneScene }` | ops에 scene:update 추가 + DO 사본 즉시 수정. width/height는 64배수·64~2048, name 1~100자 |
| PATCH `/api/characters/:id` | `CloudCharPatch` | – | ops char:update + library 사본 수정 |
| PATCH `/api/main` | `CloudMainPatch` | – | ops main:update + library.main 수정 |
| POST `/api/jobs` | `CloudCreateJob` | `CloudCreateJobResponse`(`job`, 선택 `notice`) | count 1~20. 7절 배정 규칙. requestId(1~100자)가 10분 안에 같으면 앞서 만든 작업을 돌려줌 |
| POST `/api/jobs/:id/cancel` | – | `{ job }` | runner pc면 ops job:cancel 추가 |
| GET `/api/images?sceneId=&presetId=&before=&limit=` | – | `{ items: CloudImageItem[], next: string \| null }` | created_at 내림차순, limit 기본 40 최대 100. next 는 `<createdAt>:<id>` 불투명 문자열이고 다음 요청의 before 로 그대로 넘긴다(숫자 createdAt 도 받음) |
| GET `/api/images/:id` | – | 바이트 (webp 또는 zip) | `content-type` 정확히 |
| GET `/api/images/:id/thumb` | – | webp (없으면 404) | |
| PUT `/api/images/:id/thumb` | webp 또는 jpeg(256KB 이하, 그 밖의 형식 415) | – | **source='cloud'이고 has_thumb=0일 때만** (폰이 zip을 풀어 만든 썸네일). has_thumb 1=WebP·2=JPEG, 받은 형식 그대로 제공 |
| DELETE `/api/images/:id[?force=1]` | – | – | 클라우드 사본만 삭제(R2+행). PC 원본은 그대로. pcPending(클라우드 생성분인데 PC가 아직 안 가져감)이면 force 없을 때 409 |
| POST `/api/logout` | – | – | 이 기기 삭제 |

## 6. 클라우드 생성 (DO alarm) — 무료 보장

PC 큐의 생성 직전 처리(`src/main/index.ts` 174~210행)를 그대로 따른다:

1. 작업 대상의 완성 요청 = `prepared['scene:<id>']` 또는 `prepared['main']`. 없으면 작업 실패 「PC가 이 씬의 생성 정보를 아직 안 올렸습니다 (PC를 한 번 켜 주세요)」.
2. 씬이면 DO 사본 씬으로 `refreshScenePrompts(request, scene)`(src/shared/scene-request.ts) — 폰에서 고친 프롬프트가 반영된다.
3. `request.transparentBackground === true`면 `withTransparentBackground(request, true)`.
4. 조각·와일드카드: R2 `meta/fragments.json`으로 `FragmentSource` 를 만들고(조회 키 `trim().toLowerCase()`), prompt·negativePrompt·characterPrompts[].prompt/negativePrompt 에 `processWildcards(removeComments(text), source, Math.random)` (src/main/fragments/processor.ts — 순수). 순차 `<*이름>`은 카운터를 kv `seq:<path>`에 저장해 이어 간다.
5. 시드: 무작위 0~4294967295.
6. **무료 조건 검사 — 하나라도 어기면 생성하지 않고 작업 실패(이유를 한국어로)**:
   - `width*height <= CLOUD_FREE_MAX_PIXELS`, `steps <= CLOUD_FREE_MAX_STEPS`, `source`(i2i) 없음, vibeIds·charRefIds 무시(전송 안 함).
   - NAI 구독 확인 `GET https://image.novelai.net/user/subscription`(Bearer): tier>=3(Opus)이 아니면 실패. V5 모델이면 `parseOpusUsage(data.usage)` → `quotaState`가 **'available'일 때만** 진행(unknown·exhausted면 「이번 달 무료 사용량이 확인되지 않아 클라우드 생성을 멈췄습니다」). 결과는 kv `nai:quota`에 저장(폰 표시용). **V5 모델은 매 장 생성 직전 확인**, 그 밖의 모델은 첫 장 전·첫 장 직후·5장마다. 토큰을 넣거나 지울 때마다 kv `nai:epoch`가 올라가고, 작업이 마지막으로 확인한 epoch 와 다르면 모델과 상관없이 다음 장 전에 반드시 다시 확인한다(기준 잔액도 epoch 에 묶음). 잔액 필드를 숫자로 못 읽으면 「Anlas 잔액을 확인하지 못해 멈췄습니다」로 멈춘다.
   - 공용 판정 `estimateAnlas({...}).free === true`(src/shared/anlas.ts)도 함께 확인.
   - 안전망: 작업 첫 장 전후 Anlas 잔액(`trainingStepsLeft.fixedTrainingStepsLeft + purchasedTrainingSteps`)이 줄었으면 작업을 즉시 멈추고 실패 「Anlas가 차감되어 중단했습니다」 + settings.cloudGenEnabled=false.
7. 페이로드: `buildGenerateImagePayload(request, { imageFormat: 'png' })`(src/main/nai/payload.ts — 순수). `POST https://image.novelai.net/ai/generate-image`, 헤더 `Authorization: Bearer <토큰>`, `Content-Type: application/json`, `Accept: application/x-zip-compressed`. 429면 `Retry-After`(없으면 5초)만큼 미루고 같은 장 재시도(최대 6회). 그 밖의 실패는 그 장 실패(본문 앞 200자를 오류에 — 토큰이 섞일 수 없는 응답 본문만).
8. 응답 zip을 **풀지 않고** R2 `img/c….zip`에 저장, images 행(source 'cloud', format 'zip', sent_payload = 보낸 payload JSON, seed, width/height, scene_id, preset_id, job_id). 그다음 보관 정리.
9. at-least-once: 장을 시작하기 전에 jobs.in_flight=1, attempts+1을 먼저 저장. alarm 재시도로 다시 들어왔는데 in_flight=1이면 attempts가 3을 넘었을 때 그 장을 실패 처리하고 넘어간다.
10. 한 번의 alarm에서 **한 장만** 만들고, 남은 장·작업이 있으면 `setAlarm(Date.now() + 1500)`. 예외는 잡아서 기록하고 다음 alarm을 건다(무한 재시도 금지 — attempts로 끊음).
11. NAI 호출 주소는 `env.NAI_HOST`(기본 `https://image.novelai.net`)로 바꿀 수 있게(로컬 모의용).

## 7. 작업 배정

- `POST /api/jobs`: `pcOnline = now - pc:lastSeen < CLOUD_PC_ONLINE_MS && pc:acceptsJobs === '1'`.
  - place 'pc' 또는 (auto && pcOnline) → state 'queued', runner 'pc'.
  - place 'cloud' 또는 (auto && !pcOnline) → 클라우드 생성 준비 확인(cloudGenEnabled, NAI 토큰, 완성 요청 존재) — 안 되면 400 + 이유. 되면 state 'cloud', runner 'cloud', `setAlarm(now)`.
  - place 'pc'인데 PC가 꺼져 있어도 queued로 두고(PC가 켜지면 처리), 응답에 그 사실을 알린다.
- PC에 넘긴 queued 작업이 45초 동안 accepted 안 되고 PC가 꺼졌으며 place가 auto면 → cloud로 넘긴다(alarm이 확인).
- 라벨: 씬이면 DO 사본 씬 이름, 메인이면 「메인 생성」.

## 7-1. 중복·유실 방지 (2차 반영)

- PC 렌더러는 폰 작업으로 만든 요청마다 `GenerationRequest.cloudJobId = job.id`를 단다. PC 메인은 렌더러가 다시 준비됐을 때(새로고침) 작업을 다시 넘기기 전에, 큐에 이미 그 cloudJobId 항목이 있으면 넘기지 않고 그 큐 id들로 추적을 이어 간다.
- PC 메인은 poll 마다 추적 중인 작업 id를 `activeJobIds`로 보낸다. 앱을 다시 켜 큐를 잃으면 빈 목록이 가므로 클라우드가 그 작업들을 실패로 정리한다.
- 무료 사용량: 클라우드는 확인 결과를 `CloudPcInfo.quota`·`CloudPhoneState.cloudGen.quota`로 알려 준다. PC는 생성 뒤 잔액 조회 결과(tier·anlas·opusUsage)를 `library.naiInfo`로 올린다(메인 index.ts·ipc.ts 의 잔액 조회 지점에 훅).
- 로컬 NAI 토큰이 바뀌는 경로(nai:setToken · nai:deleteToken · accounts:add · accounts:remove · accounts:setActive · backup:import · 한도 소진 때의 자동 계정 전환)는 `onNaiTokenChanged()` 훅을 부른다(accounts:add·accounts:remove·backup:import 는 처리 전후 토큰을 비교해 실제로 바뀐 때만). 클라우드 생성이 켜져 있을 때 새 토큰이 있으면 다시 맡기고, 토큰이 없어졌으면(nai:deleteToken · 활성 계정 삭제) 맡긴 토큰도 지우고 클라우드 생성을 끈다.
- wrangler.jsonc 의 compatibility_date 는 로컬 wrangler 4.114 의 workerd 가 지원하는 2026-07-29 로 둔다.

## 7-2. 3차 반영 — 검토 결과 (무료 요금제 한도·무료 보장·정확성)

**무료 요금제 한도 (DO 하루 쓰기 10만 행·읽기 500만 행, 워커 요청 10만 건)** — 이걸 넘기면 그날 클라우드 전체가 멈춘다.
- 씬 업로드는 **차분 반영**: 프리셋 씬을 지웠다 다시 쓰지 않는다. 기존 data 와 다른 행만 `INSERT … ON CONFLICT(id) DO UPDATE … WHERE data <> excluded.data`, 업로드에 없는 id 만 DELETE.
- 씬 그림 수는 씬 본문에서 뺐다(`CloudSceneLite.imageCount` 없음). PC는 `PUT /api/pc/scene-counts`(`CloudSceneCounts`)로 **60초에 한 번 이하**, 바뀌었을 때만 보낸다. 워커는 kv 한 행(`scene:counts`)에 두고 폰 응답 `CloudPhoneScene.imageCount`에 채운다. PC는 그림 저장 때 씬 스냅샷을 다시 계산하지 않는다(sceneId 없는 그림은 아무것도 안 함).
- 인덱스: `images(created_at, id) WHERE source='cloud' AND imported=0`(부분), `images(preset_id, created_at DESC)`, `jobs(state, runner, created_at)`, `jobs(updated_at DESC)`, `ops(id) WHERE acked=0`(부분). 개수(COUNT)는 kv 카운터로 유지하고, `/api/pc/hashes` 의 prepared 해시는 kv 한 덩어리 캐시로 읽는다.
- poll 의 kv 쓰기: lastSeen·queue·acceptsJobs 는 DO 인스턴스 메모리에 두고 디스크에는 **60초에 한 번 또는 값이 바뀔 때만**(queue 비교는 updatedAt 제외). appVersion 은 바뀔 때만.
- 끝난 작업 보관 7일, 정리는 하루 한 번(알람 또는 poll).
- 미반영 편집 줄(ops): 같은 대상(scene id·char id·main)의 미반영 줄은 **기존 줄에 병합**한다. 미반영 줄 최대 300개·줄당 200KB·poll 응답 합계 2MB — 넘으면 폰 편집을 429 「편집이 너무 많이 쌓였습니다. PC를 켜서 반영한 뒤 다시 시도하세요」.
- 본문 크기는 **읽기 전에** 막는다: Content-Length 가 한도를 넘으면 413, 없으면 스트림으로 읽으며 한도를 넘는 즉시 중단. `/api/pair` 한도 2KB, 시도 제한은 본문을 읽기 전에 건다.

**무료 보장 (절대 규칙 강화)**
- V5 모델은 **매 장 생성 직전** 구독을 확인한다(tier Opus · quotaState 'available' · Anlas 잔액 숫자 확인). Anlas 잔액이 직전 확인보다 줄었으면 즉시 멈추고 클라우드 생성을 끈다. 잔액 필드를 못 읽으면(숫자 아님) 「Anlas 잔액을 확인하지 못해 멈췄습니다」로 멈춘다.
- NAI 토큰이 바뀌거나 지워지면 진행 중인 cloud 작업은 다음 장 전에 반드시 구독을 다시 확인한다. 표시(verify) 대신 **세대 번호** kv `nai:epoch`(토큰을 다른 값으로 바꾸거나 지울 때마다 +1, 같은 토큰을 다시 맡기면 그대로)를 쓴다 — 작업마다 kv `anlas:<작업>` = `<세대>:<기준 잔액>`으로 「구독 확인을 마친 마지막 세대」와 그때의 잔액을 함께 묶고, 지금 세대와 다르거나 기록이 없으면 확인한다(다른 세대의 잔액과는 견주지 않음). 세대는 토큰을 읽는 같은 순간에 읽어 두고 확인이 끝난 뒤 그 값으로 기록하므로, 확인 응답을 기다리는 사이 토큰이 바뀌면 다음 장 전에 또 확인한다. (`verify:<작업>` 은 첫 장 직후 확인이 일시 오류로 못 끝났을 때만 쓰는 표시다.)
- 클라우드용 완성 요청과 폰 작업의 PC 실행은 **PC에 불러 둔 i2i 소스를 무시**하고 만든다(렌더러 `buildSceneRequest`·`assembleMainRequest`에 소스 무시 옵션).
- 폰에서 고친 **메인 프롬프트**(미반영 main:update)는 클라우드 생성 때 완성 요청에 덧입힌다. PC 가 ack 한 뒤에도 PC 가 새 완성 요청을 올리기 전(약 20초)에는 prepared 가 옛 프롬프트라서, ack 한 패치와 ack 시각을 kv `main:lastPatch` 에 남기고 **그 작업이 쓰는 prepared 행**(`main` 또는 `scene:<id>`)의 `updated_at` 이 ack 시각보다 늦어지기 전까지 계속 덧입힌다(행마다 따로 판단 · 시각이 없는 옛 행은 가장 오래된 것). 앞서 남긴 패치는 `main` 행이 그 뒤로 안 올라왔을 때만 새 패치와 합친다. 같은 내용 재전송은 갱신이 아니다. 씬 프롬프트·해상도 편집(scene:update)은 DO 씬 사본에 이미 들어가 있어 ack 와 무관하게 `refreshScenePrompts` 로 반영된다. 덧입히는 방법: 메인 작업은 prompt/promptParts/negativePrompt, 씬 작업은 sceneBasePrompt·sceneBasePromptParts·sceneBaseNegativePrompt 에 같은 패치를 얹은 뒤 refreshScenePrompts. **캐릭터 편집**(미반영 char:update)은 완성 요청에 반영할 수 없으므로, 그런 편집이 있으면 클라우드 작업 생성 응답 notice 로 「캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다」를 알린다.

**정확성**
- 알람: 연속 실패해도 끊지 않고 간격만 늘린다(최대 10분). cloud 작업이 남아 있으면 항상 다음 알람이 있어야 한다.
- 429: `Retry-After` 를 kv `nai:notBefore` 에 저장하고, 그 전에는 어떤 경로로 알람이 와도 생성하지 않는다.
- 조각 순차 카운터는 그림 저장에 성공한 뒤에만 저장한다.
- 폰 갤러리 `CloudImageItem.pcPending`: 클라우드 생성분을 PC가 아직 안 가져갔으면 true. `DELETE /api/images/:id` 는 pcPending 이면 `?force=1` 없을 때 409 「PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다」. 폰은 이 경우 다른 확인 문구를 보인다.
- `CloudCreateJob.requestId`: 같은 id 로 10분 안에 다시 오면 앞서 만든 작업을 돌려준다(kv 또는 jobs 열).
- 썸네일 PUT 은 `image/webp` 와 `image/jpeg` 둘 다 받고, 받은 형식 그대로 돌려준다(iOS Safari 는 canvas WebP 인코딩 불가 → 폰은 JPEG 폴백).
- PC 큐 항목 요약(`QueueItemLite.cloudJobId`)에 폰 작업 id 를 싣고, PC 「모두 취소」는 폰 작업 항목을 씬 예약 수로 되돌리지 않는다.
- 폰 작업 실행 전 `scenes:isLive` 로 씬·프리셋이 휴지통에 있지 않은지 확인한다.

## 7-3. 4차 반영 — 구현이 정한 세부 (요약)

- DO 저장소 판 4: jobs.accepted_at·jobs.request_id·prepared.updated_at 추가. 인덱스 images_cloud_pending(부분)·images_preset·images_scene2·jobs_active·jobs_updated·jobs_request·ops_pending(부분).
- kv 키: `n:images`(전체·미수신 그림 수 카운터, 하루 한 번 재계산), `hash:prepared`(완성 요청 해시 캐시, 1.5MB 넘으면 표에서 읽음), `scene:counts`, `cleanup:at`, `nai:notBefore`, `nai:epoch`, `main:lastPatch`(PC가 ack 한 마지막 메인 편집 — 새 완성 요청이 올라오기 전까지 계속 덧입힘), `rl:*`(시도 제한), `seq:*`(조각 순차 카운터).
- 본문을 읽지 않고 돌려보내는 응답은 남은 본문을 64KB·2초까지 비운다(로컬 workerd 세션 보호).
- 편집 줄 병합은 옛 줄을 지우고 새 번호로 다시 세운다(반영 중인 PC의 ack 가 병합분을 덮지 않게). 상한: 미반영 300줄·줄당 200KB·합계 2MB, 넘으면 429.
- 렌더러가 반영 못 한 편집은 `CloudWorkResult.failedOpIds`로 알리고, 메인은 다음 라이브러리 업로드를 강제해 폰 사본을 되돌린다.
- 실패 편집 되돌림 (A): 강제 업로드는 실패한 줄의 ack 가 워커에 닿은 것이 확인된 뒤에만 나간다(워커 putLibrary·putScenes 는 acked=0 줄을 다시 덧입힘). 강제 업로드 직전에 대기 ack 를 먼저 보내고, 실패 줄 id 가 아직 outbox 에 남아 있으면 이번엔 올리지 않고 플래그를 유지한다.
- 실패한 scene:update 되돌림 (B): 씬은 프리셋 해시가 같으면 다시 안 보내므로 메인이 넘긴 ops 를 id→op 로 기억해 두고, failedOpIds 중 scene:update 는 그 씬의 프리셋을 해시와 무관하게 A 규칙대로 ack 확인 뒤 다시 올린다.
- 실패 편집 되돌림 (C, 재시작 대비): A·B 의 플래그는 PC 메모리에만 있어 ack 직후 앱이 꺼지면 사라진다. 그래서 PC 는 ack 에 `CloudAckRequest.failedOpIds`(반영 못 한 줄)를 함께 싣고, 워커는 그 줄이 아직 acked=0 이면 대상 해시를 지운다(scene:update → 그 씬 프리셋의 `scene_hash`, char·main → `hash:library`). 다시 켠 PC 의 첫 동기화가 해시 차이로 실제 값을 올려 폰 사본이 돌아온다. 폰 편집만으로는 해시를 지우지 않는다(반영되면 PC 해시가 어차피 바뀌고, ack 전에 올리면 덧입혀져 쓰기만 늘어난다). 실패 줄은 클라우드 생성의 메인 덧입힘(`main:lastPatch`)에도 남기지 않는다.
- 완성 요청에서 source 가 없으면 i2iStrength·i2iNoise 를 뺀다(소스가 있을 때만 쓰이는 값이라, 남기면 i2i 강도만 바꿔도 모든 씬·메인 해시가 달라져 전부 다시 올라간다).
- 씬 스냅샷 sortOrder 는 DB 의 안정적인 sort_order 를 쓴다(가운데 씬 삭제 때 뒤 씬 전부 재기록 방지).

## 8. PC 메인 (`src/main/cloud/`)

- `config.ts`: 설정 키 `cloud_url`(기본값 없음 — 연결 파일로만 들어오고, 비어 있으면 「설정 안 됨」), `cloud_pc_secret_encrypted`(safeStorage, 불가 시 base64 — r2/client.ts 패턴), `cloud_enabled`(기본 '1' — 단 비밀값이 있을 때만 의미), `cloud_upload_images`(기본 '1'), `cloud_keep_images`(기본 2000), `cloud_gen_enabled`(기본 '0'), `cloud_upload_state`(JSON: 마지막으로 올린 pc 이미지 id·해시들). 연결 파일 가져오기(3절).
- `client.ts`: `cloudFetch(path, init)` — 타임아웃 20초(AbortSignal.timeout), 헤더 x-nais-pc, JSON 파싱, 오류를 한국어 Error로. 비밀값·토큰을 오류 메시지에 넣지 않는다.
- `snapshot.ts`(순수 함수 위주 — 테스트 대상): DB에서 CloudLibrary·프리셋별 CloudSceneLite[]·조각 byPath를 만든다. 씬은 `listAllScenesLite()`(썸네일 없는 새 쿼리, scenes/repo.ts에 추가)를 쓴다. 캐릭터 썸네일·이미지 BLOB은 싣지 않는다. 해시는 안정 정렬 JSON의 SHA-1.
- `sync.ts`: 켜져 있으면
  - 시작 시 `GET /api/pc/hashes` → 바뀐 것만 업로드(library, 프리셋별 scenes, fragments). 이후 30초마다(그리고 렌더러가 데이터를 바꿨다고 알 때 디바운스 3초) 같은 비교.
  - 5초마다 `POST /api/pc/poll`(queue = 큐 statusLite 요약, acceptsJobs = 렌더러 준비됨). 받은 ops·jobs 중 `job:cancel`은 메인이 직접 처리(그 작업의 큐 id들을 `queue.cancel`), 나머지는 `broadcast('cloud:work', …)`. 같은 작업을 두 번 넘기지 않는다(넘긴 id 기억).
  - `cloud:workDone` 받으면: ops ack, 작업마다 accepted + 큐 id 기억. 큐 'changed'에서 그 id들이 전부 끝 상태가 되면 done/failed 개수와 함께 ack. 렌더러가 error를 주면 failed ack.
  - poll 응답 needsFullSync면 해시 무시하고 전부 다시 올림 + `broadcast('cloud:needPrepared', { full: true })`.
  - 그림 올리기: index.ts의 저장 직후 훅 `onCloudImageSaved({ id, filePath, sceneId, seed, kind })` → 대기열 → `uploadBytes`(r2/upload-image.ts, 메타 제거 WebP) 본문 + DB 썸네일 BLOB으로 thumb 업로드. 동시 2개, 실패는 3회 재시도 후 포기(상태에 표시). 클라우드에서 가져온 그림(아래)은 다시 올리지 않는다.
  - 클라우드 생성분 가져오기: 30초마다(그리고 poll 직후 cloudJobsActive>0이면) `GET /api/pc/cloud-images` → zip 받아 jszip으로 첫 항목 PNG → `saveGeneratedImage({ png, sentPayload, seed, kind: sceneId ? 'scene' : 't2i', sceneId, format: 'png', sceneName, scenePresetName })`(index.ts 283~308행과 같은 이름 채우기) → 씬이면 `broadcast('scenes:changed', …)` → `POST …/imported { pcImageId }`. 씬이 PC에서 지워졌으면 sceneId 없이 일반 그림으로 저장.
  - 상태 `broadcast('cloud:status', …)`는 바뀔 때만.
- `cloud:setCloudGen { enabled }`: 켜면 `getNaiToken()`으로 `PUT /api/pc/nai-token` 후 `PUT /api/pc/settings`, 그리고 `broadcast('cloud:needPrepared', { full: false })`. 끄면 `DELETE /api/pc/nai-token` + settings. NAI 토큰을 바꾸는 경로(`nai:setToken` · `nai:deleteToken` · `accounts:add` · `accounts:remove` · `accounts:setActive` · `backup:import` · index.ts 의 한도 소진 자동 계정 전환)가 일어나고 cloud_gen_enabled면 새 토큰으로 다시 PUT, 토큰이 없어졌으면 DELETE + 클라우드 생성 끔(해당 핸들러에 `onNaiTokenChanged()` 한 줄 훅 — `accounts:add`·`accounts:remove`·`backup:import` 는 처리 전후 `getNaiToken()` 을 비교해 토큰이 실제로 바뀐 때만 부른다).
- `cloud:pairing`: `POST /api/pc/pairing` 그대로 돌려줌.
- `cloud:prepared`: 렌더러가 준 항목을 해시 비교해 바뀐 것만 200개씩 PUT. allKeys가 오면 마지막 묶음에 실어 남는 키 삭제.
- index.ts: `registerIpcHandlers` 직후 `startCloud({ queue })`, quit 때 `stopCloud()`, 저장 직후 `onCloudImageSaved`. 이 셋 외에는 index.ts를 건드리지 않는다.

## 9. PC 렌더러

- `generation-store.ts`: `generate()` 안의 요청 조립을 `buildMainRequest(): Promise<GenerationRequest>`(시드 포함, 배치 수와 무관)로 빼고, `generate()`는 그걸 쓰도록. 새 `generateMain(count: number): Promise<string[]>`(큐 id 반환, 시드 정책은 generate와 같음). 기존 동작은 바뀌면 안 된다.
- `scenes-store.ts`: `ensureExtrasData`·`sceneSeed`를 export. 새 `enqueueSceneRequests(scene: Scene, count: number): Promise<string[]>` — 큐 반복 없이 `buildSceneRequest(scene)`×count + 시드 `sceneSeed(i)`로 `queue:enqueueMany`, 반환 id들. 활성 프리셋이 아니어도 동작(Scene 객체는 `scenes:get`).
- `cloud-bridge.ts` (`startCloudBridge()` — App.tsx에서 한 번):
  - `cloud:work` 처리 순서: ops를 id 순으로 반영 → jobs 실행 → `cloud:workDone`.
    - scene:update → `scenes:update` IPC 후 그 씬이 활성 프리셋이면 `useScenesStore.getState().load()`(선택된 씬이면 상세도).
    - char:update → `useCharactersStore.getState().updateCard(id, patch)`.
    - main:update → generation-store의 request에 반영(분할 모드면 promptParts도 — `requestForPromptMode` 규칙 따름).
    - job scene → `scenes:get` → 없거나 지워졌으면 error 「씬이 PC에 없음」 → `enqueueSceneRequests(scene, count)`.
    - job main → `generateMain(count)`.
  - 시작 때 `cloud:rendererReady`.
- `cloud-prepared.ts`: `cloud:status`의 cloudGen.enabled가 켜져 있을 때만 동작. 계기: `cloud:needPrepared`, 그리고 생성 설정·캐릭터·복장·씬별 추가·씬 목록이 바뀌면 20초 디바운스. 할 일: `ensureExtrasData()` → `scenes:listAllLite` → 씬마다 `buildSceneRequest(scene)`에서 seed 제거 → 안정 JSON 해시(FNV-1a 64 등 빠른 것) → 이전에 보낸 해시와 다른 것만 모아 `cloud:prepared`로 200개씩. 메인도 `buildMainRequest()` 결과로 'main'. 마지막 묶음에 allKeys. 씬 수천 개여도 UI가 멈추지 않게 50개마다 `await new Promise(r => setTimeout(r, 0))`.
- `cloud-section.tsx`: 설정 대화상자 새 섹션 「모바일」(token-dialog.tsx NAV에 추가, 아이콘 lucide `Smartphone`). 기존 Row/Switch/Button/askConfirm/toast 관례.
  - 상태 카드: 연결됨/끊김/설정 안 됨, 워커 주소, 마지막 동기화(상대 시간), 오류 문구, 판 불일치 경고.
  - 동기화(Switch).
  - 폰 연결: [연결 코드 만들기] → QR(SVG를 data URL `<img>`로) + 코드 + 남은 시간 카운트다운. 다시 누르면 새 코드.
  - 연결된 기기: 이름·마지막 접속·[해제](askConfirm).
  - 그림 올리기(Switch) · 클라우드 보관 장수(Select 500/1000/2000/5000) · [최근 100장 올리기].
  - PC 꺼졌을 때 클라우드 생성(Switch) — 켤 때 askConfirm: 「NAI 토큰을 클라우드(내 Cloudflare 계정)에 맡깁니다. 무료 범위(Opus · 1024×1024 이하 · 28스텝 이하 · 이번 달 무료 사용량 남음)일 때만 생성하고, Anlas가 줄면 즉시 멈춥니다.」 상태에 무료 사용량 표시.
  - [지금 동기화].

## 10. 폰 화면 (`cloud/web/` → 빌드 결과 `cloud/public/`)

- Preact + TSX, esbuild 번들(목표 gzip 60KB 이하), fflate(zip 해제). 외부 CDN 의존 없음(글꼴은 시스템 글꼴 스택 + `Pretendard`가 있으면 사용).
- 디자인: NAIS3 다크 토큰 `--bg #0f0f10`, `--surface #161618`, `--surface-2 #1e1e21`, `--line #252528`, `--ink #ededed`, `--muted #a1a1aa`, `--faint #71717a`, `--accent #eb9550`, `--danger #ef5b5b`. 둥근 모서리 12px, 아이콘은 인라인 SVG(lucide 경로 복사). 보라 그라데이션·이모지·원색 금지. 세로 360~430px 기준, 하단 탭바, 안전 영역(env(safe-area-inset-*)) 처리, 버튼 최소 44px.
- PWA: `manifest.webmanifest`(이름 NAIS3, standalone, 테마 #0f0f10, 아이콘 SVG·192/512 PNG) — 홈 화면에 추가.
- 상태 저장: 토큰은 localStorage `nais3_cloud_token`(try/catch). 401이면 토큰 지우고 연결 화면.
- 화면:
  1. **연결**: `#pair=` 있으면 코드 채움 → 기기 이름(기본 「내 폰」) → [연결]. 없으면 코드 8칸 입력 안내(「PC NAIS3 → 설정 → 모바일 → 연결 코드 만들기」).
  2. **상단 상태줄**(모든 탭): PC 켜짐(초록 점)·꺼짐 / 생성 위치 안내(「PC가 생성」·「클라우드가 생성 (무료 범위)」·「지금은 생성 불가: 이유」) / PC 큐 진행(생성 중 n · 대기 m).
  3. **씬 탭**: 프리셋 선택(씬/배경 구분), 씬 카드 2열 그리드(최신 그림 썸네일, 이름, 그림 수, 편집 대기 배지). 카드 탭 → 씬 시트: 이름·프롬프트·네거티브(자동 높이 textarea, [저장]), 해상도(프리셋 몇 개 + 직접), 생성 장수 스테퍼(1~20) + [생성], 위치 선택(자동/PC/클라우드 — 접어 둔 고급), 그 씬 최근 그림 가로 스크롤.
  4. **생성 탭**(메인): 분할 모드면 고정·가변·디테일 3칸, 아니면 한 칸 + 네거티브, 캐릭터 목록(켜기/끄기 스위치, 이름), 장수 + [생성].
  5. **갤러리 탭**: 최근 그림 3열 그리드(무한 스크롤), 씬 필터(칩). 탭 → 전체 화면 보기(좌우 스와이프, 두 손가락 확대는 기본 동작 허용), [저장](Web Share API로 파일 공유 가능하면 공유, 아니면 a[download]), [삭제](확인 후, 「클라우드 사본만 지웁니다」), 정보(씬·시드·크기·시각). 클라우드 생성분(zip)은 fflate로 풀어 PNG blob으로 보여 주고, 썸네일이 없으면 canvas로 360px WebP 썸네일을 만들어 `PUT /api/images/:id/thumb`로 한 번 올린다.
  6. **작업 탭**: 작업 목록(라벨·장수 진행 done/count·상태·누가 생성·오류), 진행 중이면 [취소].
  7. **설정 탭**: 기기 이름, PC 상태, 클라우드 생성 상태(무료 사용량 표시), [연결 해제](logout).
- 갱신: 화면이 보일 때 `/api/state` 4초마다(안 보이면 멈춤), 작업이 진행 중이면 갤러리 첫 페이지도 8초마다. 이미지 요청은 Authorization 헤더가 필요하므로 `fetch` → blob URL(메모리 캐시, 화면 밖으로 나가면 revoke).
- 오류는 화면 아래 토스트(한국어). 오프라인이면 상단에 「연결 끊김」.

## 11. 테스트·검증

- 앱 vitest(`tests/**/*.test.ts`, Node 24 `node:sqlite`)로 워커 핵심을 시험한다: DO의 `ctx.storage.sql`과 같은 모양의 어댑터(`exec(query, ...bindings)` → `{ toArray(), one(), rowsWritten }`)를 node:sqlite로 만들고(`tests/cloud/helpers/sql.ts`), R2는 Map 모의, NAI는 주입 fetch 모의. 워커 라우터는 표준 Request/Response로 직접 호출.
  - 필수 시나리오: 인증(PC 비밀 틀림 401, 폰 토큰 없음 401, 페어링 1회용·만료·실패 5회), 라이브러리·씬 업로드와 미반영 편집 덧입힘, poll/ack 흐름, 작업 배정(PC 켜짐/꺼짐/45초 넘김), 클라우드 생성 무료 검사(해상도·스텝·Opus 아님·quota unknown/exhausted·Anlas 감소 안전망 → 생성 안 함), 429 재시도, at-least-once 중복 방지, 보관 정리(미가져간 클라우드분 보존), NAI 토큰이 어떤 응답에도 안 나옴(응답 전부 문자열 검사).
- PC 메인: snapshot 순수 함수, cloud 클라이언트(가짜 fetch), 작업 큐 id 추적 → done ack.
- 폰 화면: `wrangler dev`(로컬 모의 DO·R2, `.dev.vars`에 가짜 PC_SECRET·`NAI_HOST=http://127.0.0.1:<모의포트>`)로 띄워 앱 내장 브라우저 모바일 뷰포트에서 확인.
- 타입체크: 앱 `npm run typecheck`, 워커 `cloud`의 `tsc -p cloud/tsconfig.json`·`cloud/tsconfig.web.json`.

## 12. 배포 (사용자 확인 후에만)

`cloud/scripts/deploy.mjs`(`npm run deploy`, 실행 없이 순서만 `npm run deploy:dry`, 주소 지정 `--url`): ① 웹 빌드 ② `wrangler r2 bucket list`에 없을 때만 `wrangler r2 bucket create nais3-cloud` ③ 무작위 PC_SECRET 생성 ④ `wrangler deploy --secrets-file <임시 파일>`로 코드와 비밀값을 한 번에 배포(임시 파일은 finally 에서 삭제, --secrets-file 미지원이면 deploy 뒤 `wrangler secret put PC_SECRET` 표준입력) ⑤ `~/NAIS3 Custom 폰 연결/cloud-connect.json` 작성(앱이 가져가고 지움). 워커 주소는 기본값이 없다: `--url`을 주면 그 주소를 연결 파일에 적고(배포 출력의 주소와 다르면 알림), 안 주면 `wrangler deploy` 출력에 나온 `https://….workers.dev` 주소를 쓴다 — 서로 다른 주소가 정확히 하나일 때만이고, 없거나 여러 개면 ④에서 멈추고 `--url <주소>`로 다시 실행하라고 알린다(워커는 이미 배포된 상태). 비밀값은 어디에도 출력하지 않는다. 다시 배포하면 PC_SECRET 이 새로 바뀌고 앱이 연결 파일로 새 값을 받는다.
