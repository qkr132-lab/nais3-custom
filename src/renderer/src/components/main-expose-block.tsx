import { useEffect, useState } from 'react'
import type { ExposeNote } from '@shared/types'
import { useExposeWorn } from '../lib/use-expose-worn'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { useOutfitsStore } from '../stores/outfits-store'
import { ExposeBlock } from './expose-notes'

/**
 * 메인 탭의 「자동 젖힘」 — 메인 프롬프트로 생성할 때도 입은 옷 자동 젖힘이 태그를 붙이므로
 * 붙은 태그와 안 붙은 이유를 같은 접이식 블록으로 보인다 (몰래 붙이기 금지).
 * 실제 생성과 같은 조립(buildMainRequest)을 읽기 전용으로 다시 돌려 메모를 얻는다 — 저장·큐에는 아무것도 하지 않는다.
 */
export function MainExposeBlock(): React.JSX.Element | null {
  const [exposeWorn] = useExposeWorn()
  const prompt = useGenerationStore((s) => s.request.prompt)
  const parts = useGenerationStore((s) => s.request.promptParts)
  const split = useGenerationStore((s) => s.promptSplitEnabled)
  const cards = useCharactersStore((s) => s.items)
  const outfits = useOutfitsStore((s) => s.items)
  const acts = useOutfitsStore((s) => s.acts)
  const stripOnNude = useOutfitsStore((s) => s.stripOnNude)
  const [notes, setNotes] = useState<ExposeNote[] | null>(null)
  const active = cards.some((c) => c.enabled && c.prompt.trim())
  const show = exposeWorn && active

  useEffect(() => {
    if (!show) return
    let alive = true
    // 입력할 때마다 다시 조립하지 않게 잠깐 모았다가 한 번에
    const timer = setTimeout(() => {
      useGenerationStore
        .getState()
        .buildMainRequest({ ignoreSource: true })
        .then((r) => {
          if (alive) setNotes(r.exposeNotes ?? [])
        })
        .catch(() => {
          if (alive) setNotes(null)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [show, prompt, parts, split, cards, outfits, acts, stripOnNude])

  if (!show || !notes?.length) return null
  return (
    <div data-testid="main-expose">
      <ExposeBlock rounds={[{ label: '', notes }]} enabled />
    </div>
  )
}
