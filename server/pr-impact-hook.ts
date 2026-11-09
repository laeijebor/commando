/** A PR the agent touched, as far as the hook can tell from the command alone. */
export type PrImpactHookReport = {
  relation: 'pushed' | 'reviewed' | 'commented'
  /** Where the command ran, after any `cd` or `git -C` in it. */
  cwd?: string
  repo?: string
  number?: number
  /** The PR's head branch, when the command named it. */
  branch?: string
  /** The git remote pushed to, when the command named it. */
  remote?: string
}

/**
 * Reads, from a PostToolUse hook payload, the PRs the agent just pushed to,
 * reviewed or commented on: `git push`, `gh pr comment|review|edit|merge|close|ready`
 * and the GitHub MCP equivalents. It only parses the command, so the daemon
 * resolves branches and repos to PRs. Words that come from variables or
 * command substitution are not guessed at, and echoed text and heredocs never
 * count. The hook bridge embeds this with `toString()`, so it must stay
 * self-contained: no imports and no outside references.
 */
export function pullRequestImpactsFor(value: unknown): PrImpactHookReport[] | undefined {
  type Word = { text: string; dynamic: boolean }
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  if (input.hook_event_name !== 'PostToolUse') return undefined
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  const args = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>
  const startCwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') && input.cwd.length <= 4096 && !input.cwd.includes('\0')
    ? input.cwd : undefined
  const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
  const BRANCH = /^(?![-/.])(?!.*\.\.)[A-Za-z0-9._/+-]{1,200}$/
  const REMOTE = /^(?!-)[A-Za-z0-9._-]{1,100}$/
  const impacts: PrImpactHookReport[] = []
  const add = (impact: PrImpactHookReport) => {
    const key = JSON.stringify(impact)
    if (impacts.length < 10 && !impacts.some((known) => JSON.stringify(known) === key)) impacts.push(impact)
  }
  const repoFromRemote = (text: string): string | undefined => {
    const match = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(text)
    return match ? match[1] : undefined
  }

  // GitHub MCP tools name the repo and PR outright.
  const mcp = /^mcp__.+__([a-z_]+)$/.exec(tool)?.[1]
  if (mcp) {
    const relation = [
      'create_pull_request_review', 'create_and_submit_pull_request_review', 'create_pending_pull_request_review',
      'submit_pending_pull_request_review', 'pull_request_review_write', 'add_comment_to_pending_review',
      'add_pull_request_review_comment', 'add_pull_request_review_comment_to_pending_review',
    ].includes(mcp) ? 'reviewed'
      : ['add_issue_comment', 'add_reply_to_pull_request_comment', 'merge_pull_request', 'update_pull_request', 'update_pull_request_branch'].includes(mcp) ? 'commented'
        : ['push_files', 'create_or_update_file', 'delete_file'].includes(mcp) ? 'pushed' : undefined
    const repo = typeof args.owner === 'string' && typeof args.repo === 'string' ? `${args.owner}/${args.repo}` : ''
    if (!relation || !REPO.test(repo)) return undefined
    if (relation === 'pushed') {
      if (typeof args.branch === 'string' && BRANCH.test(args.branch)) add({ relation, repo, branch: args.branch })
    } else {
      const raw = args.pullNumber ?? args.pull_number ?? args.issue_number ?? args.issueNumber ?? args.number
      const number = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : raw
      if (typeof number === 'number' && Number.isInteger(number) && number > 0 && number < 2 ** 31) add({ relation, repo, number })
    }
    return impacts.length ? impacts : undefined
  }

  if (tool !== 'Bash' || typeof args.command !== 'string' || args.command.length > 20_000) return undefined
  const text = args.command
  if (!/\b(?:git|gh)\b/.test(text)) return undefined

  // A small shell tokenizer: splits on ; & | ( ) and newlines, drops redirect
  // targets, comments and heredoc bodies, and marks words built from $ or `.
  const readDelimiter = (start: number): [string, number] => {
    let index = start
    if (text[index] === '-') index += 1
    while (text[index] === ' ' || text[index] === '\t') index += 1
    let delimiter = ''
    while (index < text.length && !/[\s;&|<>()]/.test(text[index])) {
      if (!`'"\\`.includes(text[index])) delimiter += text[index]
      index += 1
    }
    return [delimiter, index]
  }
  const skipHeredocs = (start: number, pending: string[]): number => {
    let index = start
    while (pending.length) {
      const delimiter = pending.shift()
      while (index < text.length) {
        const end = text.indexOf('\n', index)
        const line = text.slice(index, end === -1 ? text.length : end)
        index = end === -1 ? text.length : end + 1
        if (line.replace(/^\t+/, '') === delimiter) break
      }
    }
    return index
  }
  // From `$(` to its closing `)`, past quotes and heredocs inside it.
  const skipSubstitution = (start: number): number => {
    const pending: string[] = []
    let depth = 0
    let index = start + 1
    while (index < text.length) {
      const character = text[index]
      if (character === '\n' && pending.length) { index = skipHeredocs(index + 1, pending); continue }
      if (character === '\\') { index += 2; continue }
      if (character === "'" || character === '"') {
        let end = index + 1
        while (end < text.length && text[end] !== character) end += character === '"' && text[end] === '\\' ? 2 : 1
        index = end + 1
        continue
      }
      if (character === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
        const [delimiter, next] = readDelimiter(index + 2)
        if (delimiter) pending.push(delimiter)
        index = next
        continue
      }
      if (character === '(') depth += 1
      else if (character === ')' && --depth === 0) return index + 1
      index += 1
    }
    return text.length
  }

  const segments: Word[][] = []
  let words: Word[] = []
  let word = ''
  let inWord = false
  let dynamic = false
  let redirect = false
  const heredocs: string[] = []
  const endWord = () => {
    if (inWord) {
      if (redirect) redirect = false
      else words.push({ text: word, dynamic })
    }
    word = ''
    inWord = false
    dynamic = false
  }
  const endSegment = () => {
    endWord()
    redirect = false
    if (words.length) segments.push(words)
    words = []
  }
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === '\n') {
      endSegment()
      index = skipHeredocs(index + 1, heredocs)
    } else if (character === ' ' || character === '\t' || character === '\r') {
      endWord()
      index += 1
    } else if (';&|()'.includes(character)) {
      endSegment()
      index += 1
    } else if (character === '#' && !inWord) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (character === '<' || character === '>') {
      // `2>` names a file descriptor, not a word.
      if (inWord && !dynamic && /^\d+$/.test(word)) { word = ''; inWord = false } else endWord()
      if (character === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
        const [delimiter, next] = readDelimiter(index + 2)
        if (delimiter) heredocs.push(delimiter)
        index = next
        continue
      }
      index += 1
      while (index < text.length && '<>&|'.includes(text[index])) index += 1
      redirect = true
    } else if (character === "'") {
      const end = text.indexOf("'", index + 1)
      word += text.slice(index + 1, end === -1 ? text.length : end)
      inWord = true
      index = end === -1 ? text.length : end + 1
    } else if (character === '"') {
      inWord = true
      index += 1
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) { word += text[index + 1]; index += 2; continue }
        if (text[index] === '$' && text[index + 1] === '(') { dynamic = true; index = skipSubstitution(index + 1); continue }
        if (text[index] === '$' || text[index] === '`') dynamic = true
        word += text[index]
        index += 1
      }
      index += 1
    } else if (character === '\\') {
      if (text[index + 1] !== '\n') { word += text[index + 1] ?? ''; inWord = true }
      index += 2
    } else if (character === '$' || character === '`') {
      dynamic = true
      inWord = true
      if (character === '`') {
        const end = text.indexOf('`', index + 1)
        index = end === -1 ? text.length : end + 1
      } else if (text[index + 1] === '(') {
        index = skipSubstitution(index + 1)
      } else {
        word += character
        index += 1
      }
    } else {
      word += character
      inWord = true
      index += 1
    }
  }
  endSegment()

  const within = (base: string | undefined, path: Word | undefined): string | undefined => {
    if (!path || path.dynamic || !path.text || path.text.startsWith('~') || path.text === '-') return undefined
    if (path.text.startsWith('/')) return path.text
    return base ? `${base.replace(/\/+$/, '')}/${path.text}` : undefined
  }
  let cwd = startCwd
  for (const segment of segments) {
    let start = 0
    while (start < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[start].text)
      || ['command', 'exec', 'time', 'nohup', 'env'].includes(segment[start].text))) start += 1
    const command = segment[start]
    if (!command || command.dynamic) continue
    const name = command.text.split('/').pop()
    const rest = segment.slice(start + 1)
    if (name === 'cd' || name === 'pushd') {
      cwd = within(cwd, rest[0])
      continue
    }
    if (name === 'git') {
      let here = cwd
      let at = 0
      while (at < rest.length && rest[at].text.startsWith('-')) {
        const option = rest[at].text
        if (option === '-C') here = within(here, rest[at + 1])
        at += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(option) ? 2 : 1
      }
      if (rest[at]?.text !== 'push' || rest[at].dynamic) continue
      const positionals: Word[] = []
      let remoteOption: Word | undefined
      let bulk = false
      let skip = false
      for (let position = at + 1; position < rest.length; position += 1) {
        const argument = rest[position]
        if (argument.text === '--') { positionals.push(...rest.slice(position + 1)); break }
        if (['-d', '--delete', '--mirror', '-n', '--dry-run'].includes(argument.text)) { skip = true; break }
        if (['--all', '--branches', '--tags'].includes(argument.text)) bulk = true
        else if (argument.text === '--repo') remoteOption = rest[++position]
        else if (argument.text.startsWith('--repo=')) remoteOption = { text: argument.text.slice(7), dynamic: argument.dynamic }
        else if (['-o', '--push-option', '--receive-pack', '--exec'].includes(argument.text)) position += 1
        else if (!argument.text.startsWith('-') || argument.dynamic) positionals.push(argument)
      }
      const remote = positionals[0] ?? remoteOption
      const refspecs = positionals.slice(1)
      if (skip || (bulk && !refspecs.length) || remote?.dynamic) continue
      const target: PrImpactHookReport = { relation: 'pushed', ...(here ? { cwd: here } : {}) }
      if (remote) {
        const repo = repoFromRemote(remote.text)
        if (repo) target.repo = repo
        else if (REMOTE.test(remote.text)) target.remote = remote.text
        else continue
      }
      if (!refspecs.length) add(target)
      for (const refspec of refspecs.slice(0, 5)) {
        if (refspec.dynamic) continue
        const spec = refspec.text.replace(/^\+/, '')
        const colon = spec.indexOf(':')
        // `:branch` deletes it.
        if (colon === 0) continue
        let branch = colon === -1 ? spec : spec.slice(colon + 1) || spec.slice(0, colon)
        branch = branch.replace(/^refs\/heads\//, '')
        if (branch === 'HEAD') add(target)
        else if (!branch.startsWith('refs/') && BRANCH.test(branch)) add({ ...target, branch })
      }
      continue
    }
    if (name === 'gh' && rest[0]?.text === 'pr' && !rest[1]?.dynamic) {
      const verb = rest[1]?.text ?? ''
      const values: Record<string, string[]> = {
        comment: ['-b', '--body', '-F', '--body-file'],
        review: ['-b', '--body', '-F', '--body-file'],
        edit: ['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-m', '--milestone',
          '--add-reviewer', '--remove-reviewer', '--add-label', '--remove-label', '--add-assignee',
          '--remove-assignee', '--add-project', '--remove-project'],
        merge: ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'],
        close: ['-c', '--comment'],
        ready: [],
      }
      if (!Object.hasOwn(values, verb)) continue
      let selector: Word | undefined
      let repoOption: Word | undefined
      for (let position = 2; position < rest.length; position += 1) {
        const argument = rest[position]
        if (argument.text === '-R' || argument.text === '--repo') repoOption = rest[++position] ?? { text: '', dynamic: true }
        else if (argument.text.startsWith('--repo=')) repoOption = { text: argument.text.slice(7), dynamic: argument.dynamic }
        else if (values[verb].includes(argument.text)) position += 1
        else if (!argument.text.startsWith('-') && !selector) selector = argument
      }
      if (selector?.dynamic || repoOption?.dynamic) continue
      const impact: PrImpactHookReport = { relation: verb === 'review' ? 'reviewed' : 'commented', ...(cwd ? { cwd } : {}) }
      if (repoOption) {
        const repo = repoOption.text.replace(/^https:\/\//, '').replace(/^github\.com\//, '').replace(/\/+$/, '')
        if (!REPO.test(repo)) continue
        impact.repo = repo
      }
      const url = selector && /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(selector.text)
      const number = selector && /^#?(\d{1,9})$/.exec(selector.text)
      if (url) add({ ...impact, repo: url[1], number: Number(url[2]) })
      else if (number) add({ ...impact, number: Number(number[1]) })
      else if (selector) {
        // `owner:branch` names a fork's branch.
        const branch = selector.text.slice(selector.text.indexOf(':') + 1)
        if (BRANCH.test(branch)) add({ ...impact, branch })
      } else add(impact)
    }
  }
  return impacts.length ? impacts : undefined
}
