// Synthetic local-only contention fixture. Each worker owns its own SQLite connection.
import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { tsImport } from 'tsx/esm/api'

const { CloudTaskStore } = await tsImport('../cloud-task-store.ts', import.meta.url)
parentPort.once('message', () => {
  let store
  try {
    store = new CloudTaskStore(workerData.path)
    const action = store.prepare(workerData.task, workerData.operation)
    const claimed = store.claimOperation(action.operation.id, randomUUID())
    parentPort.postMessage({
      installationId: store.installationId,
      taskId: action.task.id,
      operationId: action.operation.id,
      reused: action.reused,
      claimed,
    })
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, status: error.status, code: error.code } })
  } finally {
    store?.close()
  }
})
parentPort.postMessage('ready')
