import { createContext, useContext, useEffect } from 'react'

/** Collects the tiles rendered visibly in this window; App reports them to the daemon. */
export type TileVisibility = { show(tileId: string): () => void }

export const TileVisibilityContext = createContext<TileVisibility | null>(null)

/** Counts the tile as on screen while `visible`; a tile outside a provider reports nothing. */
export function useReportTileVisible(tileId: string, visible: boolean): void {
  const registry = useContext(TileVisibilityContext)
  useEffect(() => visible && registry ? registry.show(tileId) : undefined, [registry, tileId, visible])
}

/**
 * A registry that tells `onChange` the tiles shown now. Several renders of one tile (a side
 * panel and the Commander peek) are counted, so it stays shown until the last one hides.
 */
export function createTileVisibility(onChange: (tileIds: string[]) => void): TileVisibility {
  const counts = new Map<string, number>()
  const report = () => onChange([...counts.keys()])
  return {
    show(tileId) {
      counts.set(tileId, (counts.get(tileId) ?? 0) + 1)
      if (counts.get(tileId) === 1) report()
      let shown = true
      return () => {
        if (!shown) return
        shown = false
        const left = (counts.get(tileId) ?? 1) - 1
        if (left > 0) counts.set(tileId, left)
        else {
          counts.delete(tileId)
          report()
        }
      }
    },
  }
}
