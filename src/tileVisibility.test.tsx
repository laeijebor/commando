// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TileVisibilityContext, createTileVisibility, useReportTileVisible } from './tileVisibility'

afterEach(cleanup)

function Tile({ id, visible }: { id: string; visible: boolean }) {
  useReportTileVisible(id, visible)
  return null
}

describe('tile visibility', () => {
  it('reports tiles while any render of them is visible', () => {
    const onChange = vi.fn()
    const registry = createTileVisibility(onChange)
    const view = (a: boolean, b: boolean, c: boolean) => <TileVisibilityContext.Provider value={registry}>
      <Tile id="w-1" visible={a} /><Tile id="w-1" visible={b} /><Tile id="w-2" visible={c} />
    </TileVisibilityContext.Provider>
    const { rerender, unmount } = render(view(true, true, false))
    expect(onChange).toHaveBeenLastCalledWith(['w-1'])
    rerender(view(false, true, true))
    expect(onChange).toHaveBeenLastCalledWith(['w-1', 'w-2'])
    rerender(view(false, false, true))
    expect(onChange).toHaveBeenLastCalledWith(['w-2'])
    unmount()
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('reports nothing outside a provider', () => {
    expect(() => render(<Tile id="w-1" visible />)).not.toThrow()
  })
})
