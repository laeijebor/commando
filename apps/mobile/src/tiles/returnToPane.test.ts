import { returnFromTile, tileReturnTarget } from './returnToPane'
it.each(['%14', undefined])('pops a pushed tile back to its mounted origin (%s) without replacing it', (paneId) => {
  const router = { canGoBack: () => true, back: jest.fn(), replace: jest.fn() }
  returnFromTile(router, 'h1', paneId)
  expect(router.back).toHaveBeenCalledTimes(1)
  expect(router.replace).not.toHaveBeenCalled()
})
it.each(['%14', undefined])('uses an explicit target only when entered without history (%s)', (paneId) => {
  const router = { canGoBack: () => false, back: jest.fn(), replace: jest.fn() }
  returnFromTile(router, 'h1', paneId)
  expect(router.back).not.toHaveBeenCalled()
  expect(router.replace).toHaveBeenCalledWith(tileReturnTarget('h1', paneId))
})
it('does not accumulate duplicate origins on repeated tile visits', () => {
  const origin = { screen: 'pane', selectedTab: 'demo-browser' }
  const stack: unknown[] = ['Chats', origin]
  const router = { canGoBack: () => stack.length > 1, back: () => { stack.pop() }, replace: jest.fn() }
  for (let visit = 0; visit < 4; visit++) {
    stack.push('tile')
    returnFromTile(router, 'h1', '%14')
    expect(stack).toEqual(['Chats', origin])
    expect(stack.at(-1)).toBe(origin)
  }
  expect(router.replace).not.toHaveBeenCalled()
})
