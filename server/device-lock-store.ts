import type { BusyCheck, DeviceHolder, DeviceLockSnapshot, DeviceResource, LockOwner, LockResult, QueueEntry, SweepContext, SweepEvents } from './device-locks.js'

type Awaitable<T> = T | Promise<T>

/**
 * What the device-lock API, the Devices view and the alerts need from a lock queue. Commando's own
 * DeviceLockRegistry fills it synchronously; the device-farm store reads a mirror of the farm synchronously and
 * makes changes over HTTP, so changes are awaited.
 */
export interface DeviceLockStore {
  snapshot(): DeviceLockSnapshot
  onChange(listener: () => void): () => void
  onOffered(listener: (entries: QueueEntry[]) => void): () => void
  resource(id: string): DeviceResource | undefined
  entry(id: string): QueueEntry | undefined
  holdersOf(resourceId: string): DeviceHolder[]
  position(entry: QueueEntry): number
  offerMessage(entryId: string, offerAt: number, messageId: string): boolean
  offerDelivered(target: { entryId: string } | { messageId: string }, at?: number): void
  alertSent(key: string): boolean
  recordAlert(key: string, ref: string): void

  addResource(input: Record<string, unknown>, busy?: BusyCheck): Awaitable<DeviceResource>
  removeResource(id: string): Awaitable<void>
  lock(input: Record<string, unknown>, busy?: BusyCheck): Awaitable<LockResult>
  claim(owner: LockOwner | Record<string, unknown>, resourceId?: string): Awaitable<LockResult>
  release(owner: LockOwner | Record<string, unknown>, resourceId?: string, busy?: BusyCheck): Awaitable<DeviceHolder[]>
  cancel(owner: LockOwner | Record<string, unknown>, request?: string, busy?: BusyCheck): Awaitable<QueueEntry[]>
  withdraw(paneId: string, entryId: string, busy?: BusyCheck): Awaitable<'cancelled' | 'released' | 'gone'>
  sweep(context: SweepContext): Awaitable<SweepEvents>
  reorder(entryId: string, before?: string): Awaitable<void>
  setPaused(resourceId: string, paused: boolean, busy?: BusyCheck): Awaitable<QueueEntry[]>
  forceRelease(resourceId: string, busy?: BusyCheck): Awaitable<DeviceHolder[]>
  remove(entryId: string, busy?: BusyCheck): Awaitable<QueueEntry>

  /** Why a device is held back by something outside the queue (a build running for `heavy`), when the store knows. */
  waitingFor?(resource: DeviceResource, requesters: QueueEntry[]): string | undefined
}

/**
 * Hands every call to the current store and lets Commando move to another one while running (the settings page's
 * switch to the device farm). Listeners stay registered across the move and hear a change when it happens.
 */
export class SwitchableLockStore implements DeviceLockStore {
  private current: DeviceLockStore
  private readonly changeListeners = new Set<() => void>()
  private readonly offerListeners = new Set<(entries: QueueEntry[]) => void>()
  private unsubscribe: Array<() => void> = []

  constructor(initial: DeviceLockStore) {
    this.current = initial
    this.subscribe()
  }

  get store(): DeviceLockStore { return this.current }

  switchTo(next: DeviceLockStore): void {
    for (const stop of this.unsubscribe) stop()
    this.current = next
    this.subscribe()
    for (const listener of this.changeListeners) listener()
  }

  private subscribe(): void {
    this.unsubscribe = [
      this.current.onChange(() => { for (const listener of this.changeListeners) listener() }),
      this.current.onOffered((entries) => { for (const listener of this.offerListeners) listener(entries) }),
    ]
  }

  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener) }
  onOffered(listener: (entries: QueueEntry[]) => void): () => void { this.offerListeners.add(listener); return () => this.offerListeners.delete(listener) }
  snapshot() { return this.current.snapshot() }
  resource(id: string) { return this.current.resource(id) }
  entry(id: string) { return this.current.entry(id) }
  holdersOf(resourceId: string) { return this.current.holdersOf(resourceId) }
  position(entry: QueueEntry) { return this.current.position(entry) }
  offerMessage(entryId: string, offerAt: number, messageId: string) { return this.current.offerMessage(entryId, offerAt, messageId) }
  offerDelivered(target: { entryId: string } | { messageId: string }, at?: number) { this.current.offerDelivered(target, at) }
  alertSent(key: string) { return this.current.alertSent(key) }
  recordAlert(key: string, ref: string) { this.current.recordAlert(key, ref) }
  addResource(input: Record<string, unknown>, busy?: BusyCheck) { return this.current.addResource(input, busy) }
  removeResource(id: string) { return this.current.removeResource(id) }
  lock(input: Record<string, unknown>, busy?: BusyCheck) { return this.current.lock(input, busy) }
  claim(owner: LockOwner | Record<string, unknown>, resourceId?: string) { return this.current.claim(owner, resourceId) }
  release(owner: LockOwner | Record<string, unknown>, resourceId?: string, busy?: BusyCheck) { return this.current.release(owner, resourceId, busy) }
  cancel(owner: LockOwner | Record<string, unknown>, request?: string, busy?: BusyCheck) { return this.current.cancel(owner, request, busy) }
  withdraw(paneId: string, entryId: string, busy?: BusyCheck) { return this.current.withdraw(paneId, entryId, busy) }
  sweep(context: SweepContext) { return this.current.sweep(context) }
  reorder(entryId: string, before?: string) { return this.current.reorder(entryId, before) }
  setPaused(resourceId: string, paused: boolean, busy?: BusyCheck) { return this.current.setPaused(resourceId, paused, busy) }
  forceRelease(resourceId: string, busy?: BusyCheck) { return this.current.forceRelease(resourceId, busy) }
  remove(entryId: string, busy?: BusyCheck) { return this.current.remove(entryId, busy) }
  waitingFor(resource: DeviceResource, requesters: QueueEntry[]) { return this.current.waitingFor?.(resource, requesters) }
}
