/** Persistent, name-keyed visual identity. No tmux ids or external assets. */
export type SessionIdentity = {
  glyph: string
  color: string
  codename: string
  glyphSource: 'auto' | 'user'
}
export type SessionIdentities = Record<string, SessionIdentity>
export const MAX_SESSION_IDENTITIES = 500
export const SESSION_COLORS = ['#b9a3ff', '#73d9e2', '#f3c66b', '#85f4b1', '#ff8d89', '#f0a6d7', '#94baff', '#a8d98b', '#edb18c', '#b3c7e8', '#d6b6f5', '#83d6bf'] as const
export const SESSION_ANIMALS = ['Fox', 'Owl', 'Bear', 'Cat', 'Dog', 'Rabbit', 'Deer', 'Wolf', 'Panda', 'Tiger', 'Raccoon', 'Beaver', 'Hedgehog', 'Dolphin', 'Penguin', 'Puffin', 'Frog', 'Octopus', 'Crab', 'Butterfly'] as const
export const SESSION_ADJECTIVES = ['Amber', 'Arctic', 'Azure', 'Brave', 'Bright', 'Calm', 'Cedar', 'Clever', 'Cloudy', 'Coral', 'Cosmic', 'Cozy', 'Crimson', 'Daring', 'Dawn', 'Dusk', 'Ember', 'Emerald', 'Fern', 'Fleet', 'Frosty', 'Gentle', 'Golden', 'Grand', 'Happy', 'Hidden', 'Indigo', 'Ivory', 'Jade', 'Jolly', 'Kind', 'Lively', 'Lucky', 'Lunar', 'Maple', 'Mellow', 'Merry', 'Misty', 'Mossy', 'Nimble', 'Noble', 'Nova', 'Ocean', 'Olive', 'Opal', 'Peach', 'Quiet', 'Rapid', 'Rosy', 'Royal', 'Ruby', 'Sage', 'Sandy', 'Silver', 'Snowy', 'Solar', 'Starry', 'Steady', 'Sunny', 'Swift', 'Velvet', 'Violet', 'Warm', 'Wild'] as const
const NEUTRAL_GLYPHS = ['🌿', '🌙', '⭐', '🌊', '🍀', '🌻', '🪷', '🪵', '🪨', '🌵', '🍄', '🌲', '🌴', '🍁', '🌸', '🪻', '🌾', '🐚', '🪸', '🫧', '☀️', '❄️', '☁️', '💎']
// Match complete words or explicitly listed stems, in table priority order.
// Specific topics precede broad categories (billing costs, CI failures, admin auth).
const KEYWORDS: readonly [string, string][] = [
  ['💸', 'cost costs expense* spend* budget*'], ['🚨', 'fail failed failing failure failures broken outage* incident*'],
  ['🤖', 'bot bots robot*'], ['🛡️', 'admin* permission* rbac policy policies'], ['✨', 'aura'],
  ['🔀', 'concurrency concurrent parallel* race* deadlock* mutex* semaphore* thread*'],
  ['🥗', 'nutrition* food meal* diet* recipe* calorie* grocery groceries'],
  ['💷', 'subscription* billing stripe payment* invoice* pricing checkout revenue monetiz*'],
  ['🔋', 'battery power energy charge charging'], ['💬', 'chat* conversation* message* inbox slack discord'],
  ['🧹', 'lhn simplify* tidy cleanup clean refactor* reorganiz*'], ['🚦', 'ci pipeline* workflow* actions automation'],
  ['⏱️', 'rate limit* throttle* quota timeout*'], ['🚀', 'deploy* release* ship launch publish* rollout'],
  ['🧪', 'test* e2e qa vitest playwright coverage spec smoke smoketest*'], ['🐛', 'bug* fix* crash* error* debug* issue* regress*'],
  ['🎨', 'design* ui ux style* theme* layout* css visual color* font*'], ['📚', 'doc docs document* readme guide* help tutorial*'],
  ['🛬', 'landing homepage website marketing seo'], ['📱', 'sim simulator* emulator* mobile ios android device*'],
  ['📈', 'perf* cpu memory optimiz* speed latency profil* benchmark*'], ['🔐', 'auth* login logout oauth password* security token*'],
  ['🗄️', 'database* db sql sqlite postgres* mysql redis schema* migration*'], ['🧊', 'cache caching invalidation'],
  ['🌿', 'git commit* branch* merge rebase diff worktree* repository repo pr'], ['🐳', 'docker container* kubernetes k8s terraform'],
  ['📊', 'data analytics posthog metric* tracking report* dashboard* telemetry'], ['📡', 'live realtime websocket* stream* socket* sync'],
  ['🃏', 'deck* card* poker'], ['🚩', 'flag* toggle* experiment*'], ['🔎', 'search find* index* filter*'],
  ['🗂️', 'file* folder* directory storage archive*'], ['🧭', 'nav* sidebar menu routing picker'],
  ['🔔', 'notif* alert* reminder*'], ['🖼️', 'image* photo* avatar* icon* svg canvas'], ['🎬', 'video* record* animation* motion'],
  ['🎵', 'audio sound music voice speech'], ['🛠️', 'build* tooling config* setup install* dependency dependencies'],
  ['🌐', 'network http api proxy browser web'], ['🧠', 'agent* model* ai prompt*'], ['🖥️', 'terminal tmux pane* session* cockpit'],
]
function hash(value: string): number {
  let result = 2166136261
  for (const char of value) { result ^= char.codePointAt(0)!; result = Math.imul(result, 16777619) }
  return result >>> 0
}
export function isSessionName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
}
export function isSessionGlyph(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  if ([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length !== 1) return false
  return /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?)*)$/u.test(value)
}
export function deriveSessionIdentity(name: string, occupied: Iterable<string> = []): SessionIdentity {
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const glyph = KEYWORDS.find(([, keywords]) => keywords.split(' ').some((keyword) => words.some((word) => keyword.endsWith('*') ? word.startsWith(keyword.slice(0, -1)) : word === keyword)))?.[0]
    ?? NEUTRAL_GLYPHS[hash(`glyph:${name}`) % NEUTRAL_GLYPHS.length]!
  const taken = new Set(occupied)
  const combinations = SESSION_ADJECTIVES.length * SESSION_ANIMALS.length
  const start = hash(`codename:${name}`) % combinations
  let codename = ''
  for (let probe = 0; probe < combinations; probe++) {
    const index = (start + probe) % combinations
    codename = `${SESSION_ADJECTIVES[Math.floor(index / SESSION_ANIMALS.length)]} ${SESSION_ANIMALS[index % SESSION_ANIMALS.length]}`
    if (!taken.has(codename)) break
  }
  return { glyph, color: SESSION_COLORS[hash(`color:${name}`) % SESSION_COLORS.length]!, codename, glyphSource: 'auto' }
}
export function sessionIdentityForName(identities: SessionIdentities, name: string): SessionIdentity {
  return Object.hasOwn(identities, name) ? identities[name]! : deriveSessionIdentity(name)
}
export function normalizeSessionIdentities(value: unknown): SessionIdentities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries: [string, SessionIdentity][] = []
  for (const [name, candidate] of Object.entries(value)) {
    if (!isSessionName(name) || !candidate || typeof candidate !== 'object') continue
    const { glyph, color, codename, glyphSource } = candidate as SessionIdentity
    const [adjective, animal, extra] = typeof codename === 'string' ? codename.split(' ') : []
    if (!isSessionGlyph(glyph) || !SESSION_COLORS.some((entry) => entry === color)
      || !SESSION_ADJECTIVES.some((entry) => entry === adjective) || !SESSION_ANIMALS.some((entry) => entry === animal)
      || extra !== undefined || (glyphSource !== 'auto' && glyphSource !== 'user')) continue
    entries.push([name, { glyph, color, codename, glyphSource }])
    if (entries.length === MAX_SESSION_IDENTITIES) break
  }
  return Object.fromEntries(entries)
}
/** Preserve assigned identities; evict older map entries when the bounded map fills. */
export function assignSessionIdentities(existing: SessionIdentities, names: readonly string[]): SessionIdentities {
  const identities = new Map(Object.entries(existing))
  const requested = new Set(names.filter(isSessionName))
  const occupied = new Set([...identities.values()].map((identity) => identity.codename))
  for (const name of [...requested].sort()) {
    if (identities.has(name)) continue
    if (identities.size >= MAX_SESSION_IDENTITIES) {
      const victim = [...identities.keys()].find((key) => !requested.has(key))
      if (victim === undefined) break
      identities.delete(victim)
    }
    const identity = deriveSessionIdentity(name, occupied)
    identities.set(name, identity)
    occupied.add(identity.codename)
  }
  return Object.fromEntries(identities)
}

