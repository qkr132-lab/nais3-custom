/**
 * 시트·보기 화면 같은 겹침 화면이 열려 있는 동안 브라우저 「뒤로」가 앱을 떠나지 않고 그 화면만 닫게 한다.
 * 열 때 history 항목을 하나 쌓고, 뒤로 가기가 오면 가장 위 겹침 화면의 닫기를 부른다.
 * 코드로 닫을 때는 쌓아 둔 항목을 되돌리되, 그때 오는 popstate 는 무시한다.
 */

interface Entry {
  close: () => void
}

const stack: Entry[] = []
let ignorePops = 0
let listening = false

function onPop(): void {
  if (ignorePops > 0) {
    ignorePops--
    return
  }
  const top = stack.pop()
  top?.close()
}

/** 겹침 화면을 등록하고, 닫을 때 부를 해제 함수를 돌려준다 */
export function registerOverlay(close: () => void): () => void {
  if (!listening) {
    listening = true
    window.addEventListener('popstate', onPop)
  }
  try {
    history.pushState({ nais3Overlay: true }, '')
  } catch {
    /* history 를 못 쓰면 뒤로 가기 연동만 포기 */
  }
  const entry: Entry = { close }
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i < 0) return // 뒤로 가기로 이미 닫힘
    stack.splice(i, 1)
    ignorePops++
    try {
      history.back()
    } catch {
      ignorePops--
    }
  }
}
