import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PromptEditor } from '../../src/renderer/src/components/prompt-editor'
import { Toaster } from '../../src/renderer/src/components/toaster'
import { TextPromptHost } from '../../src/renderer/src/components/text-prompt-host'
import { tagFixtureInvoke } from './tag-fixture'
import { tokenFixtureInvoke } from './token-fixture'
import type { IpcInvokeMap } from '../../src/shared/types'
import './placement.css'

window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    if (channel.startsWith('tags:'))
      return (await tagFixtureInvoke(channel, req)) as IpcInvokeMap[C]['res']
    if (channel === 'tokens:count' || channel === 'tokens:preview')
      return tokenFixtureInvoke(
        channel,
        req as IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
      ) as IpcInvokeMap[C]['res']
    throw new Error(`Blocked IPC: ${channel}`)
  },
  on: () => () => {},
  pathForFile: () => ''
}
function Harness(): React.JSX.Element {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  return (
    <main className="h-full overflow-auto p-4 text-ink">
      <h1 className="mb-4 text-[15px] font-semibold">태그 추천 입력 검증</h1>
      <div className="max-w-[700px] space-y-4">
        <PromptEditor
          value={a}
          onValueChange={setA}
          placeholder="첫 번째 태그 입력"
          className="h-[132px]"
          tokensOverride={null}
        />
        <PromptEditor
          value={b}
          onValueChange={setB}
          placeholder="두 번째 태그 입력"
          className="h-[132px]"
          tokensOverride={null}
        />
        <button
          className="fixed right-4 top-4 rounded border border-line p-2"
          data-testid="outside"
        >
          다른 곳
        </button>
        <pre data-testid="values">{JSON.stringify({ a, b })}</pre>
      </div>
      <Toaster />
      <TextPromptHost />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
