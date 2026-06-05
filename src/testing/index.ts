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
export type {InstallSerialMockOptions, SerialMockDevice} from './install';
// Inject a mock device set into a running app (for on-device / emulator E2E).
export {installSerialMock} from './install';
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
export type {
  FailableOp,
  VirtualSerialDeviceOptions,
  VirtualSerialTransportOptions,
} from './virtual-serial-device';
export {
  VirtualSerialDevice,
  VirtualSerialTransport,
} from './virtual-serial-device';
