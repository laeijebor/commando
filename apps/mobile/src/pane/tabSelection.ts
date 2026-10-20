const selections = new Map<string, string>()
export function selectedPaneTab(key: string): string { return selections.get(key) ?? 'body' }
export function rememberPaneTab(key: string, tab: string): void {
  selections.delete(key); selections.set(key, tab)
  while (selections.size > 100) selections.delete(selections.keys().next().value!)
}
