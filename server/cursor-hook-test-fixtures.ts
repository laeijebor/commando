import type { CursorHookAssociation } from './cursor-hook-ownership.js'

export const association: CursorHookAssociation = {
  version: 1, socketPath: '/fixture/cursor.sock', socketDevice: '1', socketInode: '2',
  serverPid: 90, serverStarted: 'Tue Oct 6 12:00:00 2026',
  panePid: 100, paneStarted: 'Tue Oct 6 12:00:01 2026',
  producerPid: 100, producerStarted: 'Tue Oct 6 12:00:01 2026',
  hookPid: 110, hookStarted: 'Tue Oct 6 12:00:02 2026',
}
