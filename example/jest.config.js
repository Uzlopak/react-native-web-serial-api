module.exports = {
  // RN 0.85 moved the Jest preset out of `react-native` into its own package.
  preset: '@react-native/jest-preset',
  // The library is consumed from ../src (via the babel module-resolver alias),
  // which physically lives outside this folder and would otherwise resolve a
  // second, un-mocked copy of react-native / react from the repo root. Pin both
  // to the example's copy so the RN jest preset's native mocks apply everywhere.
  moduleNameMapper: {
    '^react-native$': '<rootDir>/node_modules/react-native',
    '^react$': '<rootDir>/node_modules/react',
  },
  // Conformance modules are intentionally exercised by the screen tests, but we
  // don't want their large protocol matrices to count toward coverage targets.
  coveragePathIgnorePatterns: ['<rootDir>/src/devices/.*/conformance\\.ts$'],
};
