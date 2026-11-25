import { describe, expect, it, vi } from 'vitest'
import { openFolderInFinder, openUrlInBrowser, revealInFinder, type FolderOpenExecutor } from './open-folder.js'

describe('open folder in Finder', () => {
  it('passes the folder to macOS open as a fixed argument', async () => {
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue(undefined)

    await openFolderInFinder('/tmp/project; touch nope', execute, 'darwin')

    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['/tmp/project; touch nope'],
      expect.objectContaining({ shell: false, timeout: 3_000 }),
    )
  })

  it('rejects unsupported platforms and non-absolute paths before executing', async () => {
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue(undefined)

    await expect(openFolderInFinder('/tmp/project', execute, 'linux')).rejects.toThrow('only available on macOS')
    await expect(openFolderInFinder('relative/project', execute, 'darwin')).rejects.toThrow('absolute folder path')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('reveal file in Finder', () => {
  it('passes the file to macOS open -R as fixed arguments', async () => {
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue(undefined)

    await revealInFinder('/tmp/project/image.png', execute, 'darwin')

    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-R', '/tmp/project/image.png'],
      expect.objectContaining({ shell: false, timeout: 3_000 }),
    )
  })
})

describe('open a page in the browser', () => {
  it('passes a web page to macOS open as a fixed argument', async () => {
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue(undefined)

    await openUrlInBrowser('https://mcp.linear.app/authorize?state=1', execute, 'darwin')

    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['https://mcp.linear.app/authorize?state=1'],
      expect.objectContaining({ shell: false, timeout: 3_000 }),
    )
  })

  it('rejects anything but a web page, and other platforms, before executing', async () => {
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue(undefined)

    await expect(openUrlInBrowser('file:///etc/passwd', execute, 'darwin')).rejects.toThrow('Only web pages')
    await expect(openUrlInBrowser('-a Calculator', execute, 'darwin')).rejects.toThrow('Only web pages')
    await expect(openUrlInBrowser('https://example.com', execute, 'linux')).rejects.toThrow('only available on macOS')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('resource open helpers', () => {
  it('opens safe documents and folders, and reveals executable or unapproved types', async () => {
    const { mkdtemp, writeFile, chmod, rm, mkdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { openResource } = await import('./open-folder.js')
    const dir = await mkdtemp(join(tmpdir(), 'resource-open-'))
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue()
    try {
      for (const extension of ['svg', 'pdf', 'txt', 'md', 'json', 'csv', 'log', 'html', 'htm', 'png', 'mp4', 'mov', 'mp3', 'wav', 'xml', 'yaml', 'yml', 'sh', 'command', 'tool', 'terminal', 'workflow', 'scpt', 'pkg', 'dmg', 'unknown']) {
        const path = join(dir, `file.${extension}`)
        await writeFile(path, 'hello', { mode: 0o600 })
        const safe = !['sh', 'command', 'tool', 'terminal', 'workflow', 'scpt', 'pkg', 'dmg', 'unknown'].includes(extension)
        expect(await openResource(path, execute, 'darwin')).toBe(safe ? 'open' : 'reveal')
        expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', safe ? [path] : ['-R', path], expect.objectContaining({ shell: false, timeout: 3000 }))
      }
      const executable = join(dir, 'file.txt')
      await chmod(executable, 0o700)
      expect(await openResource(executable, execute, 'darwin')).toBe('reveal')
      expect(await openResource(dir, execute, 'darwin')).toBe('open')
      const app = join(dir, 'Surprise.app')
      await mkdir(app)
      expect(await openResource(app, execute, 'darwin')).toBe('reveal')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('chooses installed editors in order, encodes line URLs, honors override and falls back to TextEdit', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { openResourceInEditor } = await import('./open-folder.js')
    const dir = await mkdtemp(join(tmpdir(), 'resource-editor-'))
    const path = join(dir, 'my # file.ts')
    await writeFile(path, '')
    const execute = vi.fn<FolderOpenExecutor>().mockResolvedValue()
    try {
      for (const [app, scheme] of [['Cursor', 'cursor'], ['Visual Studio Code', 'vscode'], ['Zed', '']] as const) {
        const installed = vi.fn(async (candidate: string) => candidate === `/Applications/${app}.app`)
        await openResourceInEditor(path, 42, execute, 'darwin', '', installed)
        const args = scheme ? [`${scheme}://file${path.split('/').map(encodeURIComponent).join('/')}:42`] : ['-a', '/Applications/Zed.app', path]
        expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', args, expect.objectContaining({ shell: false }))
        expect(installed.mock.calls[0][0]).toBe('/Applications/Cursor.app')
      }
      const installed = vi.fn(async () => false)
      await openResourceInEditor(path, 12, execute, 'darwin', '/custom/Editor.app', installed)
      expect(installed).not.toHaveBeenCalled()
      expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', ['-a', '/custom/Editor.app', path], expect.anything())
      await openResourceInEditor(path, 12, execute, 'darwin', '', installed)
      expect(execute).toHaveBeenLastCalledWith('/usr/bin/open', ['-t', path], expect.anything())
      await expect(openResourceInEditor(path, undefined, execute, 'darwin', 'relative.app', installed)).rejects.toThrow('absolute .app')
      await expect(openResourceInEditor(dir, undefined, execute, 'darwin')).rejects.toThrow('Only files')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
