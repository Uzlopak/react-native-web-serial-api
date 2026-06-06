/**
 * Jest config for the library's own unit + conformance tests (src/__tests__).
 *
 * Uses the React Native preset because the transport seam (src/UsbSerial.ts)
 * imports `react-native`. The tests themselves never touch real native modules
 * — they inject a VirtualSerialTransport — but the import graph still needs the
 * RN mocks the preset provides.
 */
module.exports = {
  preset: '@react-native/jest-preset',
  roots: ['<rootDir>/src'],
  // Only *.test.ts/tsx are test files — so shared helpers like
  // src/__tests__/wpt/wpt-helpers.ts are not mistaken for empty test suites.
  testMatch: ['<rootDir>/src/**/*.{test,spec}.{ts,tsx}'],
  // Pin react / react-native to this package's own copy so the preset's mocks
  // resolve consistently (the example app keeps its own copies).
  moduleNameMapper: {
    '^react-native$': '<rootDir>/node_modules/react-native',
    '^react$': '<rootDir>/node_modules/react',
  },
  // Coverage (run with `npm run test:coverage`). Collects from all of src so
  // unexercised files still show up. Note: the native bridge (NativeUsbSerial*)
  // and the on-device parts of UsbSerial.ts only run on a real device, so they
  // read low here — that's expected; the W3C polyfill in WebSerial.ts is the
  // number to watch.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/__tests__/**'],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 80,
      functions: 85,
      lines: 85,
    },
  },
};
