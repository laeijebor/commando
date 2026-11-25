import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultGitProcessExecutor, type GitProcessExecutor } from './git-diff.js'
import { GitCursorCloud, normaliseGithubUrl } from './git-cursor-cloud.js'
import { GitWorktreeService } from './git-worktree.js'

const repoUrl = 'https://github.com/acme/app'
const folders: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })

describe('GitHub remote normalisation', () => {
  it.each(['git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app.git', repoUrl])('normalises %s', (url) => {
    expect(normaliseGithubUrl(url)).toBe(repoUrl)
  })
  it.each(['https://gitlab.com/acme/app', '', 'https://github.com/acme/app/', 'https://user@github.com/acme/app', 'https://github.com:443/acme/app', `${repoUrl}?x=1`, `${repoUrl}#x`, `${repoUrl}\n`, 'https://github.com/acme/..'])('rejects %j', (url) => {
    expect(normaliseGithubUrl(url)).toBeUndefined()
  })
})

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'cursor-cloud-git-'))
  folders.push(cwd)
  const bare = join(cwd, 'remote.git')
  const git = (args: string[]) => defaultGitProcessExecutor('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, shell: false, timeout: 5_000, windowsHide: true })
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Cloud test'])
  await git(['config', 'user.email', 'cloud@example.test'])
  await git(['commit', '--allow-empty', '-m', 'initial'])
  await git(['init', '--bare', bare])
  await git(['remote', 'add', 'origin', bare])
  await git(['push', '-u', 'origin', 'main'])
  await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  await git(['remote', 'set-url', 'origin', repoUrl])
  // Only the network operation is redirected to the real bare repository.
  const execute = vi.fn<GitProcessExecutor>((file, args, options) => defaultGitProcessExecutor(file, args[0] === 'ls-remote' ? ['ls-remote', bare, ...args.slice(2)] : args, options))
  return { cwd, git, execute, service: new GitCursorCloud(execute) }
}

it('checks the pushed ref in a bare remote, even when local HEAD has moved', async () => {
  const { cwd, git, execute, service } = await fixture()
  await git(['commit', '--allow-empty', '-m', 'local only'])
  await expect(service.assertPushed(cwd, repoUrl, 'main')).resolves.toBeUndefined()
  expect(execute).toHaveBeenCalledWith('git', ['ls-remote', 'origin', 'refs/heads/main'], expect.objectContaining({ cwd, timeout: 5_000, env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }) }))
  await expect(service.assertPushed(cwd, repoUrl, 'missing')).rejects.toThrow("Push missing to GitHub first; Cursor's cloud starts from the pushed branch.")
  await expect(service.assertPushed(cwd, 'https://github.com/other/app', 'main')).rejects.toThrow('No GitHub remote matches')
})

it('extends the existing repo probe with GitHub tracking state and the default ref when detached', async () => {
  const { cwd, git, execute, service } = await fixture()
  expect(await new GitWorktreeService(execute).probe(cwd, { github: true })).toMatchObject({ github: { repoUrl, remote: 'origin', ref: 'main', pushed: true, ahead: 0, behind: 0 } })
  await git(['commit', '--allow-empty', '-m', 'ahead'])
  expect(await service.probe(cwd, 'main')).toMatchObject({ pushed: true, ahead: 1, behind: 0 })
  await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  await git(['checkout', '--detach', 'HEAD~1'])
  expect(await service.probe(cwd, 'HEAD', 'main')).toMatchObject({ ref: 'main', pushed: true, ahead: 0, behind: 1 })
  await git(['checkout', '-b', 'unpublished'])
  expect(await service.probe(cwd, 'unpublished')).toMatchObject({ ref: 'unpublished', pushed: false })
  await git(['remote', 'set-url', 'origin', 'https://gitlab.com/acme/app'])
  expect(await service.probe(cwd, 'main')).toBeUndefined()
  await git(['remote', 'remove', 'origin'])
  expect(await service.probe(cwd, 'main')).toBeUndefined()
})

it('propagates remote failures instead of reporting a branch as missing', async () => {
  const { cwd, execute } = await fixture()
  const failing: GitProcessExecutor = (file, args, options) => args[0] === 'ls-remote' ? Promise.reject(new Error('git timed out')) : execute(file, args, options)
  await expect(new GitCursorCloud(failing).assertPushed(cwd, repoUrl, 'main')).rejects.toThrow('git timed out')
})


it('finds the matching GitHub remote when origin points at another repository', async () => {
  const { cwd, git, execute, service } = await fixture()
  await git(['remote', 'rename', 'origin', 'upstream'])
  await git(['remote', 'add', 'origin', 'https://github.com/other/app'])
  await expect(service.assertPushed(cwd, repoUrl, 'main')).resolves.toBeUndefined()
  expect(execute).toHaveBeenCalledWith('git', ['ls-remote', 'upstream', 'refs/heads/main'], expect.anything())
})


it('skips GitHub metadata for pane resolution and worktree creation probes', async () => {
  const { cwd, execute } = await fixture()
  const info = await new GitWorktreeService(execute).probe(cwd)
  expect(info.isRepo).toBe(true)
  expect(info.github).toBeUndefined()
  expect(execute.mock.calls.some(([, args]) => args[0] === 'remote' || args[0] === 'rev-list')).toBe(false)
  execute.mockClear()
  expect((await new GitWorktreeService(execute).probe(cwd, { github: true })).github).toMatchObject({ repoUrl })
  expect(execute.mock.calls.some(([, args]) => args[0] === 'remote')).toBe(true)
})

it.each([undefined, 'ssh -i /keys/custom -o IdentitiesOnly=yes'])('preserves the SSH command %j and appends batch mode', async (command) => {
  vi.stubEnv('GIT_SSH_COMMAND', command)
  const { cwd, execute, service } = await fixture()
  await service.assertPushed(cwd, repoUrl, 'main')
  expect(execute).toHaveBeenCalledWith('git', ['ls-remote', 'origin', 'refs/heads/main'], expect.objectContaining({
    env: expect.objectContaining({ GIT_SSH_COMMAND: `${command ?? 'ssh'} -o BatchMode=yes` }),
  }))
})
