import { isHostTab, visibleHostTabs } from './hostTabs'
it('excludes detail routes from the accessible tab count and preserves the selected visible route', () => {
  const names = ['sessions', 'new-session', 'activity', 'pane/[paneId]', 'tiles', 'tile/[tileId]', 'settings', 'index']
  const state = visibleHostTabs({ index: 4, routeNames: names, routes: names.map((name) => ({ name, key: name })) })
  expect(state.routes.map((route) => route.name)).toEqual(['sessions', 'activity', 'tiles', 'settings'])
  expect(state.routeNames).toHaveLength(4)
  expect(state.index).toBe(2)
  expect(isHostTab('pane/[paneId]')).toBe(false)
})
