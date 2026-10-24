import { githubMarkdown } from './markdown'

it('drops hidden comments, including Commando PR markers', () => {
  expect(githubMarkdown('<!-- commando:v1 target=%1 relation=created -->\n## Summary\n\nText<!-- bot\nstate -->')).toBe('## Summary\n\nText')
})

it('turns uploaded images, links and folds into Markdown', () => {
  const body = 'Look:\n<img width="400" alt="Phone [view]" src="https://github.com/user-attachments/assets/1" />\n<a href="https://example.com">the <b>docs</b></a>\n<details><summary>More <code>info</code></summary>\n\nHidden</details>'
  expect(githubMarkdown(body)).toBe('Look:\n\n![Phone view](https://github.com/user-attachments/assets/1)\n\n[the docs](https://example.com)\n\n**More info**\n\nHidden')
})

it('keeps inline text together and leaves fenced code untouched', () => {
  expect(githubMarkdown('| Status |\n| --- |\n| Done <relative-time datetime="x">today</relative-time> |')).toBe('| Status |\n| --- |\n| Done today |')
  const body = 'Press <kbd>Enter</kbd><br>then wait\n\n```html\n<!-- keep -->\n<details>raw</details>\n\n\n```\nafter'
  expect(githubMarkdown(body)).toBe('Press Enter\nthen wait\n\n```html\n<!-- keep -->\n<details>raw</details>\n\n\n```\nafter')
})

it('leaves tags inside inline code alone', () => {
  expect(githubMarkdown('Replace the `<br>` and `<details>` tags; keep ``<!-- marker -->`` and <b>x</b>')).toBe('Replace the `<br>` and `<details>` tags; keep ``<!-- marker -->`` and **x**')
})

it('keeps a table row on one line when a cell has a line break', () => {
  expect(githubMarkdown('| File | Change |\n| --- | --- |\n| a.ts | one<br>two |')).toBe('| File | Change |\n| --- | --- |\n| a.ts | one · two |')
})
