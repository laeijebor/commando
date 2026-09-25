// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'redline-sdk.js'), 'utf8')
type QueueCall = { question: string; answer: string; note?: string; queueKey?: string; data?: unknown }

// jsdom 27 lacks CSS.escape, which the SDK uses for ID-based queue selectors.
// All IDs in these fixtures are plain CSS identifiers.
if (typeof (globalThis as any).CSS?.escape !== 'function') {
  ;(globalThis as any).CSS = { escape: (value: string) => value }
}

function loadSdk(): QueueCall[] {
  const calls: QueueCall[] = []
  ;(window as any).__commandoRedlineQueue = (payload: string) => {
    const parsed = JSON.parse(payload)
    if (parsed.type !== 'questions') calls.push(parsed)
  }
  // eslint-disable-next-line no-eval -- exercise the served SDK in a browser-like DOM
  window.eval(source)
  return calls
}

function publishSnapshot(controls: unknown[]): void {
  const snapshot = { version: 1, controls }
  ;(window as any).__commandoRedlinePendingSnapshot = snapshot
  window.dispatchEvent(new CustomEvent('commando:redline-pending', { detail: snapshot }))
}

beforeEach(() => {
  document.body.replaceChildren()
  document.head.querySelectorAll('style[data-redline-styles]').forEach((style) => style.remove())
  delete (window as any).__commandoRedlineQueue
  delete (window as any).__commandoRedlinePendingSnapshot
  delete (window as any).__commandoRedlineQuestionSnapshot
  delete (window as any).redline
  publishSnapshot([])
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('plan presentation components', () => {
  it('renders all authored plan content in place, preserving nested IDs and labels', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-before-after title="Migration">
        <section id="prior" data-before><strong>Old path</strong></section>
        <section id="future" data-after data-label="Target"><em>New path</em></section>
      </redline-before-after>
      <redline-tradeoffs title="Choices">
        <article id="option-a" data-option="A" data-recommended><p>Fast rollout</p></article>
        <article id="option-b" data-option="B"><p>Lower cost</p></article>
      </redline-tradeoffs>
      <redline-milestones title="Delivery"><article id="milestone" data-milestone="Phase 1" data-depends-on="Schema" data-status="open"><p>Ship UI</p></article></redline-milestones>
      <redline-evidence title="Proof"><article id="evidence" data-evidence="Trace" data-status="verified"><p>Captured request</p></article></redline-evidence>
      <redline-scenario title="Journey"><article id="step" data-step="Sign in"><p>Use keyboard</p></article></redline-scenario>
      <redline-risk title="Risks"><article id="risk" data-risk="Outage" data-likelihood="low" data-impact="high"><p>Keep fallback</p></article></redline-risk>`

    for (const [tag, id, content] of [
      ['redline-before-after', 'prior', 'Old path'],
      ['redline-before-after', 'future', 'New path'],
      ['redline-tradeoffs', 'option-a', 'Fast rollout'],
      ['redline-tradeoffs', 'option-b', 'Lower cost'],
      ['redline-milestones', 'milestone', 'Ship UI'],
      ['redline-evidence', 'evidence', 'Captured request'],
      ['redline-scenario', 'step', 'Use keyboard'],
      ['redline-risk', 'risk', 'Keep fallback'],
    ]) {
      expect(document.querySelector(`${tag} #${id}`)?.textContent).toContain(content)
    }
    expect(document.querySelector('#future')?.textContent).toContain('Target')
    expect(document.querySelector('#option-a')?.textContent).toContain('Recommended')
    expect(document.querySelector('#milestone')?.textContent).toContain('open')
    expect(document.querySelector('#milestone')?.textContent).toContain('After: Schema')
    expect(document.querySelector('#evidence')?.textContent).toContain('verified')
    expect(document.querySelector('#risk')?.textContent).toContain('likelihood: low')
    expect(document.querySelector('#risk')?.textContent).toContain('impact: high')
    expect(document.querySelector('redline-before-after .redline-plan-pair')?.contains(document.getElementById('prior'))).toBe(true)
    expect(document.querySelector('redline-tradeoffs .redline-plan-pair')?.contains(document.getElementById('option-b'))).toBe(true)
  })

  it('summarizes file changes and provenance, keeps directory links/IDs, and opens a diff anchor', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-file-tree title="Implementation">
        <ul>
          <li data-dir="src" data-collapsed><a id="directory-link" href="#src">Source</a>
            <ul>
              <li id="new-file" data-path="src/new.ts" data-status="add" data-diff="#new-diff"><span id="filename">new.ts</span></li>
              <li data-path="src/old.ts" data-status="modify" data-actual>old.ts</li>
              <li data-path="src/removed.ts" data-status="delete">removed.ts</li>
              <li data-path="src/stable.ts">stable.ts</li>
              <li data-path="src/later.ts" data-status="proposed">later.ts</li>
            </ul>
          </li>
        </ul>
      </redline-file-tree><div id="new-diff">Diff destination</div>`
    const tree = document.querySelector('redline-file-tree') as HTMLElement
    expect(tree.querySelector('.redline-file-summary')?.textContent).toBe(
      '1 add · 1 modify · 1 delete · 1 existing · 1 proposed · 2 actual · 3 proposed',
    )
    expect(tree.querySelector('#new-file .redline-plan-status')?.textContent).toBe('add · proposed')
    expect(tree.querySelector('[data-path="src/old.ts"] .redline-plan-status')?.textContent).toBe('modify · actual')
    expect(tree.querySelector('[data-path="src/stable.ts"] .redline-plan-status')?.textContent).toBe('existing · actual')
    const details = tree.querySelector('li[data-dir] > details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary #directory-link')?.getAttribute('href')).toBe('#src')
    details.open = true
    expect(details.querySelector('#filename')?.textContent).toBe('new.ts')
    expect(tree.querySelector('#new-file a[aria-label="View diff for src/new.ts"]')?.getAttribute('href')).toBe('#new-diff')
    expect(document.getElementById('new-diff')?.textContent).toBe('Diff destination')
  })

  it('switches a code diff between unified and paired views without interpreting source as HTML', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-code-diff id="change-diff" heading="Change" file="src/change.ts" range="7–8">
        <pre id="authored-source" data-diff-source>@@ -7,2 +7,2 @@
-const label = '&lt;img src=x onerror=alert(1)&gt;'
+const label = '&lt;safe&gt;'
 keep()</pre>
        <p id="diff-caption">Review this change</p>
      </redline-code-diff>`
    const host = document.querySelector('redline-code-diff') as HTMLElement
    const [unified, side] = [...host.querySelectorAll<HTMLButtonElement>('.redline-diff-controls button')]
    const views = [...host.querySelectorAll<HTMLElement>('.redline-diff-view')]
    expect(host.querySelector('#diff-caption')?.textContent).toBe('Review this change')
    expect(host.querySelector('.redline-diff-meta')?.textContent).toBe('src/change.ts · 7–8 · Proposed · not applied')
    expect(host.querySelector('#change-diff-hunk-1')).not.toBeNull()
    expect((host.querySelector('#authored-source') as HTMLElement).hidden).toBe(true)
    expect(unified.getAttribute('aria-pressed')).toBe('true')
    expect(views[0].hidden).toBe(false)
    expect(views[0].querySelector('[data-kind="delete"] .redline-diff-code')?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(views[0].querySelector('[data-kind="add"] .redline-diff-code')?.textContent).toContain('<safe>')
    expect(host.querySelector('img')).toBeNull()
    expect(views[0].querySelector('[data-kind="delete"] .redline-diff-line-no')?.textContent).toBe('7')
    expect(views[0].querySelector('[data-kind="add"] .redline-diff-line-no')?.textContent).toBe('7')

    side.click()
    expect(side.getAttribute('aria-pressed')).toBe('true')
    expect(unified.getAttribute('aria-pressed')).toBe('false')
    expect(views[0].hidden).toBe(true)
    expect(views[1].hidden).toBe(false)
    expect(host.querySelector('#change-diff-hunk-1-old')).not.toBeNull()
    const changed = [...views[1].querySelectorAll('.redline-diff-side')].find((row) => row.textContent?.includes('<img')) as HTMLElement
    expect([...changed.querySelectorAll('.redline-diff-code')].map((node) => node.textContent)).toEqual([
      "-const label = '<img src=x onerror=alert(1)>'",
      "+const label = '<safe>'",
    ])
    unified.click()
    expect(views[0].hidden).toBe(false)
  })

  it('folds long unchanged runs without losing lines when expanded', () => {
    loadSdk()
    const host = document.createElement('redline-code-diff')
    const sourceNode = document.createElement('pre')
    sourceNode.dataset.diffSource = ''
    sourceNode.textContent = ['@@ -1,12 +1,12 @@', ...Array.from({ length: 12 }, (_, i) => ` line ${i + 1}`), '-old', '+new'].join('\n')
    host.append(sourceNode)
    document.body.append(host)
    for (const view of host.querySelectorAll('.redline-diff-view')) {
      const fold = view.querySelector('details.redline-diff-fold') as HTMLDetailsElement
      expect(fold.open).toBe(false)
      expect(fold.querySelector('summary')?.textContent).toBe('Show 8 unchanged lines')
      fold.open = true
      expect(fold.textContent).toContain('line 6')
      expect(view.textContent).toContain('line 12')
      expect(view.textContent).toContain('new')
    }
  })

  it('accepts authored numbered lines and honors the requested side-by-side default', () => {
    loadSdk()
    document.body.innerHTML = `
      <redline-code-diff view="side-by-side">
        <div id="removed-line" data-line="42" data-kind="delete">old()</div>
        <div id="added-line" data-line="42" data-kind="add">new()</div>
      </redline-code-diff>`
    const host = document.querySelector('redline-code-diff') as HTMLElement
    const views = [...host.querySelectorAll<HTMLElement>('.redline-diff-view')]
    expect(views[0].hidden).toBe(true)
    expect(views[1].hidden).toBe(false)
    expect(host.querySelectorAll('#removed-line, #added-line')).toHaveLength(2)
    expect((host.querySelector('#removed-line') as HTMLElement).hidden).toBe(true)
    const pair = views[1].querySelector('.redline-diff-side') as HTMLElement
    expect([...pair.querySelectorAll('.redline-diff-code')].map((node) => node.textContent)).toEqual(['-old()', '+new()'])
    expect([...pair.querySelectorAll('.redline-diff-line-no')].map((node) => node.textContent)).toEqual(['42', '42'])
  })
})

