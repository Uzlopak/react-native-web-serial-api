const path = require('node:path');
const pkg = require('../package.json');

/**
 * Resolve the library by its package name straight to its TypeScript source,
 * so changes to `../src` reload live in the example without a rebuild.
 */
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module-resolver',
      {
        extensions: ['.tsx', '.ts', '.js', '.json'],
        alias: {
          // The `/testing` subpath must come first: module-resolver matches
          // alias keys as prefixes, so the bare-name entry would otherwise
          // capture `<pkg>/testing` and append the subpath to src/index.ts.
          [`${pkg.name}/testing`]: path.join(
            __dirname,
            '..',
            'src',
            'testing',
            'index.ts',
          ),
          [pkg.name]: path.join(__dirname, '..', pkg.source),
        },
      },
    ],
  ],
};
