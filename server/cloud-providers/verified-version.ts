/** Both values must be plain stable numeric versions, never ranges or labels. */
export function meetsVerifiedVersion(installed: string, minimum: string | undefined): boolean {
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  if (!minimum || !stable.test(installed) || !stable.test(minimum)) return false
  const actual = installed.split('.').map(BigInt)
  const floor = minimum.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== floor[i]) return actual[i] > floor[i]
  }
  return true
}
