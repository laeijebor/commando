export const HOST_TAB_NAMES = ['sessions', 'activity', 'tiles', 'settings'] as const
export function isHostTab(name: string): boolean {
  return (HOST_TAB_NAMES as readonly string[]).includes(name)
}
/** Feed only visible routes to the tab bar, including its accessibility count. */
export function visibleHostTabs<T extends { index: number; routes: { name: string }[]; routeNames: string[] }>(state: T): T {
  const active = state.routes[state.index]?.name
  const routes = state.routes.filter((route) => isHostTab(route.name))
  return { ...state, routes, routeNames: routes.map((route) => route.name), index: Math.max(0, routes.findIndex((route) => route.name === active)) }
}