// Minimal silhouettes, all in a 32×32 viewBox with the same rounded ink language.
const ANIMAL_MARKS: Record<typeof SESSION_ANIMALS[number], string> = {
  Fox: '<path d="M6 6 16 11 26 6 24 22 16 27 8 22Z"/><path d="m8 17 8 7 8-7-4 8h-8Z" fill="#fff"/>',
  Owl: '<path d="m7 6 9 5 9-5v15a9 9 0 0 1-18 0Z"/><circle cx="12" cy="17" r="4" fill="#fff"/><circle cx="20" cy="17" r="4" fill="#fff"/><path d="m14 22 2 3 2-3Z" fill="#fff"/>',
  Bear: '<circle cx="9" cy="9" r="4"/><circle cx="23" cy="9" r="4"/><rect x="6" y="9" width="20" height="18" rx="9"/><ellipse cx="16" cy="22" rx="5" ry="3" fill="#fff"/>',
  Cat: '<path d="M6 6 14 11h4l8-5v14a10 8 0 0 1-20 0Z"/><path d="m9 22-5-1m5 4-4 1m18-4 5-1m-5 4 4 1" fill="none"/>',
  Dog: '<rect x="9" y="8" width="14" height="19" rx="6"/><path d="M10 8Q2 8 5 21l6-6m11-7q8 0 5 13l-6-6Z"/><ellipse cx="16" cy="22" rx="4" ry="3" fill="#fff"/>',
  Rabbit: '<ellipse cx="11" cy="10" rx="4" ry="8"/><ellipse cx="21" cy="10" rx="4" ry="8"/><ellipse cx="16" cy="21" rx="10" ry="8"/>',
  Deer: '<path d="M12 12 7 7V3m0 5L3 6m17 6 5-5V3m0 5 4-2" fill="none"/><path d="m7 13 9 3 9-3-5 12-4 3-4-3Z"/>',
  Wolf: '<path d="m6 4 10 8L26 4l-2 17-8 7-8-7Z"/><path d="m12 20 4 6 4-6-4 2Z" fill="#fff"/>',
  Panda: '<circle cx="8" cy="9" r="4"/><circle cx="24" cy="9" r="4"/><circle cx="16" cy="18" r="11" fill="#fff"/><ellipse cx="11" cy="17" rx="3" ry="4"/><ellipse cx="21" cy="17" rx="3" ry="4"/>',
  Tiger: '<circle cx="8" cy="10" r="3"/><circle cx="24" cy="10" r="3"/><rect x="6" y="9" width="20" height="18" rx="8"/><path d="m12 10 2 5m6-5-2 5M7 19l4 2m14-2-4 2" stroke="#fff"/>',
  Raccoon: '<path d="m7 6 9 5 9-5v14a9 8 0 0 1-18 0Z" fill="#fff"/><path d="m6 15 10 2 10-2-3 7-7-2-7 2Z"/>',
  Beaver: '<ellipse cx="16" cy="18" rx="10" ry="9"/><circle cx="8" cy="10" r="3"/><circle cx="24" cy="10" r="3"/><path d="M12 22h8v6h-8Z" fill="#fff"/><path d="M16 23v5" fill="none"/>',
  Hedgehog: '<path d="m4 22 1-8 4 1 1-7 5 3 4-6 3 6 5-1-1 7 4 4-5 6H10Z"/><path d="m16 19 11 2-4 6h-9Z" fill="#fff"/>',
  Dolphin: '<path d="M3 21Q13 6 20 11l3-5 1 9 6 4-8 2-4 6-2-6q-8 5-13 0Z"/>',
  Penguin: '<ellipse cx="16" cy="17" rx="9" ry="13"/><ellipse cx="16" cy="21" rx="6" ry="8" fill="#fff"/><path d="m13 15 3 3 3-3Z" fill="#fff"/>',
  Puffin: '<path d="M8 27V14Q8 3 18 5q7 2 4 12l-1 10Z"/><ellipse cx="17" cy="13" rx="5" ry="6" fill="#fff"/><path d="m21 12 8 5-8 2Z"/>',
  Frog: '<circle cx="9" cy="10" r="5"/><circle cx="23" cy="10" r="5"/><ellipse cx="16" cy="20" rx="12" ry="9"/><path d="M10 22q6 5 12 0" fill="none" stroke="#fff"/>',
  Octopus: '<path d="M8 18V12a8 8 0 0 1 16 0v6q7 8 4 9-4 1-7-5 3 8-1 7l-4-6-4 6q-4 1-1-7-3 6-7 5-3-1 4-9Z"/>',
  Crab: '<ellipse cx="16" cy="19" rx="8" ry="6"/><path d="m9 15-5-5V5m0 5 5-4m14 9 5-5V5m0 5-5-4M8 21l-5 4m8-1-3 5m16-8 5 4m-8-1 3 5" fill="none" stroke-width="3"/>',
  Butterfly: '<path d="M16 15C4-4-4 21 12 19-1 24 16 34 16 20c0 14 17 4 4-1 16 2 8-23-4-4Z"/><path d="M16 24V12l-4-6m4 6 4-6" fill="none"/>',
}
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
}
/** Pure inline SVG; optional id lets React instances isolate their gradient references. */
export function sessionAvatarSvg(identity: SessionIdentity, size = 18, gradientId?: string): string {
  const color = SESSION_COLORS.find((entry) => entry === identity.color) ?? SESSION_COLORS[0]
  const animal = identity.codename.split(' ').at(-1)
  const mark = Object.hasOwn(ANIMAL_MARKS, animal ?? '') ? ANIMAL_MARKS[animal as typeof SESSION_ANIMALS[number]] : undefined
  const id = escapeXml(gradientId ?? `session-${hash(`${color}:${identity.codename}`)}`)
  const dimension = Number.isFinite(size) ? Math.max(1, Math.min(size, 512)) : 18
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="${id}" x2="1" y2="1"><stop stop-color="${color}" stop-opacity=".8"/><stop offset="1" stop-color="${color}" stop-opacity=".28"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#${id})"/>${mark ? `<g fill="#20182f" stroke="#20182f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${mark}<circle cx="12" cy="17" r="1" fill="${color}" stroke="none"/><circle cx="20" cy="17" r="1" fill="${color}" stroke="none"/></g>` : `<text x="16" y="22" text-anchor="middle" font-size="20">${escapeXml(identity.glyph)}</text>`}</svg>`
}
