/**
 * @format
 *
 * Verifies that subscribing to Serial "connect"/"disconnect" wires up the
 * native USB state listeners WITHOUT first calling getPorts()/requestPort(),
 * and that a native event (e.g. the "connect" emitted when USB permission is
 * granted) reaches the JS listener. This is what lets the example's device
 * list auto-refresh on attach / detach / permission-grant.
 */

import {afterEach, beforeEach, expect, it, jest} from '@jest/globals';
import {NativeModules} from 'react-native';

// Capture the JS listeners registered against the native event emitter so the
// test can drive them like the native side would.
const nativeListeners: Record<string, ((event: unknown) => void)[]> = {};

beforeEach(() => {
  for (const k of Object.keys(nativeListeners)) {
    delete nativeListeners[k];
  }
  (NativeModules as any).NativeUsbSerial = {
    findAllDrivers: jest.fn(async () => []),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
});

afterEach(() => {
  // RCTDeviceEventEmitter is a global singleton across the RN copy; clear it so
  // listeners from one test don't leak into the next.
  const {DeviceEventEmitter} = require('react-native');
  DeviceEventEmitter.removeAllListeners('connect');
  DeviceEventEmitter.removeAllListeners('disconnect');
});

function freshSerial() {
  let api: any;
  jest.isolateModules(() => {
    api = require('react-native-web-serial-api');
  });
  return new api.Serial();
}

// Emit a native device event the way the TurboModule does (via
// RCTDeviceEventEmitter, which NativeEventEmitter listens on).
function emitNative(event: 'connect' | 'disconnect', payload: unknown) {
  const {DeviceEventEmitter} = require('react-native');
  DeviceEventEmitter.emit(event, payload);
}

it('addEventListener("connect") receives native events without calling getPorts() first', () => {
  const serial = freshSerial();
  const onConnect = jest.fn();

  // Subscribe only — no getPorts()/requestPort() beforehand.
  serial.addEventListener('connect', onConnect);

  // Native fires "connect" (e.g. attach or permission-grant).
  emitNative('connect', {
    deviceId: 7,
    usbVendorId: 0x0403,
    usbProductId: 0x6001,
  });

  expect(onConnect).toHaveBeenCalledTimes(1);
  const event = onConnect.mock.calls[0][0] as {
    type?: string;
    target?: unknown;
  };
  expect(event.type).toBe('connect');
  expect(event.target).toBe(serial);
});

it('forwards native disconnect to Serial listeners', () => {
  const serial = freshSerial();
  const onDisconnect = jest.fn();
  serial.addEventListener('disconnect', onDisconnect);

  emitNative('disconnect', {
    deviceId: 7,
    usbVendorId: 0x0403,
    usbProductId: 0x6001,
  });

  expect(onDisconnect).toHaveBeenCalledTimes(1);
  const event = onDisconnect.mock.calls[0][0] as {
    type?: string;
    target?: unknown;
  };
  expect(event.type).toBe('disconnect');
  expect(event.target).toBe(serial);
});
