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
  // Pin react / react-native to this package's own copy so the preset's mocks
  // resolve consistently (the example app keeps its own copies).
  moduleNameMapper: {
    '^react-native$': '<rootDir>/node_modules/react-native',
    '^react$': '<rootDir>/node_modules/react',
  },
};
