const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const MAX_MESSAGES_PER_BATCH = 100
const REQUEST_TIMEOUT_MS = 5_000

type Fetch = typeof fetch

export type ExpoPushCategory = 'needs_input' | 'permission' | 'done' | 'failed' | 'test'

export type ExpoPushMessage = {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  categoryId: ExpoPushCategory
  channelId?: string
}

export type ExpoPushOutcome = {
  accepted: number
  rejected: number
  /** Expo tokens the service reported as no longer registered. */
  unregisteredTokens: string[]
}

export type ExpoPushSenderOptions = {
  fetch?: Fetch
  accessToken?: string
  /** Invoked once per token Expo reports as DeviceNotRegistered. */
  onDeviceNotRegistered?: (expoPushToken: string) => void | Promise<void>
  logger?: Pick<Console, 'warn'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function chunkPushMessages(
  messages: readonly ExpoPushMessage[],
  size = MAX_MESSAGES_PER_BATCH,
): ExpoPushMessage[][] {
  const batches: ExpoPushMessage[][] = []
  for (let index = 0; index < messages.length; index += size) {
    batches.push(messages.slice(index, index + size))
  }
  return batches
}

function serializeMessage(message: ExpoPushMessage): Record<string, unknown> {
  return {
    to: message.to,
    title: message.title,
    body: message.body,
    data: message.data,
    categoryId: message.categoryId,
    sound: 'default',
    priority: 'high',
    ...(message.channelId ? { channelId: message.channelId } : {}),
  }
}

type Ticket = { status: 'ok' | 'error'; error?: string; message?: string }

function parseTickets(value: unknown): Ticket[] | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null
  return value.data.map((entry) => {
    if (!isRecord(entry) || entry.status !== 'error') return { status: 'ok' as const }
    const details = isRecord(entry.details) ? entry.details : {}
    return {
      status: 'error' as const,
      ...(typeof details.error === 'string' ? { error: details.error } : {}),
      ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
    }
  })
}

/**
 * Posts notifications to Expo's push service. Failures are logged and swallowed:
 * a notification that cannot be delivered must never take the daemon down.
 */
export class ExpoPushSender {
  private readonly fetch: Fetch
  private readonly accessToken: string | undefined
  private readonly logger: Pick<Console, 'warn'>

  constructor(private readonly options: ExpoPushSenderOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.accessToken = options.accessToken ?? process.env.EXPO_ACCESS_TOKEN ?? undefined
    this.logger = options.logger ?? console
  }

  async send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushOutcome> {
    const outcome: ExpoPushOutcome = { accepted: 0, rejected: 0, unregisteredTokens: [] }
    for (const batch of chunkPushMessages(messages)) {
      await this.sendBatch(batch, outcome)
    }
    for (const token of outcome.unregisteredTokens) {
      try {
        await this.options.onDeviceNotRegistered?.(token)
      } catch (error) {
        this.logger.warn('[commando] failed to drop an unregistered push device', error)
      }
    }
    return outcome
  }

  private async sendBatch(batch: ExpoPushMessage[], outcome: ExpoPushOutcome): Promise<void> {
    let tickets: Ticket[] | null = null
    try {
      const response = await this.fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(batch.map(serializeMessage)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        outcome.rejected += batch.length
        this.logger.warn(`[commando] Expo push request failed with ${response.status}`)
        return
      }
      tickets = parseTickets(await response.json())
    } catch (error) {
      outcome.rejected += batch.length
      this.logger.warn('[commando] Expo push request failed', error)
      return
    }
    if (!tickets) {
      outcome.rejected += batch.length
      this.logger.warn('[commando] Expo push response was not understood')
      return
    }
    batch.forEach((message, index) => {
      const ticket = tickets?.[index]
      if (!ticket || ticket.status === 'ok') {
        outcome.accepted += 1
        return
      }
      outcome.rejected += 1
      this.logger.warn(
        `[commando] Expo push rejected a notification: ${ticket.error ?? ticket.message ?? 'unknown error'}`,
      )
      if (ticket.error === 'DeviceNotRegistered' && !outcome.unregisteredTokens.includes(message.to)) {
        outcome.unregisteredTokens.push(message.to)
      }
    })
  }
}
