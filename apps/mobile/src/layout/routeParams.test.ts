import { readRouteParams, routeParams } from './routeParams'

it('carries tmux pane ids through expo-router\'s extra decode', () => {
  const sent = routeParams({ hostId: 'host-1', paneId: '%139', focus: '%122' })
  // expo-router decodes every param once more on the way out.
  const received = Object.fromEntries(Object.entries(sent).map(([key, value]) => [key, decodeURIComponent(value)]))
  expect(readRouteParams(received)).toEqual({ hostId: 'host-1', paneId: '%139', focus: '%122' })
})

it('leaves missing params out and reads the first of repeated ones', () => {
  expect(routeParams({ hostId: 'h', fromPaneId: undefined })).toEqual({ hostId: 'h', fromPaneId: undefined })
  expect(readRouteParams({ paneId: ['~7', '~8'], other: undefined })).toEqual({ paneId: '%7' })
})
