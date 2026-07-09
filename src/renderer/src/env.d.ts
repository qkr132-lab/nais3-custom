/// <reference types="vite/client" />

// Electron <webview> 태그 (웹 모드 내장 브라우저) — React JSX 타입 등록.
// import가 있어야 모듈 '증강'으로 처리된다 (없으면 react 타입 전체를 덮어써버림).
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
        },
        HTMLElement
      >
    }
  }
}
