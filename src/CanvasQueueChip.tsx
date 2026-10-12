export function CanvasQueueChip({ count, busy, onSend }: { count: number; busy: boolean; onSend: () => void }) {
  return count > 0 && <span className="canvas-queue"><span>{count} queued ·</span><button type="button" disabled={busy} onClick={onSend}>Send</button></span>
}
