// Metro config for the Commando companion app.
//
// The app lives at <repo>/apps/mobile but imports `@commando/protocol`,
// `@commando/tmux-create` and the chat modules from <repo>/shared, which is outside the project
// root. Metro only watches the project root by default, so the repo root is added to
// `watchFolders` and the alias is resolved explicitly — the tsconfig path alias
// only teaches TypeScript about it, not the bundler.
const fs = require('node:fs')
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '..', '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [...(config.watchFolders ?? []), path.join(repoRoot, 'shared')]

// Hierarchical lookup stays on so nested installs (expo-router's own
// @expo/metro-runtime, for one) still resolve; apps/mobile/node_modules is
// reached first for everything the app imports directly.
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? []),
]
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@commando/session-identity': path.join(repoRoot, 'shared', 'session-identity.ts'),
  '@commando/pairing': path.join(repoRoot, 'shared', 'pairing.ts'),
  '@commando/protocol': path.join(repoRoot, 'shared', 'protocol.ts'),
  '@commando/tmux-create': path.join(repoRoot, 'shared', 'tmux-create.ts'),
  '@commando/agent-chat': path.join(repoRoot, 'shared', 'agent-chat.ts'),
  '@commando/chat-timeline': path.join(repoRoot, 'shared', 'chat-timeline.ts'),
  '@commando/chat-composer': path.join(repoRoot, 'shared', 'chat-composer.ts'),
  '@commando/guide-types': path.join(repoRoot, 'shared', 'guide-types.ts'),
  '@commando/pr-quick-look': path.join(repoRoot, 'shared', 'pr-quick-look.ts'),
  '@commando/pr-merge': path.join(repoRoot, 'shared', 'pr-merge.ts'),
  '@commando/pr-conversation': path.join(repoRoot, 'shared', 'pr-conversation.ts'),
  '@commando/redline-response': path.join(repoRoot, 'shared', 'redline-response.ts'),
  '@commando/canvas-manifest': path.join(repoRoot, 'shared', 'canvas-manifest.ts'),
  '@commando/chat-subagents': path.join(repoRoot, 'shared', 'chat-subagents.ts'),
}

// The shared files import each other as `./agent-chat.js` (the daemon runs them
// as Node ESM); Metro only finds the `.ts` source when told to.
const sharedDir = path.join(repoRoot, 'shared')
const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (path.dirname(context.originModulePath) === sharedDir && /^\.\/[\w-]+\.js$/.test(moduleName)) {
    const source = path.join(sharedDir, moduleName.replace(/\.js$/, '.ts'))
    if (fs.existsSync(source)) return { type: 'sourceFile', filePath: source }
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
