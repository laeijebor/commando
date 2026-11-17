import { EMPTY_HOST_STATE } from './state'
import { forgetSessionCreation, whenSessionCreated } from './sessionCreations'
import { useDaemonStore } from './store'

const created = { kind: 'session' as const, sessionId: '$1', sessionName: 'big', windowId: '@1', windowIndex: 0, windowName: 'agent', paneId: '%7', paneIndex: 0, panePath: '/tmp' }
const creation = { id: 'c1', name: 'big', cwd: '/repo', startedAt: 1 }

function report(stage: 'checking-out' | 'failed' | 'done', hostId = 'h1') {
  useDaemonStore.getState().ingest(hostId, { type: 'session_creations', creations: [{ ...creation, stage, ...(stage === 'done' ? { result: { created } } : {}) }] })
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => useDaemonStore.setState({ byHost: { h1: EMPTY_HOST_STATE, h2: EMPTY_HOST_STATE } }))

it('finishes once the daemon reports the creation done, through a failure and retry, and only once', async () => {
  const finish = jest.fn()
  whenSessionCreated('h1', 'c1', finish)
  report('checking-out')
  report('failed')
  report('done', 'h2')
  await flush()
  expect(finish).not.toHaveBeenCalled()
  report('done')
  report('done')
  await flush()
  expect(finish).toHaveBeenCalledTimes(1)
  expect(finish).toHaveBeenCalledWith({ created })
})

it('finishes straight away for a creation already done, and not at all for a dismissed one', async () => {
  report('done')
  const done = jest.fn()
  whenSessionCreated('h1', 'c1', done)
  const dismissed = jest.fn()
  whenSessionCreated('h2', 'c1', dismissed)
  forgetSessionCreation('h2', 'c1')
  report('done', 'h2')
  await flush()
  expect(done).toHaveBeenCalledTimes(1)
  expect(dismissed).not.toHaveBeenCalled()
})

it('stops waiting for a creation that was listed and then vanished, as after a daemon restart', async () => {
  const finish = jest.fn()
  whenSessionCreated('h1', 'c1', finish)
  report('checking-out')
  useDaemonStore.getState().ingest('h1', { type: 'session_creations', creations: [] })
  report('done')
  await flush()
  expect(finish).not.toHaveBeenCalled()
})
