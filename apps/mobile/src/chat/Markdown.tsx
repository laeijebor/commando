import { memo, useMemo, type ReactNode } from 'react'
import { Linking, Platform, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { Lexer, type Token, type Tokens } from 'marked'

import type { ChatReplyImage } from '@commando/agent-chat'
import { useTheme, type Theme } from '../theme'
import { ReplyImage, ReplyImagesContext } from './ReplyImage'

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

/**
 * Claude's Markdown, drawn with native views: `marked` lexes it (GFM, as the
 * web's remark-gfm does) and each token maps onto `Text` and `View`. Code
 * blocks and tables scroll sideways instead of wrapping, so a long line keeps
 * its shape on a phone.
 */
export const Markdown = memo(function Markdown({ text, tone = 'body', images, baseUrl, running }: {
  text: string
  tone?: 'body' | 'thought'
  /** A reply's stored local images, the daemon they load from, and whether the reply still streams. */
  images?: readonly ChatReplyImage[] | undefined
  baseUrl?: string | undefined
  running?: boolean | undefined
}) {
  const theme = useTheme()
  const tokens = useMemo(() => lex(text), [text])
  const reply = useMemo(() => ({ images, baseUrl, running }), [images, baseUrl, running])
  const base: TextStyle = tone === 'thought'
    ? { color: theme.muted, fontStyle: 'italic', fontSize: 14, lineHeight: 20 }
    : { color: theme.textSoft, fontSize: 15, lineHeight: 21 }
  return <ReplyImagesContext value={reply}><View style={styles.root}>{blocks(tokens, theme, base, 'md')}</View></ReplyImagesContext>
})

function lex(text: string): Token[] {
  try {
    return new Lexer({ gfm: true }).lex(text)
  } catch {
    // marked doesn't throw on Markdown it can't read, but a half-streamed reply must never take the view down.
    return [{ type: 'paragraph', raw: text, text, tokens: [{ type: 'text', raw: text, text }] } as Tokens.Paragraph]
  }
}

function blocks(tokens: readonly Token[], theme: Theme, base: TextStyle, key: string, completed = false): ReactNode[] {
  return tokens.flatMap((token, index) => {
    const node = block(token, theme, base, `${key}.${index}`, completed)
    return node === null ? [] : [node]
  })
}

function block(token: Token, theme: Theme, base: TextStyle, key: string, completed: boolean): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null
    case 'paragraph':
    case 'text': {
      const item = token as Tokens.Paragraph | Tokens.Text
      if (item.tokens?.some((part) => part.type === 'image')) return <View key={key} style={styles.withImages}>{withImages(item.tokens, theme, base, key, completed)}</View>
      return <Text key={key} selectable style={base}>{item.tokens ? inline(item.tokens, theme, key, completed) : item.text}</Text>
    }
    case 'heading': {
      const heading = token as Tokens.Heading
      return (
        <Text key={key} selectable style={[base, styles.heading, { color: completed ? theme.muted : theme.text, fontSize: heading.depth <= 2 ? 17 : 15.5 }]}>
          {inline(heading.tokens, theme, key, completed)}
        </Text>
      )
    }
    case 'code':
      return <CodeBlock key={key} code={(token as Tokens.Code).text} lang={(token as Tokens.Code).lang} />
    case 'blockquote':
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: theme.borderStrong }]}>
          {blocks((token as Tokens.Blockquote).tokens, theme, { ...base, color: theme.muted }, key, completed)}
        </View>
      )
    case 'list': {
      const list = token as Tokens.List
      const start = typeof list.start === 'number' ? list.start : 1
      return (
        <View key={key} style={styles.list}>
          {list.items.map((item, index) => (
            <View key={`${key}.${index}`} style={styles.listItem}>
              <Text style={[base, styles.marker, { color: item.task && item.checked ? theme.green : theme.muted }]}>
                {item.task ? (item.checked ? '✓' : '☐') : list.ordered ? `${start + index}.` : '•'}
              </Text>
              <View style={styles.listBody}>{blocks(item.tokens, theme, item.task && item.checked ? { ...base, color: theme.muted } : base, `${key}.${index}`, completed || Boolean(item.task && item.checked))}</View>
            </View>
          ))}
        </View>
      )
    }
    case 'hr':
      return <View key={key} style={[styles.rule, { backgroundColor: theme.border }]} />
    case 'table':
      return <Table key={key} table={token as Tokens.Table} base={base} />
    case 'html':
      return <Text key={key} selectable style={[base, { color: theme.muted }]}>{(token as Tokens.HTML).text.trim()}</Text>
    default:
      return 'text' in token && typeof token.text === 'string' ? <Text key={key} selectable style={base}>{token.text}</Text> : null
  }
}

