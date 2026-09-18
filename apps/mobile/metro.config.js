// Metro config for the Commando companion app.
//
// The app lives at <repo>/apps/mobile but imports `@commando/protocol` and
// `@commando/tmux-create` from <repo>/shared, which is outside the project root. Metro only
// watches the project root by default, so the repo root is added to
// `watchFolders` and the alias is resolved explicitly — the tsconfig path alias
// only teaches TypeScript about it, not the bundler.
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
  '@commando/protocol': path.join(repoRoot, 'shared', 'protocol.ts'),
  '@commando/tmux-create': path.join(repoRoot, 'shared', 'tmux-create.ts'),
}

module.exports = config
