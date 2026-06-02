/**
 * Unit tests for UsbSerialModule — the native-backed SerialTransport. The
 * TurboModule is mocked so the wrapper's forwarding (and the option-merge /
 * default-timeout logic) is exercised without a device, and native events are
 * driven through RCTDeviceEventEmitter the way the real bridge does.
 */
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {DeviceEventEmitter, NativeModules} from 'react-native';

jest.mock('../NativeUsbSerial', () => ({
  __esModule: true,
  default: {
    findAllDrivers: jest.fn(),
    showPortPicker: jest.fn(),
    requestPermission: jest.fn(),
    open: jest.fn(),
    close: jest.fn(),
    isOpen: jest.fn(),
    write: jest.fn(),
    startReading: jest.fn(),
    stopReading: jest.fn(),
    setParameters: jest.fn(),
    setDTR: jest.fn(),
    setRTS: jest.fn(),
    getDTR: jest.fn(),
    getRTS: jest.fn(),
    getCD: jest.fn(),
    getCTS: jest.fn(),
    getDSR: jest.fn(),
    getRI: jest.fn(),
    getControlLines: jest.fn(),
    getSupportedControlLines: jest.fn(),
    setFlowControl: jest.fn(),
    getFlowControl: jest.fn(),
    getSupportedFlowControl: jest.fn(),
    setBreak: jest.fn(),
    purgeHwBuffers: jest.fn(),
    getSerial: jest.fn(),
  },
}));

import NativeUsbSerial from '../NativeUsbSerial';
import {
  getUsbSerial,
  resetUsbSerial,
  setUsbSerial,
  UsbSerialModule,
} from '../UsbSerial';

// biome-ignore lint/suspicious/noExplicitAny: the mocked native module's fns
const native = NativeUsbSerial as unknown as Record<string, any>;

