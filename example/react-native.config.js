const path = require('node:path');
const pkg = require('../package.json');

/**
 * The library lives one level up (repo root) and is installed here as a symlink
 * pointing to an ancestor of this example dir. React Native autolinking skips
 * dependencies whose resolved path is an ancestor of the project, so we map the
 * dependency explicitly to the library's android module. This mirrors what
 * create-react-native-library scaffolds for its example app.
 */
module.exports = {
  dependencies: {
    [pkg.name]: {
      root: path.join(__dirname, '..'),
    },
  },
};
