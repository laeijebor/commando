import { selectedTabOffset } from './tabScroll'
it('reveals a trailing tab with an inset and leaves a fully visible tab alone', () => {
  expect(selectedTabOffset({ x: 350, width: 120 }, 390, 850, 0)).toBe(92)
  expect(selectedTabOffset({ x: 350, width: 120 }, 390, 850, 92)).toBe(92)
})
it('reveals the leading edge when selecting a tab behind the current viewport', () => {
  expect(selectedTabOffset({ x: 100, width: 100 }, 390, 850, 400)).toBe(88)
})
it('clamps to content bounds and aligns oversized tabs at their leading edge', () => {
  expect(selectedTabOffset({ x: 0, width: 80 }, 390, 850, 200)).toBe(0)
  expect(selectedTabOffset({ x: 730, width: 120 }, 390, 850, 0)).toBe(460)
  expect(selectedTabOffset({ x: 200, width: 500 }, 390, 1000, 0)).toBe(188)
  expect(selectedTabOffset({ x: 200, width: 100 }, 0, 0, 42)).toBe(42)
})
