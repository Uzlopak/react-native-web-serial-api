/**
 * Unit tests for VirtualSerialTransport surface that the Serial polyfill never
 * exercises directly: the full SerialTransport method set, error injection, and
 * the VirtualDevice handle helpers.
 */
import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {EchoDevice, SerialDevice, VirtualSerialTransport} from '../testing';

function opened() {
  const transport = new VirtualSerialTransport();
  const device = transport.addDevice(
    new EchoDevice({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      serialNumber: 'SN-1',
    }),
    {hasPermission: true},
  );
  return {transport, device, id: device.deviceId, p: device.portNumber};
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('VirtualSerialTransport: SerialTransport methods', () => {
  it('control signals, flow control, parameters, serial, buffers', async () => {
    const {transport, device, id, p} = opened();
    await transport.open(id, p, {baudRate: 9600});
    expect(transport.isOpen(id, p)).toBe(true);

    await transport.setDTR(id, p, true);
    await transport.setRTS(id, p, true);
    expect(await transport.getDTR(id, p)).toBe(true);
    expect(await transport.getRTS(id, p)).toBe(true);
    // loopback: DTR→DSR+DCD, RTS→CTS
    expect(await transport.getCD(id, p)).toBe(true);
    expect(await transport.getDSR(id, p)).toBe(true);
    expect(await transport.getCTS(id, p)).toBe(true);
    expect(await transport.getRI(id, p)).toBe(false);

    expect(await transport.getControlLines(id, p)).toEqual(
      expect.arrayContaining(['DTR', 'RTS', 'CTS', 'DSR', 'CD']),
    );
    expect(await transport.getSupportedControlLines(id, p)).toEqual([
      'RTS',
      'CTS',
      'DTR',
      'DSR',
      'CD',
      'RI',
    ]);

    await transport.setFlowControl(id, p, 'RTS_CTS');
    expect(await transport.getFlowControl(id, p)).toBe('RTS_CTS');
    expect(await transport.getSupportedFlowControl(id, p)).toEqual([
      'NONE',
      'RTS_CTS',
    ]);

    await transport.setParameters(id, p, {baudRate: 19200, dataBits: 7});
    expect(device.openOptions).toMatchObject({baudRate: 19200, dataBits: 7});

    await transport.setBreak(id, p, true);
    expect(await transport.getSerial(id, p)).toBe('SN-1');
    await transport.purgeHwBuffers(id, p, true, true);
    await transport.startReading(id, p);
    await transport.stopReading(id, p);
    await transport.close(id, p);
    expect(transport.isOpen(id, p)).toBe(false);
  });

  it('requestPermission grants for a known device and is false otherwise', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {
      hasPermission: false,
    });
    expect(device.hasPermission).toBe(false);
    expect(await transport.requestPermission(device.deviceId)).toBe(true);
    expect(device.hasPermission).toBe(true);
    expect(await transport.requestPermission(999999)).toBe(false);
  });

  it('showPortPicker honours a predicate + filters', async () => {
    const transport = new VirtualSerialTransport();
    transport.addDevice(new EchoDevice({usbVendorId: 1, usbProductId: 1}));
    transport.addDevice(new EchoDevice({usbVendorId: 2, usbProductId: 2}));
    transport.selectNextPort(d => d.usbVendorId === 2);
    const picked = await transport.showPortPicker([{usbVendorId: 2}]);
    expect(picked.usbVendorId).toBe(2);
  });

  it('can pre-register devices via constructor options', async () => {
    const transport = new VirtualSerialTransport({devices: [new EchoDevice()]});
    const ports = await transport.findAllDrivers();
    expect(ports).toHaveLength(1);
  });
});

