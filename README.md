<div align="center">

# NAIS3 Custom

**NovelAI Image Studio 3 커스텀판** — [sunanakgo/NAIS3](https://github.com/sunanakgo/NAIS3) 기반 비공식 빌드

[![License](https://img.shields.io/badge/License-GPL--3.0-blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/qkr132-lab/nais3-custom)](https://github.com/qkr132-lab/nais3-custom/releases/latest)

</div>

---

> ⚠️ **비공식 커스텀 빌드입니다.** 원작 [NAIS3](https://github.com/sunanakgo/NAIS3)(sunanakgo)를 기반으로
> NAIS2 Custom의 기능과 여러 편의 기능을 추가했습니다. 문제가 생겨도 **원작자에게 문의하지 마세요.**

## 설치

[**최신 릴리즈**](https://github.com/qkr132-lab/nais3-custom/releases/latest)에서 `nais3-custom-x.x.x-setup.exe`를 받아 실행하세요.

- 공식 NAIS3와 **별도 앱**으로 설치됩니다 (같이 써도 충돌 없음).
- 첫 실행 때 공식 NAIS3의 데이터(씬·캐릭터·프롬프트·설정)를 **자동으로 복사**해옵니다. 원본은 건드리지 않습니다.
- **자동 업데이트**를 지원합니다 — 새 버전이 나오면 앱이 알아서 받아 설치합니다.
- NovelAI 구독과 API 토큰이 필요한 건 공식판과 동일합니다.

## 공식 NAIS3에 추가된 기능

### 씬 모드
- **큐 반복** — 캐릭터/캐릭레퍼/바이브 조합을 바꿔가며 예약 전체를 반복 생성
- **씬별 캐릭터 추가** — 특정 씬에만 캐릭터/레퍼런스 추가 적용 (다중 씬 일괄 가능)
- **씬별 Variety+** — 씬마다 개별 적용 (카드에 배지 표시)
- **선택 예약** — 편집 모드에서 고른 씬들만 예약 ±/일괄 복제, Shift+클릭 범위 선택
- 생성 중 씬마다 남은 개수 실시간 표시, 생성 중 + 누르면 바로 큐에 이어붙음, 취소 시 남은 예약 자동 복원

### 안전장치
- **씬 휴지통** — 삭제 복원, 보관 기간 설정 + **Ctrl+Z 연속 실행취소**
- 이미지 삭제는 Windows 휴지통으로 (영구삭제 아님)
- **매일 자동 DB 백업** — 용량 상한 설정 가능

### 태그
- **한글 태그 자동완성** — "홍채", "핑크 동공", "미드리프트"처럼 한글로 쳐도 단부루 태그를 찾아줌
  (사전 4,200+개 + 발음 매칭 + 조합 검색)
- **태그 탐색기** — 신체/의상/악세서리 등 카테고리별로 태그를 둘러보고 클릭 삽입

### 그 밖에
- 캐릭터 카드에 **레퍼런스 연결** (캐릭터 포함 시 자동 적용, 대형 설정 창)
- **내장 브라우저** (단부루/태그 사전 퀵링크, 프록시 설정)
- **이미지 라이브러리** (참고 이미지 모음, 메타데이터/i2i/태그 분석)
- 이미지를 **드래그로 밖에 저장** (드래그 중 창 투명 + 클릭 통과)
- 메타데이터 창 가독성 개선 (항목별/전체 복사)
- 스타일 태그 분석 (Kaloscope)

## 라이선스

GPL-3.0. 원작 [sunanakgo/NAIS3](https://github.com/sunanakgo/NAIS3)를 따릅니다.
누구나 소스를 수정·재배포할 수 있으며, 재배포 시 GPL-3.0을 지켜야 합니다.

## 빌드

```bash
npm install
npm run build:win   # Windows 설치본 (dist/)
```
