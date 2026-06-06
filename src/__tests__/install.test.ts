/**
 * Unit tests for installInMemorySerialTransport — the one-call app-injection entrypoint
 * (otherwise only exercised by the Maestro E2E run).
 */
import {afterEach, describe, expect, it} from '@jest/globals';
import {
  installInMemorySerialTransport,
  LoopbackDevice,
  SinkDevice,
} from '../testing';
import {getUsbSerial, resetUsbSerial} from '../UsbSerial';

afterEach(() => {
  resetUsbSerial();
});

describe('installInMemorySerialTransport', () => {
  it('installs nothing and returns null when disabled', () => {
    const result = installInMemorySerialTransport({
      enabled: false,
      devices: [new LoopbackDevice()],
    });
    expect(result).toBeNull();
  });

  it('installs a transport globally and grants SimulatedDevices permission', () => {
    const transport = installInMemorySerialTransport({
      devices: [new LoopbackDevice(), new SinkDevice()],
    });
    expect(transport).not.toBeNull();
    expect(getUsbSerial()).toBe(transport);
    expect(transport?.devices).toHaveLength(2);
    expect(transport?.devices.every(d => d.hasPermission)).toBe(true);
  });

  it('supports the {device, options} form', () => {
    const transport = installInMemorySerialTransport({
      devices: [
        {
          device: new LoopbackDevice({
            usbVendorId: 0x1234,
            usbProductId: 0x5678,
          }),
          options: {portNumber: 3},
        },
      ],
    });
    const device = transport?.devices[0];
    expect(device?.usbVendorId).toBe(0x1234);
    expect(device?.portNumber).toBe(3);
    expect(device?.hasPermission).toBe(true);
  });

  it('forwards transport options', async () => {
    const transport = installInMemorySerialTransport({
      devices: [new LoopbackDevice()],
      transport: {chunkSize: 8, latencyMs: 1},
    });
    expect(transport).not.toBeNull();

    const device = transport!.devices[0];
    const {deviceId, portNumber} = device;
    const seen: number[][] = [];

    transport!.onData(e => {
      if (e.deviceId === deviceId && e.portNumber === portNumber) {
        seen.push(e.data);
      }
    });

    await transport!.open(deviceId, portNumber, {baudRate: 9600});
    await transport!.startReading(deviceId, portNumber);
    device.push([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // latencyMs should keep delivery asynchronous.
    expect(seen).toEqual([]);

    await new Promise(r => setTimeout(r, 5));

    // chunkSize=8 should split one push into two onData callbacks.
    expect(seen).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [9, 10],
    ]);
  });
});