/** A paragraph holding images: its text in runs, each image on its own line at the reply's width (a native image can't sit in text). */
function withImages(tokens: readonly Token[], theme: Theme, base: TextStyle, key: string, completed: boolean): ReactNode[] {
  const nodes: ReactNode[] = []
  let run: Token[] = []
  const flush = () => {
    // The line breaks around an image end with it: trim them from the run's edges.
    while (run.length && isBreak(run[0]!)) run.shift()
    while (run.length && isBreak(run.at(-1)!)) run.pop()
    if (run.length) {
      const last = run.length - 1
      run = run.map((part, index) => {
        if (part.type !== 'text' || part.tokens) return part
        let text = (part as Tokens.Text).text
        if (index === 0) text = text.trimStart()
        if (index === last) text = text.trimEnd()
        return { ...part, text }
      })
      nodes.push(<Text key={`${key}.t${nodes.length}`} selectable style={base}>{inline(run, theme, `${key}.t${nodes.length}`, completed)}</Text>)
    }
    run = []
  }
  for (const part of tokens) {
    if (part.type !== 'image') {
      run.push(part)
      continue
    }
    flush()
    const image = part as Tokens.Image
    nodes.push(<ReplyImage key={`${key}.i${nodes.length}`} src={image.href} alt={image.text} />)
  }
  flush()
  return nodes
}

function isBreak(token: Token): boolean {
  return token.type === 'br' || (token.type === 'text' && !(token as Tokens.Text).tokens && !(token as Tokens.Text).text.trim())
}

function inline(tokens: readonly Token[], theme: Theme, key: string, completed = false): ReactNode[] {
  return tokens.map((token, index) => {
    const id = `${key}.${index}`
    switch (token.type) {
      case 'strong':
        return <Text key={id} style={[styles.strong, { color: completed ? theme.muted : theme.text }]}>{inline((token as Tokens.Strong).tokens, theme, id, completed)}</Text>
      case 'em':
        return <Text key={id} style={styles.em}>{inline((token as Tokens.Em).tokens, theme, id, completed)}</Text>
      case 'del':
        return <Text key={id} style={completed ? undefined : styles.del}>{inline((token as Tokens.Del).tokens, theme, id, completed)}</Text>
      case 'codespan':
        return <Text key={id} style={[styles.codespan, { color: completed ? theme.muted : theme.text, backgroundColor: theme.surfaceSoft }]}>{decode((token as Tokens.Codespan).text)}</Text>
      case 'link': {
        const link = token as Tokens.Link
        return (
          <Text key={id} style={{ color: completed ? theme.muted : theme.accent }} onPress={() => { void Linking.openURL(link.href).catch(() => undefined) }}>
            {inline(link.tokens, theme, id, completed)}
          </Text>
        )
      }
      case 'image':
        // An image inside a link or table cell can't leave the text; its alt text stands in.
        return (token as Tokens.Image).text ? <Text key={id} style={{ color: theme.muted }}>{(token as Tokens.Image).text}</Text> : null
      case 'br':
        return '\n'
      case 'text': {
        const text = token as Tokens.Text
        return text.tokens ? <Text key={id}>{inline(text.tokens, theme, id, completed)}</Text> : decode(text.text)
      }
      case 'escape':
        return decode((token as Tokens.Escape).text)
      default:
        return 'text' in token && typeof token.text === 'string' ? decode(token.text) : null
    }
  })
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** marked escapes `&<>"'` in inline text for HTML; native text wants them back. */
function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
}

/** A fenced block: one unwrapped line per source line, scrolled sideways. */
export function CodeBlock({ code, lang }: { code: string; lang?: string | undefined }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.code, { backgroundColor: theme.terminalBg, borderColor: theme.border }]}>
      {lang ? <Text style={[styles.codeLang, { color: theme.textDim }]}>{lang}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={styles.codeContent}
        testID="chat-code-scroll"
        accessibilityLabel={lang ? `${lang} code` : 'Code'}
      >
        <Text selectable style={[styles.codeText, { color: theme.textSoft }]}>{code}</Text>
      </ScrollView>
    </View>
  )
}

function Table({ table, base }: { table: Tokens.Table; base: TextStyle }): React.JSX.Element {
  const theme = useTheme()
  const row = (cells: Tokens.TableCell[], header: boolean, key: string) => (
    <View key={key} style={[styles.tableRow, { borderBottomColor: theme.border }]}>
      {cells.map((cell, index) => (
        <Text key={`${key}.${index}`} selectable style={[base, styles.tableCell, header && { color: theme.text, fontWeight: '700' }]}>
          {inline(cell.tokens, theme, `${key}.${index}`)}
        </Text>
      ))}
    </View>
  )
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={[styles.table, { borderColor: theme.border }]}>
      <View>
        {row(table.header, true, 'h')}
        {table.rows.map((cells, index) => row(cells, false, `r${index}`))}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  withImages: { gap: 8 },
  heading: { fontWeight: '700', marginTop: 2 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  codespan: { fontFamily: MONO, fontSize: 13 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  list: { gap: 4 },
  listItem: { flexDirection: 'row', gap: 6 },
  marker: { minWidth: 14 },
  listBody: { flex: 1, minWidth: 0, gap: 4 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  code: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  codeLang: { fontSize: 11, fontFamily: MONO, paddingHorizontal: 10, paddingTop: 6 },
  codeContent: { paddingHorizontal: 10, paddingVertical: 8 },
  codeText: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18 },
  table: { borderWidth: 1, borderRadius: 8, flexGrow: 0 },
  tableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tableCell: { width: 160, paddingHorizontal: 8, paddingVertical: 5, fontSize: 13.5, lineHeight: 19 },
})
