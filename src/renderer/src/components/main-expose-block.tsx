import { useEffect, useState } from 'react'
import type { BodyNote, ExposeNote } from '@shared/types'
import { useExposeWorn } from '../lib/use-expose-worn'
import { useFutaReassembly, useFutaViewFix } from '../lib/use-futa-settings'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { useOutfitsStore } from '../stores/outfits-store'
import { futaCardsOff } from '../lib/body-notes'
import { BodyBlock } from './body-notes'
import { ExposeBlock } from './expose-notes'

/**
 * 메인 탭의 「자동 젖힘」·「몸·후타」 — 메인 프롬프트로 생성할 때도 입은 옷 자동 젖힘이 태그를 붙이고
 * 후타 재조립이 글을 바꾸므로, 붙은 태그·바꾼 글과 안 붙은·안 바꾼 이유를 같은 접이식 블록으로 보인다 (몰래 붙이기 금지).
 * 실제 생성과 같은 조립(buildMainRequest)을 읽기 전용으로 다시 돌려 메모를 얻는다 — 저장·큐에는 아무것도 하지 않는다.
 */
export function MainExposeBlock(): React.JSX.Element | null {
  const [exposeWorn] = useExposeWorn()
  const [futaReassembly] = useFutaReassembly()
  const [futaViewFix] = useFutaViewFix()
  const prompt = useGenerationStore((s) => s.request.prompt)
  const parts = useGenerationStore((s) => s.request.promptParts)
  const split = useGenerationStore((s) => s.promptSplitEnabled)
  const cards = useCharactersStore((s) => s.items)
  const outfits = useOutfitsStore((s) => s.items)
  const acts = useOutfitsStore((s) => s.acts)
  const stripOnNude = useOutfitsStore((s) => s.stripOnNude)
  const [notes, setNotes] = useState<ExposeNote[] | null>(null)
  const [bodyNotes, setBodyNotes] = useState<BodyNote[] | null>(null)
  const [futaDrawn, setFutaDrawn] = useState<number | undefined>()
  const [futaOff, setFutaOff] = useState<number | undefined>()
  const active = cards.some((c) => c.enabled && c.prompt.trim())
  // 젖힘이 꺼져 있어도 몸·후타 메모는 따로 나온다 (알몸에 붙는 pink nipples 는 설정이 없다)
  const show = active

  useEffect(() => {
    if (!show) return
    let alive = true
    // 입력할 때마다 다시 조립하지 않게 잠깐 모았다가 한 번에
    const timer = setTimeout(() => {
      useGenerationStore
        .getState()
        .buildMainRequest({ ignoreSource: true })
        .then((r) => {
          if (!alive) return
          setNotes(r.exposeNotes ?? [])
          setBodyNotes(r.bodyNotes ?? [])
          setFutaDrawn(r.futaPlan?.counts.futa)
          setFutaOff(futaReassembly ? undefined : futaCardsOff(r.characterPrompts))
        })
        .catch(() => {
          if (!alive) return
          setNotes(null)
          setBodyNotes(null)
          setFutaDrawn(undefined)
          setFutaOff(undefined)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [
    show,
    prompt,
    parts,
    split,
    cards,
    outfits,
    acts,
    stripOnNude,
    exposeWorn,
    futaReassembly,
    futaViewFix
  ])

  const exposeShown = exposeWorn && !!notes?.length
  // 후타가 그려지면 바꾼 게 없어도 「후타 1명 · 바꾼 것 없음」 한 줄은 보인다
  const bodyShown = !!bodyNotes?.length || (futaDrawn ?? 0) > 0 || (futaOff ?? 0) > 0
  if (!show || (!exposeShown && !bodyShown)) return null
  return (
    <div data-testid="main-expose" className="flex flex-col gap-1.5">
      {exposeShown && <ExposeBlock rounds={[{ label: '', notes: notes ?? [] }]} enabled />}
      {bodyShown && (
        <div data-testid="main-body">
          <BodyBlock
            rounds={[{ label: '', notes: bodyNotes ?? [], futa: futaDrawn, futaOff }]}
            scope="main"
          />
        </div>
      )}
    </div>
  )
}
