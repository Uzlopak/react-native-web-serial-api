/**
 * Testing & on-device-demo entry point.
 *
 * Imported via the package subpath:
 *
 *   import {InMemorySerialTransport, installInMemorySerialTransport}
 *     from 'react-native-web-serial-api/testing';
 *
 * These are reusable building blocks for *consumers'* tests and demos — an
 * in-memory transport and an authorable `SimulatedDevice` peripheral model — so
 * they ship with the package. The library's own spec-compliance suite is NOT
 * here: it lives in `src/__tests__/conformance-suite.ts` (test-only, excluded
 * from the build and the published package). None of this is in the main bundle.
 */

export type {SerialTransport} from '../transport';
// The transport override, re-exported here for convenience so a test or the
// example's demo mode can flip the global transport from one import.
export {getUsbSerial, resetUsbSerial, setUsbSerial} from '../UsbSerial';
// One-call fixture: mount a device sim + drive both sides + await connect.
export type {
  DeviceFixtureOptions,
  MountedDeviceFixture,
  MountedDeviceFixtures,
} from './device-fixture';
export {createDeviceFixture} from './device-fixture';
// Expose a device simulator over a WebSocket so a real app/emulator can connect
// to it (same device suite in Jest and on-device). Lazy `ws`, Node-only.
export type {
  ExposedDevice,
  ExposeSimulatedDeviceOptions,
  WebSocketServerCtor,
  WebSocketServerLike,
} from './expose';
export {exposeSimulatedDevice} from './expose';
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
export type {
  DeviceOptions,
  FailableOp,
  InMemorySerialTransportOptions,
} from './in-memory-serial-transport';
export {
  DeviceHandle,
  InMemorySerialTransport,
} from './in-memory-serial-transport';
export type {
  InstallInMemorySerialTransportOptions,
  SimulatedTransportDevice,
} from './install-in-memory-serial-transport';
// Inject a mock device set into a running app (for on-device / emulator E2E).
export {installInMemorySerialTransport} from './install-in-memory-serial-transport';
// The fluent host-side client (reader/writer/readBytes/readUntil/readLine/…).
export type {ReadOptions, SerialClientOptions} from './serial-client';
export {
  createSerialClient,
  SerialClient,
} from './serial-client';
export type {
  HostSignals,
  SerialInputSignals,
  SimulatedDeviceHost,
  SimulatedDeviceIdentity,
  SimulatedDeviceOpenOptions,
} from './simulated-device';
// Author a whole simulated peripheral by extending SimulatedDevice.
export {
  LineBufferedDevice,
  LoopbackDevice,
  SimulatedDevice,
  SinkDevice,
} from './simulated-device';
// Runtime-agnostic suite runner: one suite, run in Jest + on-device + compare.
export type {
  RunTestSuiteOptions,
  SerialTest,
  SerialTestProgress,
  SerialTestResult,
  TestClient,
} from './test-suite';
export {compareTestResults, runTestSuite} from './test-suite';
