// NAIS3 Custom 배포용 표지 PNG 생성 (sharp SVG 렌더)
import sharp from 'sharp'

const svg = `
<svg width="1200" height="675" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141417"/>
      <stop offset="1" stop-color="#1f1f26"/>
    </linearGradient>
    <linearGradient id="ac" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#8b7fd8"/>
      <stop offset="1" stop-color="#6a9e9e"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect x="60" y="330" width="120" height="6" rx="3" fill="url(#ac)"/>
  <text x="60" y="240" font-family="Segoe UI, sans-serif" font-size="88" font-weight="800" fill="#f2f2f5">NAIS3 Custom</text>
  <text x="60" y="305" font-family="Segoe UI, sans-serif" font-size="34" fill="#9a9aa5">v1.1.0 — NovelAI Image Studio 3 커스텀판</text>
  <text x="60" y="400" font-family="Segoe UI, sans-serif" font-size="24" fill="#c9c9d2">큐 반복 · 씬별 캐릭터 · 한글 태그 검색 · 태그 탐색기 · 휴지통/자동백업</text>
  <text x="60" y="440" font-family="Segoe UI, sans-serif" font-size="24" fill="#c9c9d2">내장 브라우저 · 라이브러리 · 드래그 저장 · Ctrl+Z 실행취소</text>
  <rect x="60" y="500" width="1080" height="110" rx="14" fill="#26262e"/>
  <text x="90" y="545" font-family="Segoe UI, sans-serif" font-size="26" font-weight="700" fill="#8b7fd8">📦 이 이미지가 곧 설치 파일입니다</text>
  <text x="90" y="585" font-family="Segoe UI, sans-serif" font-size="22" fill="#c9c9d2">저장 → 확장자를 .zip으로 변경 (또는 알집/반디집으로 열기) → setup.exe 실행</text>
  <text x="1140" y="650" text-anchor="end" font-family="Segoe UI, sans-serif" font-size="16" fill="#6a6a75">GPL-3.0 · 소스 동봉 · 원작 sunanakgo/NAIS3</text>
</svg>`

await sharp(Buffer.from(svg)).png().toFile(process.argv[2])
console.log('cover written:', process.argv[2])