describe('plan decisions and scope', () => {
  it('queues a structured keyed decision only on explicit confirmation', () => {
    const calls = loadSdk()
    document.body.innerHTML = `
      <redline-decision id="decision" key="approach" prompt="Which approach?" recommended="Cache reads" alternative="Rebuild index">
        <p id="decision-reason">Latency favors cached reads.</p>
      </redline-decision>`
    const host = document.getElementById('decision') as HTMLElement
    expect(host.querySelector('#decision-reason')?.textContent).toContain('Latency')
    const choice = host.querySelector('input[value="alternative"]') as HTMLInputElement
    const button = host.querySelector('button.redline-queue') as HTMLButtonElement
    expect(choice.closest('label')?.textContent).toContain('Rebuild index')
    expect(button.disabled).toBe(true)
    choice.click()
    const note = host.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement
    note.value = 'Needs cheaper operations'
    note.dispatchEvent(new Event('input', { bubbles: true }))
    expect(calls).toHaveLength(0)
    button.click()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      question: 'Which approach?', answer: 'alternative', note: 'Needs cheaper operations', queueKey: 'approach',
      data: { choice: 'alternative', recommended: 'Cache reads', alternative: 'Rebuild index' },
    })
  })

  it('toggles optional scope visibility without enqueueing until the scope button is pressed', () => {
    const calls = loadSdk()
    document.body.innerHTML = `
      <redline-scope key="delivery" prompt="What ships?">
        <section id="api" data-scope-id="api" data-optional data-label="API"><strong>API work</strong></section>
        <section id="docs" data-scope-id="docs" data-optional data-default="off"><strong>Documentation</strong></section>
      </redline-scope>`
    const host = document.querySelector('redline-scope') as HTMLElement
    const [api, docs] = [...host.querySelectorAll<HTMLInputElement>('.redline-scope-control input')]
    expect(api.getAttribute('aria-controls')).toBe('api')
    expect(docs.getAttribute('aria-controls')).toBe('docs')
    expect(api.checked).toBe(true)
    expect(docs.checked).toBe(false)
    expect((document.getElementById('api') as HTMLElement).hidden).toBe(false)
    expect((document.getElementById('docs') as HTMLElement).hidden).toBe(true)
    api.click()
    docs.click()
    expect((document.getElementById('api') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('docs') as HTMLElement).hidden).toBe(false)
    expect(host.querySelector('#docs strong')?.textContent).toBe('Documentation')
    expect(calls).toHaveLength(0)
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      question: 'What ships?', queueKey: 'delivery', answer: 'Include: docs; exclude: api',
      data: { included: ['docs'], excluded: ['api'], choice: ['docs'], multiple: true },
    })
  })

  it('restores queued decision and scope selections and marks local edits without sending them', () => {
    const controls = [
      { queueKey: 'approach', response: { question: 'Which approach?', answer: 'investigate', note: 'Measure first' } },
      { queueKey: 'delivery', response: { question: 'What ships?', answer: 'Include: docs; exclude: api', data: { included: ['docs'], excluded: ['api'] } } },
    ]
    publishSnapshot(controls)
    const calls = loadSdk()
    document.body.innerHTML = `
      <redline-decision key="approach" prompt="Which approach?"></redline-decision>
      <redline-scope key="delivery" prompt="What ships?">
        <section id="api" data-scope-id="api" data-optional>API</section>
        <section id="docs" data-scope-id="docs" data-optional data-default="off">Docs</section>
      </redline-scope>`
    const decision = document.querySelector('redline-decision') as HTMLElement
    const scope = document.querySelector('redline-scope') as HTMLElement
    expect((decision.querySelector('input[value="investigate"]') as HTMLInputElement).checked).toBe(true)
    expect((decision.querySelector('textarea[data-redline-note]') as HTMLTextAreaElement).value).toBe('Measure first')
    expect(decision.querySelector('button.redline-queue')?.textContent).toBe('Queued ✓')
    expect((scope.querySelector('input[aria-controls="api"]') as HTMLInputElement).checked).toBe(false)
    expect((scope.querySelector('input[aria-controls="docs"]') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('api') as HTMLElement).hidden).toBe(true)
    expect((document.getElementById('docs') as HTMLElement).hidden).toBe(false)
    expect(scope.querySelector('button.redline-queue')?.textContent).toBe('Queued ✓')
    ;(decision.querySelector('input[value="recommended"]') as HTMLInputElement).click()
    ;(scope.querySelector('input[aria-controls="api"]') as HTMLInputElement).click()
    expect(decision.querySelector('button.redline-queue')?.textContent).toBe('Update queued answer')
    expect(scope.querySelector('button.redline-queue')?.textContent).toBe('Update queued answer')
    expect(calls).toHaveLength(0)
    publishSnapshot(controls)
    expect((decision.querySelector('input[value="recommended"]') as HTMLInputElement).checked).toBe(true)
    expect((scope.querySelector('input[aria-controls="api"]') as HTMLInputElement).checked).toBe(true)
  })

  it('does not duplicate rendered controls or listeners after reconnecting', () => {
    const calls = loadSdk()
    const host = document.createElement('redline-scope')
    host.setAttribute('key', 'delivery')
    host.setAttribute('prompt', 'What ships?')
    host.innerHTML = '<section id="api" data-scope-id="api" data-optional>API</section>'
    document.body.append(host)
    host.remove()
    document.body.append(host)
    expect(host.querySelectorAll('.redline-scope-control input')).toHaveLength(1)
    expect(host.querySelectorAll('button.redline-queue')).toHaveLength(1)
    ;(host.querySelector('button.redline-queue') as HTMLButtonElement).click()
    expect(calls).toHaveLength(1)
  })
})
