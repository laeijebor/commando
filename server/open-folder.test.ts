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