describe('VirtualSerialTransport: error injection (failNext)', () => {
  it('rejects the next call to each failable op', async () => {
    const {transport, device, id, p} = opened();

    device.failNext('open');
    await expect(transport.open(id, p, {baudRate: 9600})).rejects.toThrow();
    await transport.open(id, p, {baudRate: 9600}); // succeeds now

    device.failNext('write');
    await expect(transport.write(id, p, [1])).rejects.toThrow();
    device.failNext('startReading');
    await expect(transport.startReading(id, p)).rejects.toThrow();
    device.failNext('stopReading');
    await expect(transport.stopReading(id, p)).rejects.toThrow();
    device.failNext('setSignals');
    await expect(transport.setDTR(id, p, true)).rejects.toThrow();
    device.failNext('getSignals');
    await expect(transport.getCD(id, p)).rejects.toThrow();
    device.failNext('close');
    await expect(transport.close(id, p)).rejects.toThrow();
  });
});

describe('VirtualSerialTransport: device handle', () => {
  it('removeDevice detaches and drops the device', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    device.setInputSignals({ri: true});
    expect(await transport.getRI(device.deviceId, device.portNumber)).toBe(
      true,
    );

    transport.removeDevice(device);
    expect(transport.devices).toHaveLength(0);
    expect(await transport.findAllDrivers()).toHaveLength(0);
  });

  it('a throwing device hook is isolated from the transport', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    class Boom extends SerialDevice {
      readonly usbVendorId = 1;
      readonly usbProductId = 1;
      onData(): void {
        throw new Error('boom');
      }
    }
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new Boom(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    await transport.open(id, p, {baudRate: 9600});
    await expect(transport.write(id, p, [1, 2, 3])).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('exposes deviceId/portNumber/openOptions to the device', async () => {
    const seen: Array<number | null> = [];
    class Reporter extends SerialDevice {
      readonly usbVendorId = 7;
      readonly usbProductId = 7;
      onOpen(): void {
        seen.push(
          this.deviceId,
          this.portNumber,
          this.openOptions?.baudRate ?? null,
        );
      }
    }
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new Reporter(), {hasPermission: true});
    await transport.open(device.deviceId, device.portNumber, {baudRate: 4800});
    expect(seen).toEqual([device.deviceId, device.portNumber, 4800]);
  });

  it('maps device-provided input signals through the host bridge', async () => {
    class SignalsOnOpen extends SerialDevice {
      readonly usbVendorId = 9;
      readonly usbProductId = 9;
      onOpen(): void {
        this.setSignals({
          dataCarrierDetect: true,
          clearToSend: true,
          ringIndicator: true,
          dataSetReady: true,
        });
      }
    }

    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new SignalsOnOpen(), {hasPermission: true});

    await transport.open(device.deviceId, device.portNumber, {baudRate: 9600});

    await expect(transport.getCD(device.deviceId, device.portNumber)).resolves.toBe(true);
    await expect(transport.getCTS(device.deviceId, device.portNumber)).resolves.toBe(true);
    await expect(transport.getRI(device.deviceId, device.portNumber)).resolves.toBe(true);
    await expect(transport.getDSR(device.deviceId, device.portNumber)).resolves.toBe(true);
  });

  it('maps partial input signals without touching omitted fields', async () => {
    class PartialSignals extends SerialDevice {
      readonly usbVendorId = 11;
      readonly usbProductId = 11;
      onOpen(): void {
        this.setSignals({clearToSend: true});
      }
    }

    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new PartialSignals(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;

    await transport.open(id, p, {baudRate: 9600});
    await expect(transport.getCTS(id, p)).resolves.toBe(true);
    await expect(transport.getCD(id, p)).resolves.toBe(false);
    await expect(transport.getDSR(id, p)).resolves.toBe(false);
  });

  it('maps non-CTS input signals through host bridge', async () => {
    class RingOnlySignals extends SerialDevice {
      readonly usbVendorId = 12;
      readonly usbProductId = 12;
      onOpen(): void {
        this.setSignals({ringIndicator: true});
      }
    }

    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new RingOnlySignals(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;

    await transport.open(id, p, {baudRate: 9600});
    await expect(transport.getRI(id, p)).resolves.toBe(true);
    await expect(transport.getCTS(id, p)).resolves.toBe(false);
  });

  it('isolates an asynchronously rejected device hook', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    class AsyncBoom extends SerialDevice {
      readonly usbVendorId = 10;
      readonly usbProductId = 10;
      onData(): Promise<void> {
        return Promise.reject(new Error('async boom'));
      }
    }

    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new AsyncBoom(), {hasPermission: true});
    await transport.open(device.deviceId, device.portNumber, {baudRate: 9600});

    await expect(
      transport.write(device.deviceId, device.portNumber, [1, 2, 3]),
    ).resolves.toBeUndefined();

    await Promise.resolve();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('VirtualSerialTransport: picker, timing and subscriptions', () => {
  it('rejects picker when filters exclude all candidates', async () => {
    const transport = new VirtualSerialTransport();
    transport.addDevice(new EchoDevice({usbVendorId: 0x1234, usbProductId: 0x0001}));

    await expect(
      transport.showPortPicker([{usbVendorId: 0x1234, usbProductId: 0x9999}]),
    ).rejects.toThrow('No port selected');
  });

  it('uses delayed resolve/reject when latencyMs is configured', async () => {
    const transport = new VirtualSerialTransport({latencyMs: 2});
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});

    const drivers = await transport.findAllDrivers();
    expect(drivers).toHaveLength(1);

    transport.rejectNextPortPicker();
    const pickStart = Date.now();
    const pickPromise = transport.showPortPicker([]);

    await Promise.resolve();
    await expect(pickPromise).rejects.toThrow('No port selected');
    expect(Date.now() - pickStart).toBeGreaterThanOrEqual(1);

    const openStart = Date.now();
    const openPromise = transport.open(device.deviceId, device.portNumber, {
      baudRate: 9600,
    });

    await Promise.resolve();
    await expect(openPromise).resolves.toBeUndefined();
    expect(Date.now() - openStart).toBeGreaterThanOrEqual(1);
  });

  it('does not auto-grant permission when configured off', async () => {
    const transport = new VirtualSerialTransport({autoGrantPermission: false});
    const device = transport.addDevice(new EchoDevice(), {hasPermission: false});

    await transport.showPortPicker([]);
    expect(device.hasPermission).toBe(false);
  });

  it('stops invoking removed connect/disconnect listeners', () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const onConnect = jest.fn();
    const onDisconnect = jest.fn();

    const connectSub = transport.onConnect(onConnect);
    const disconnectSub = transport.onDisconnect(onDisconnect);

    device.detach();
    device.attach();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledTimes(1);

    connectSub.remove();
    disconnectSub.remove();

    device.detach();
    device.attach();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('writes reject while port is closed', async () => {
    const {transport, id, p} = opened();
    await expect(transport.write(id, p, [1])).rejects.toThrow('Port is not open');
  });

  it('handles unknown device ids with safe defaults', async () => {
    const transport = new VirtualSerialTransport();
    await expect(transport.open(999, 0, {baudRate: 9600})).rejects.toThrow(
      'Device not found',
    );
    await expect(transport.close(999, 0)).resolves.toBeUndefined();
    await expect(transport.startReading(999, 0)).resolves.toBeUndefined();
    await expect(transport.stopReading(999, 0)).resolves.toBeUndefined();
    await expect(
      transport.setParameters(999, 0, {baudRate: 9600}),
    ).resolves.toBeUndefined();
    await expect(transport.setDTR(999, 0, true)).resolves.toBeUndefined();
    await expect(transport.setFlowControl(999, 0, 'RTS_CTS')).resolves.toBeUndefined();
    await expect(transport.getDTR(999, 0)).resolves.toBe(false);
    await expect(transport.getRTS(999, 0)).resolves.toBe(false);
    await expect(transport.getCD(999, 0)).resolves.toBe(false);
    await expect(transport.getCTS(999, 0)).resolves.toBe(false);
    await expect(transport.getRI(999, 0)).resolves.toBe(false);
    await expect(transport.getDSR(999, 0)).resolves.toBe(false);
    await expect(transport.getControlLines(999, 0)).resolves.toEqual([]);
    await expect(transport.getFlowControl(999, 0)).resolves.toBe('NONE');
    await expect(transport.getSerial(999, 0)).resolves.toBe('');
    expect(transport.isOpen(999, 0)).toBe(false);
  });

  it('removing a detached or foreign device is a no-op', async () => {
    const t1 = new VirtualSerialTransport();
    const d1 = t1.addDevice(new EchoDevice(), {hasPermission: true});
    d1.detach();
    t1.removeDevice(d1);
    expect(t1.devices).toHaveLength(0);

    const t2 = new VirtualSerialTransport();
    const foreign = t2.addDevice(new EchoDevice(), {hasPermission: true});
    t1.removeDevice(foreign);
    expect(t1.devices).toHaveLength(0);
  });

  it('loseDevice on a closed device skips error emission', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const onError = jest.fn();
    transport.onError(onError);

    device.loseDevice();
    expect(onError).not.toHaveBeenCalled();
  });

  it('setDTR does not loop back when loopbackSignals is disabled', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {
      hasPermission: true,
      loopbackSignals: false,
    });
    const {deviceId: id, portNumber: p} = device;

    await transport.open(id, p, {baudRate: 9600});
    await transport.setDTR(id, p, true);

    await expect(transport.getDSR(id, p)).resolves.toBe(false);
    await expect(transport.getCD(id, p)).resolves.toBe(false);
  });

  it('rejects picker when selected target is no longer a candidate', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    device.detach();
    transport.selectNextPort(device);

    await expect(transport.showPortPicker([])).rejects.toThrow('No port selected');
  });

  it('accepts picker when selected target is still a candidate', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});

    transport.selectNextPort(device);
    await expect(transport.showPortPicker([])).resolves.toMatchObject({
      usbVendorId: device.usbVendorId,
      usbProductId: device.usbProductId,
      portNumber: device.portNumber,
    });
  });

  it('uses RTS/CTS threshold when hardware flow control is enabled', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {
      hasPermission: true,
      flowControlThreshold: 3,
    });
    const {deviceId: id, portNumber: p} = device;

    await transport.open(id, p, {baudRate: 9600});
    await transport.setFlowControl(id, p, 'RTS_CTS');

    await expect(transport.getCTS(id, p)).resolves.toBe(true);
    await transport.write(id, p, [1, 2, 3]);
    await expect(transport.getCTS(id, p)).resolves.toBe(false);
  });
});

