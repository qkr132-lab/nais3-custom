import { normalizeBackground, type SceneBackground } from '@shared/background-tags'

export interface BackgroundLibraryItem {
  id: string
  name: string
  thumbnail: string
  background: SceneBackground
}

export async function loadBackgroundLibrary(): Promise<{
  presetId: number
  items: BackgroundLibraryItem[]
}> {
  const { items: presets } = await window.nais.invoke('scenePresets:list', { kind: 'background' })
  const groups = await Promise.all(
    presets.map((p) => window.nais.invoke('scenes:list', { presetId: p.id }))
  )
  return {
    presetId: presets[0]?.id ?? 0,
    items: groups.flatMap(({ items }) =>
      items.map((s) => ({
        id: String(s.id),
        name: s.name,
        thumbnail: s.thumbnail,
        background: { ...normalizeBackground(s.background), prompt: s.prompt }
      }))
    )
  }
}
