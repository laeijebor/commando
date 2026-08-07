# Playbook: diagram

Use for flows, architecture, state machines, sequences — anything with nodes
and edges. Never hand-build boxes with divs/flexbox and connector lines; that
always drifts out of alignment. Use Mermaid.

## Load Mermaid from the daemon

```html
<script type="module">
  import mermaid from "http://127.0.0.1:4310/redline/design/mermaid/mermaid.esm.min.mjs"
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  mermaid.run({ querySelector: '.mermaid' })
</script>
```

(substitute `$COMMANDO_PORT` if set). ESM module import, no CDN, no build step.
`startOnLoad:false` gives you control over when it renders; `securityLevel:
'strict'` is required since the artifact may render untrusted-ish content.

## Markup

```html
<pre class="mermaid">
flowchart TD
  A[Client] --> B[Daemon]
  B --> C[Artifact registry]
</pre>
```

Every diagram section still gets a stable wrapping `id` for annotation, same
as any other section — Mermaid renders inside it, the `id` stays on the
outer element.

## Choosing a diagram type

- **flowchart** — structure, architecture, decision trees.
- **sequenceDiagram** — interactions between actors/services over time.
- **stateDiagram-v2** — lifecycles, state transitions.

## Theming

Match the page: if the artifact uses a dark theme, initialize Mermaid with
`theme: 'dark'` (or `'base'` + matching `themeVariables`) so the diagram
doesn't render as a light box on a dark page.

## Labels

Keep node labels to a few words — a node is a label, not a paragraph. Put the
explanation in prose next to the diagram, and reference node names from that
prose so the reader can cross-map ("the **daemon** validates the token before
touching the **registry**"). A diagram the reader has to squint at to read
full sentences inside boxes has failed its job.
