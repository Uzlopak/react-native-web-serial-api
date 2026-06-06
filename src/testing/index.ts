/**
 * Testing & on-device-demo entry point.
 *
 * Imported via the package subpath:
 *
 *   import {VirtualSerialTransport, installSerialMock}
 *     from 'react-native-web-serial-api/testing';
 *
 * These are reusable building blocks for *consumers'* tests and demos — an
 * in-memory transport and an authorable `SerialDevice` peripheral model — so
 * they ship with the package. The library's own spec-compliance suite is NOT
 * here: it lives in `src/__tests__/conformance-suite.ts` (test-only, excluded
 * from the build and the published package). None of this is in the main bundle.
 */

export type {SerialTransport} from '../transport';
// The injection seam, re-exported here for convenience so a test or the
// example's demo mode can flip the global transport from one import.
export {getUsbSerial, resetUsbSerial, setUsbSerial} from '../UsbSerial';
// Expose a device simulator over a WebSocket so a real app/emulator can connect
// to it (same device suite in Jest and on-device). Lazy `ws`, Node-only.
export type {
  ExposedSerialDevice,
  ExposeSerialDeviceOptions,
  WebSocketServerCtor,
  WebSocketServerLike,
} from './expose';
export {exposeSerialDevice} from './expose';
// Dependency-free assertion/stream helpers for writing serial tests.
export type {ByteReader, RejectionExpectation} from './harness';
export {
  assert,
  assertEqual,
  assertRejects,
  bytesEqual,
  errorMessage,
  readBytes,
  withTimeout,
} from './harness';
export type {InstallSerialMockOptions, SerialMockDevice} from './install';
// Inject a mock device set into a running app (for on-device / emulator E2E).
export {installSerialMock} from './install';
// One-call fixture: mount a device sim + drive both sides + await connect.
export type {
  MountedSerialDevice,
  MountedSerialDevices,
  MountSerialDeviceOptions,
} from './mount';
export {mountSerialDevice} from './mount';
export type {
  DeviceIdentity,
  SerialDeviceHost,
  SerialDeviceOpenOptions,
  SerialHostSignals,
  SerialInputSignals,
} from './serial-device';
// Author a whole simulated peripheral by extending SerialDevice.
export {
  EchoDevice,
  LineDevice,
  SerialDevice,
  SilentDevice,
} from './serial-device';
// The fluent host-side client (reader/writer/readBytes/readUntil/readLine/…).
export type {
  ReadOptions,
  SerialTestHarnessOptions,
} from './serial-test-harness';
export {
  createSerialTestHarness,
  SerialTestHarness,
} from './serial-test-harness';
// Runtime-agnostic suite runner: one suite, run in Jest + on-device + compare.
export type {
  RunSerialTestsOptions,
  SerialTest,
  SerialTestClient,
  SerialTestProgress,
  SerialTestResult,
} from './suite';
export {compareResults, runSerialTests} from './suite';
export type {
  FailableOp,
  VirtualSerialDeviceOptions,
  VirtualSerialTransportOptions,
} from './virtual-serial-device';
export {
  VirtualSerialDevice,
  VirtualSerialTransport,
} from './virtual-serial-device';
