import { describe, expect, it, vi } from 'vitest'
import { openFolderInFinder, revealInFinder, type FolderOpenExecutor } from './open-folder.js'

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
