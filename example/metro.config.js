const path = require('node:path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const modules = Object.keys({...pkg.peerDependencies});

// Absolute paths to the example's single copy of each peer dependency.
const peerModulePaths = modules.reduce((acc, name) => {
  acc[name] = path.resolve(__dirname, 'node_modules', name);
  return acc;
}, {});

/**
 * Metro configuration for the example app inside the library monorepo.
 *
 * - watch the repo root so edits to the library's `src/` hot-reload here
 * - force the library's peer deps (react / react-native) to resolve to the
 *   example's single copy. This is critical: the library source lives at the
 *   repo root (above this folder) and there is ALSO a react-native installed at
 *   the repo root (the library's own devDependency). Without forcing a single
 *   copy, `src/WebSerial.ts` resolves the root react-native while the app uses
 *   the example's copy — two separate RCTDeviceEventEmitter singletons, so
 *   native 'data' events are emitted into one and listened for on the other,
 *   and nothing is received. extraNodeModules alone does NOT fix this because
 *   the importing file is outside the project root, so we also intercept via
 *   resolveRequest.
 *
 * https://reactnative.dev/docs/metro
 */
const config = {
  watchFolders: [root],
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(root, 'node_modules'),
    ],
    extraNodeModules: peerModulePaths,
    resolveRequest: (context, moduleName, platform) => {
      // Pin every peer dependency (and its subpaths) to the example's copy,
      // regardless of which file imports it.
      for (const name of modules) {
        if (moduleName === name || moduleName.startsWith(`${name}/`)) {
          const rest = moduleName.slice(name.length); // '' or '/subpath'
          return context.resolveRequest(
            context,
            peerModulePaths[name] + rest,
            platform,
          );
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
