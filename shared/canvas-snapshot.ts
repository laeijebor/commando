/** A sent review round; timestamps are epoch milliseconds, as in canvas threads. */
export type CanvasSnapshot = { id: string; createdAt: number; comments: number; partial: boolean; manifestTitle: string }
