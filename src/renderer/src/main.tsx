import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initLiveResync } from './lib/live-resync'

// 파일을 앱 영역(전용 드롭존 밖)에 잘못 떨궈도 창이 file:// 로 튀지 않게 방어.
// 내장 브라우저(webview)로의 드롭은 별도 WebContents라 여기 영향 없고,
// 라이브러리/디렉터의 전용 드롭존은 자체 핸들러에서 먼저 처리하므로 영향 없다.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

// 생성 중 편집을 대기 큐에 자동 반영 (커스텀)
initLiveResync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