beforeEach(() => {
  for (const fn of Object.values(native)) fn.mockReset();
  (NativeModules as Record<string, unknown>).NativeUsbSerial = {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
});

afterEach(() => {
  resetUsbSerial();
  for (const e of ['data', 'error', 'connect', 'disconnect']) {
    DeviceEventEmitter.removeAllListeners(e);
  }
});

describe('UsbSerialModule forwarding', () => {
  it('open() applies default options and forwards positional args', async () => {
    const usb = new UsbSerialModule();
    await usb.open(7, 0, {baudRate: 115200});
    expect(native.open).toHaveBeenCalledWith(7, 0, 115200, 8, 1, 0);

    await usb.open(7, 0, {baudRate: 9600, dataBits: 7, stopBits: 2, parity: 2});
    expect(native.open).toHaveBeenLastCalledWith(7, 0, 9600, 7, 2, 2);
  });

  it('setParameters() merges defaults like open()', async () => {
    const usb = new UsbSerialModule();
    await usb.setParameters(1, 0, {baudRate: 4800});
    expect(native.setParameters).toHaveBeenCalledWith(1, 0, 4800, 8, 1, 0);
  });

  it('write() defaults the timeout to 2000', async () => {
    const usb = new UsbSerialModule();
    await usb.write(1, 0, [1, 2, 3]);
    expect(native.write).toHaveBeenCalledWith(1, 0, [1, 2, 3], 2000);
    await usb.write(1, 0, [4], 500);
    expect(native.write).toHaveBeenLastCalledWith(1, 0, [4], 500);
  });

  it('forwards the remaining methods and passes results through', async () => {
    const usb = new UsbSerialModule();
    native.isOpen.mockReturnValue(true);
    native.getDTR.mockResolvedValue(true);
    native.getControlLines.mockResolvedValue(['DTR']);
    native.getFlowControl.mockResolvedValue('RTS_CTS');
    native.getSerial.mockResolvedValue('ACME-1');

    expect(usb.isOpen(2, 1)).toBe(true);
    expect(native.isOpen).toHaveBeenCalledWith(2, 1);

    await usb.close(2, 1);
    expect(native.close).toHaveBeenCalledWith(2, 1);
    await usb.requestPermission(2);
    expect(native.requestPermission).toHaveBeenCalledWith(2);
    await usb.findAllDrivers();
    expect(native.findAllDrivers).toHaveBeenCalled();
    await usb.showPortPicker([{usbVendorId: 0x0403}], {
      titleSelectPort: 'Pick',
    });
    expect(native.showPortPicker).toHaveBeenCalledWith(
      [{usbVendorId: 0x0403}],
      {titleSelectPort: 'Pick'},
    );
    await usb.startReading(2, 1);
    await usb.stopReading(2, 1);
    expect(native.stopReading).toHaveBeenCalledWith(2, 1);

    await usb.setDTR(2, 1, true);
    expect(native.setDTR).toHaveBeenCalledWith(2, 1, true);
    await usb.setRTS(2, 1, false);
    await usb.setBreak(2, 1, true);
    expect(native.setBreak).toHaveBeenCalledWith(2, 1, true);

    expect(await usb.getDTR(2, 1)).toBe(true);
    await usb.getRTS(2, 1);
    await usb.getCD(2, 1);
    await usb.getCTS(2, 1);
    await usb.getDSR(2, 1);
    await usb.getRI(2, 1);
    expect(native.getRI).toHaveBeenCalledWith(2, 1);

    expect(await usb.getControlLines(2, 1)).toEqual(['DTR']);
    await usb.getSupportedControlLines(2, 1);
    await usb.setFlowControl(2, 1, 'RTS_CTS');
    expect(native.setFlowControl).toHaveBeenCalledWith(2, 1, 'RTS_CTS');
    expect(await usb.getFlowControl(2, 1)).toBe('RTS_CTS');
    await usb.getSupportedFlowControl(2, 1);
    await usb.purgeHwBuffers(2, 1, true, false);
    expect(native.purgeHwBuffers).toHaveBeenCalledWith(2, 1, true, false);
    expect(await usb.getSerial(2, 1)).toBe('ACME-1');
  });
});

describe('UsbSerialModule events', () => {
  it('delivers native data/error/connect/disconnect to on* subscribers', () => {
    const usb = new UsbSerialModule();
    const onData = jest.fn();
    const onError = jest.fn();
    const onConnect = jest.fn();
    const onDisconnect = jest.fn();
    usb.onData(onData);
    usb.onError(onError);
    usb.onConnect(onConnect);
    usb.onDisconnect(onDisconnect);

    const data = {deviceId: 1, portNumber: 0, data: [1, 2]};
    DeviceEventEmitter.emit('data', data);
    DeviceEventEmitter.emit('error', {deviceId: 1, portNumber: 0, error: 'x'});
    DeviceEventEmitter.emit('connect', {
      deviceId: 1,
      usbVendorId: 1,
      usbProductId: 2,
    });
    DeviceEventEmitter.emit('disconnect', {
      deviceId: 1,
      usbVendorId: 1,
      usbProductId: 2,
    });

    expect(onData).toHaveBeenCalledWith(data);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('a subscription stops firing after remove()', () => {
    const usb = new UsbSerialModule();
    const onData = jest.fn();
    usb.onData(onData).remove();
    DeviceEventEmitter.emit('data', {deviceId: 1, portNumber: 0, data: []});
    expect(onData).not.toHaveBeenCalled();
  });
});

describe('getUsbSerial / setUsbSerial / resetUsbSerial', () => {
  it('lazily constructs and caches a UsbSerialModule', () => {
    const first = getUsbSerial();
    expect(first).toBeInstanceOf(UsbSerialModule);
    expect(getUsbSerial()).toBe(first);
  });

  it('setUsbSerial overrides; resetUsbSerial restores the native module', () => {
    const fake = {} as unknown as ReturnType<typeof getUsbSerial>;
    setUsbSerial(fake);
    expect(getUsbSerial()).toBe(fake);
    resetUsbSerial();
    expect(getUsbSerial()).toBeInstanceOf(UsbSerialModule);
  });
});
