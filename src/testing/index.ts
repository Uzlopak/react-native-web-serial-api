/**
 * Testing & on-device-demo entry point.
 *
 * Imported via the package subpath:
 *
 *   import {VirtualSerialTransport, runSerialConformance}
 *     from 'react-native-web-serial-api/testing';
 *
 * Everything here is free of `react-native` except the conformance suite, which
 * pulls in the `Serial` polyfill — so it runs under Jest, in a browser, and on
 * a device alike. None of it is included in the main bundle.
 */

export type {SerialTransport} from '../transport';
// The injection seam, re-exported here for convenience so a test or the
// example's demo mode can flip the global transport from one import.
export {getUsbSerial, resetUsbSerial, setUsbSerial} from '../UsbSerial';
export type {ConformanceResult, ConformanceTest} from './conformance';
export {
  runRealDeviceSmokeTest,
  runSerialConformance,
  serialConformanceTests,
} from './conformance';
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
  VirtualDeviceOptions,
  VirtualSerialOptions,
} from './virtual-serial';
export {VirtualDevice, VirtualSerialTransport} from './virtual-serial';
