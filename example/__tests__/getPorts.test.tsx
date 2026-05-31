/**
 * @format
 *
 * Android/native permission-model contract for the Web Serial polyfill.
 *
 * getPorts() enumerates every probed USB-serial port the app can currently
 * access through Android USB permission (PortId.hasPermission === true) —
 * whether that permission came from requestPort() or was granted natively
 * (e.g. the system "use by default for this device" attach dialog). Ports the
 * app cannot access yet are excluded.
 *
 * requestPort() is unchanged: it shows the native picker and resolves with the
 * chosen port; it does not consult getPorts()/hasPermission.
 */

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {NativeModules} from 'react-native';

type FakePort = {
  deviceId: number;
  portNumber: number;
  usbVendorId: number;
  usbProductId: number;
  hasPermission: boolean;
};

const findAllDrivers = jest.fn<() => Promise<FakePort[]>>();
const showPortPicker = jest.fn<() => Promise<FakePort>>();

// In jest, TurboModuleRegistry.get() falls back to NativeModules[name], so
// registering a fake here lets the real library (Serial -> UsbSerialModule)
// run against controlled data. addListener/removeListeners are required by
// NativeEventEmitter.
beforeEach(() => {
  (NativeModules as any).NativeUsbSerial = {
    findAllDrivers,
    showPortPicker,
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
});

afterEach(() => {
  findAllDrivers.mockReset();
  showPortPicker.mockReset();
});

// Fresh module graph each time so the Serial singleton / known-port cache does
// not leak between tests.
function freshSerial() {
  let api: any;
  jest.isolateModules(() => {
    api = require('react-native-web-serial-api');
  });
  return new api.Serial();
}

const ftdi: FakePort = {
  deviceId: 1,
  portNumber: 0,
  usbVendorId: 0x0403,
  usbProductId: 0x6001,
  hasPermission: true,
};
const cp210xUnpermitted: FakePort = {
  deviceId: 2,
  portNumber: 0,
  usbVendorId: 0x10c4,
  usbProductId: 0xea60,
  hasPermission: false,
};

describe('getPorts() Android permission filtering', () => {
  it('includes a device granted natively (never via requestPort)', async () => {
    findAllDrivers.mockResolvedValueOnce([ftdi]);
    const ports = await freshSerial().getPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0].getInfo()).toEqual({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
    });
  });

  it('excludes a probed device the app has no permission for', async () => {
    findAllDrivers.mockResolvedValueOnce([cp210xUnpermitted]);
    const ports = await freshSerial().getPorts();
    expect(ports).toHaveLength(0);
  });

  it('returns only the permitted subset when mixed', async () => {
    findAllDrivers.mockResolvedValueOnce([ftdi, cp210xUnpermitted]);
    const ports = await freshSerial().getPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0].getInfo().usbVendorId).toBe(0x0403);
  });

  it('returns an empty list when nothing is permitted', async () => {
    findAllDrivers.mockResolvedValueOnce([
      cp210xUnpermitted,
      {...cp210xUnpermitted, deviceId: 3},
    ]);
    expect(await freshSerial().getPorts()).toHaveLength(0);
  });

  it('lists each port of a multi-port permitted device', async () => {
    findAllDrivers.mockResolvedValueOnce([
      {...ftdi, portNumber: 0},
      {...ftdi, portNumber: 1},
    ]);
    const ports = await freshSerial().getPorts();
    expect(ports).toHaveLength(2);
  });

  it('returns the SAME SerialPort instance across repeated calls', async () => {
    const serial = freshSerial();
    findAllDrivers.mockResolvedValue([ftdi]);
    const first = await serial.getPorts();
    const second = await serial.getPorts();
    expect(first[0]).toBe(second[0]); // cached, not re-created
  });
});

describe('requestPort() is unaffected by the permission filter', () => {
  it('resolves with the picked port even if getPorts would exclude it', async () => {
    // getPorts sees nothing permitted...
    findAllDrivers.mockResolvedValue([]);
    // ...but the user picks a device through the native picker.
    showPortPicker.mockResolvedValueOnce(ftdi);

    const serial = freshSerial();
    expect(await serial.getPorts()).toHaveLength(0);

    const port = await serial.requestPort();
    expect(port.getInfo()).toEqual({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
    });
    expect(showPortPicker).toHaveBeenCalledTimes(1);
  });
});
