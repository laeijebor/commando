export type SimElement = {
  role: string | null
  label: string | null
  identifier: string | null
  value: string | number | boolean | null
  title: string | null
  frame: { x: number; y: number; width: number; height: number }
}
export type SimComponent = { name: string; file?: string; line?: number; column?: number; code?: string }
export type SimInspectResult = { ok: true; element: SimElement | null }
export type SimSourceResult = { ok: true; components: SimComponent[]; raw?: string } | {
  ok: false; reason: 'no-metro-port' | 'argent-missing' | 'not-connected' | 'failed'; message?: string; port?: number
}
