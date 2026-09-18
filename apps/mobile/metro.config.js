// Metro config for the Commando companion app.
//
// The app lives at <repo>/apps/mobile but imports `@commando/protocol` from
// <repo>/shared/protocol.ts, which is outside the project root. Metro only
// watches the project root by default, so the repo root is added to
// `watchFolders` and the alias is resolved explicitly — the tsconfig path alias
// only teaches TypeScript about it, not the bundler.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '..', '..')

const config = getDefaultConfig(projectRoot)

config.watchFolders = [...(config.watchFolders ?? []), path.join(repoRoot, 'shared')]

config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')]
config.resolver.disableHierarchicalLookup = true
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@commando/protocol': path.join(repoRoot, 'shared', 'protocol.ts'),
}

module.exports = config