describe('VirtualSerialTransport: delivery and helper methods', () => {
  it('delivers push()/emitError() via microtasks and applies byte masking', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seenData: number[][] = [];
    const seenErrors: Array<{message: string; name?: string}> = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seenData.push(e.data);
    });
    transport.onError(e => {
      if (e.deviceId === id && e.portNumber === p) {
        seenErrors.push({message: e.error, name: e.errorName});
      }
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);

    device.push([257, -1]);
    device.emitError('manual', 'BreakError');
    await Promise.resolve();

    expect(seenData).toEqual([[1, 255]]);
    expect(seenErrors).toEqual([{message: 'manual', name: 'BreakError'}]);
  });

  it('enforces overrunAfter limit and drops subsequent bytes after overflow', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seenData: number[][] = [];
    const seenErrors: string[] = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seenData.push(e.data);
    });
    transport.onError(e => {
      if (e.deviceId === id && e.portNumber === p) seenErrors.push(e.error);
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);

    expect(device.overrunAfter(3)).toBe(device);
    device.push([10, 11, 12, 13, 14]);
    await Promise.resolve();

    device.push([15, 16]);
    await Promise.resolve();

    expect(seenData).toEqual([[10, 11, 12]]);
    expect(seenErrors).toEqual(['Receive buffer overrun']);
  });

  it('emits only overrun error when remaining capacity is zero', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seenData: number[][] = [];
    const seenErrors: string[] = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seenData.push(e.data);
    });
    transport.onError(e => {
      if (e.deviceId === id && e.portNumber === p) seenErrors.push(e.error);
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);

    device.overrunAfter(0);
    device.push([1]);
    await Promise.resolve();

    expect(seenData).toEqual([]);
    expect(seenErrors).toEqual(['Receive buffer overrun']);
  });

  it('includes RI when control lines are asserted directly on input', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;

    device.setInputSignals({ri: true});
    await transport.open(id, p, {baudRate: 9600});

    await expect(transport.getControlLines(id, p)).resolves.toContain('RI');
  });

  it('schedules onData via timeout when latency is enabled', async () => {
    const transport = new VirtualSerialTransport({latencyMs: 1});
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seen: number[][] = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seen.push(e.data);
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);
    device.push([7]);

    await new Promise(r => setTimeout(r, 5));
    expect(seen).toEqual([[7]]);
  });

  it('splits incoming data into chunked onData events', async () => {
    const transport = new VirtualSerialTransport({chunkSize: 2});
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seen: number[][] = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seen.push(e.data);
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);
    device.push([1, 2, 3, 4, 5]);
    await Promise.resolve();

    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('routes SerialDevice send/raiseError through the host bridge', async () => {
    class BridgeDevice extends SerialDevice {
      readonly usbVendorId = 0x20;
      readonly usbProductId = 0x30;
      onData(): void {
        this.send([300]);
        this.raiseError('bridge error', 'ParityError');
      }
    }

    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new BridgeDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seenData: number[][] = [];
    const seenErrors: string[] = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seenData.push(e.data);
    });
    transport.onError(e => {
      if (e.deviceId === id && e.portNumber === p) seenErrors.push(e.error);
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);
    await transport.write(id, p, [1]);
    await Promise.resolve();

    expect(seenData).toEqual([[44]]);
    expect(seenErrors).toEqual(['bridge error']);
  });

  it('loseDevice emits disconnect and closes read/open state', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const disconnects: number[] = [];

    transport.onDisconnect(e => disconnects.push(e.deviceId));

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);

    device.loseDevice();

    expect(device.attached).toBe(false);
    expect(device.isOpen).toBe(false);
    expect(device.reading).toBe(false);
    expect(disconnects).toContain(id);
  });

  it('tracks delivered byte count when overrun limit is not exceeded', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    const {deviceId: id, portNumber: p} = device;
    const seenData: number[][] = [];

    transport.onData(e => {
      if (e.deviceId === id && e.portNumber === p) seenData.push(e.data);
    });

    await transport.open(id, p, {baudRate: 9600});
    await transport.startReading(id, p);

    device.overrunAfter(5);
    device.push([1, 2, 3]);
    await Promise.resolve();

    expect(device._rxDelivered).toBe(3);
    expect(device._overran).toBe(false);
    expect(seenData).toEqual([[1, 2, 3]]);
  });

  it('exposes host isOpen getter to bound devices', async () => {
    class BindProbe extends SerialDevice {
      readonly usbVendorId = 0x41;
      readonly usbProductId = 0x42;
      hostRef?: {isOpen: boolean};
      _bind(host: {
        deviceId: number;
        portNumber: number;
        isOpen: boolean;
        openOptions:
          | {baudRate: number; dataBits: number; stopBits: number; parity: number}
          | null;
        send(bytes: number[]): void;
        raiseError(message: string, name?: string): void;
        setSignals(signals: Record<string, boolean>): void;
      }): void {
        this.hostRef = host;
        super._bind(host as never);
      }
    }

    const transport = new VirtualSerialTransport();
    const probe = new BindProbe();
    const device = transport.addDevice(probe, {hasPermission: true});

    expect(probe.hostRef?.isOpen).toBe(false);
    await transport.open(device.deviceId, device.portNumber, {baudRate: 9600});
    expect(probe.hostRef?.isOpen).toBe(true);
  });
});
