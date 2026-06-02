/**
 * Direct unit tests for the Serial/SerialPort polyfill, driven entirely through
 * an injected VirtualSerialTransport (no native module, no NativeModules mocks).
 * These complement the shared conformance suite with finer-grained assertions.
 */
import {describe, expect, it, jest} from '@jest/globals';
import {
  EchoDevice,
  type SerialDevice,
  SilentDevice,
} from '../testing/serial-device';
import type {SerialTransport} from '../transport';
import {VirtualSerialTransport} from '../testing/virtual-serial';
import {Serial, SerialPort} from '../WebSerial';

const FTDI = {usbVendorId: 0x0403, usbProductId: 0x6001} as const;

function setup(device: SerialDevice = new EchoDevice(FTDI)) {
  const transport = new VirtualSerialTransport();
  const handle = transport.addDevice(device, {hasPermission: true});
  const serial = new Serial(transport);
  return {transport, device: handle, serial};
}

function setupBrokenSerial() {
  const broken = {
    onConnect: () => {
      throw new Error('init failed');
    },
  } as unknown as SerialTransport;
  return new Serial(broken);
}

describe('Serial.getPorts()', () => {
  it('returns SerialPort instances for permitted devices', async () => {
    const {serial} = setup();
    const ports = await serial.getPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toBeInstanceOf(SerialPort);
    expect(ports[0].getInfo()).toEqual({
      usbVendorId: FTDI.usbVendorId,
      usbProductId: FTDI.usbProductId,
    });
  });

  it('caches and reuses the same SerialPort instance across calls', async () => {
    const {serial} = setup();
    const [first] = await serial.getPorts();
    const [second] = await serial.getPorts();
    expect(second).toBe(first);
  });
});

describe('SerialPort.open()', () => {
  it('passes the resolved connection parameters down to the device', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();
    await port.open({
      baudRate: 19200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
    });
    expect(device.openOptions).toEqual({
      baudRate: 19200,
      dataBits: 7,
      stopBits: 2,
      parity: 2, // 'even' -> native parity code
    });
    await port.close();
  });

  it('enables hardware flow control when requested', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600, flowControl: 'hardware'});
    expect(device.flowControl).toBe('RTS_CTS');
    await port.close();
  });

  it('marks a port as forgotten', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await port.forget();

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('rejects zero bufferSize', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(
      port.open({baudRate: 9600, bufferSize: 0}),
    ).rejects.toThrow('bufferSize must be a positive, non-zero value.');
  });

  it('rejects invalid parity values', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(
      port.open({baudRate: 9600, parity: 'mark' as unknown as 'none'}),
    ).rejects.toThrow('parity must be one of: none, even, odd.');
  });

  it('wraps native open failures and remains re-openable afterwards', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();

    device.failNext('open');

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'NetworkError',
    });

    await expect(port.open({baudRate: 9600})).resolves.toBeUndefined();
    await port.close();
  });

  it('maps odd parity to native parity code', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();

    await port.open({baudRate: 9600, parity: 'odd'});

    expect(device.openOptions?.parity).toBe(1);
    await port.close();
  });
});

describe('SerialPort signals', () => {
  it('rejects setSignals with no members', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    await expect(port.setSignals({})).rejects.toThrow(
      'At least one signal must be specified.',
    );

    await port.close();
  });

  it('rejects setSignals when called with no argument', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    await expect(port.setSignals()).rejects.toThrow(
      'At least one signal must be specified.',
    );

    await port.close();
  });

  it('wraps transport errors from setSignals as NetworkError', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    device.failNext('setSignals');

    await expect(
      port.setSignals({requestToSend: true}),
    ).rejects.toMatchObject({name: 'NetworkError'});

    await port.close();
  });

  it('wraps transport errors from getSignals as NetworkError', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    device.failNext('getSignals');

    await expect(port.getSignals()).rejects.toMatchObject({
      name: 'NetworkError',
    });

    await port.close();
  });
});

describe('SerialPort streams', () => {
  it('reflects connected state across open and close', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    expect(port.connected).toBe(false);
    await port.open({baudRate: 9600});
    expect(port.connected).toBe(true);
    await port.close();
    expect(port.connected).toBe(false);
  });

  it('preserves byte order across multiple writes', async () => {
    const {serial, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const writer = port.writable!.getWriter();
    await writer.write(Uint8Array.from([1, 2]));
    await writer.write(Uint8Array.from([3]));
    await writer.write(Uint8Array.from([4, 5]));
    writer.releaseLock();
    expect(device.written.flat()).toEqual([1, 2, 3, 4, 5]);
    await port.close();
  });

  it('delivers device-pushed bytes to the readable stream', async () => {
    const {serial, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const reader = port.readable!.getReader();
    device.push([0xde, 0xad, 0xbe, 0xef]);
    const {value} = await reader.read();
    expect(Array.from(value ?? new Uint8Array())).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    reader.releaseLock();
    await port.close();
  });

  it('reuses readable and writable instances while open', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    const readable1 = port.readable;
    const readable2 = port.readable;
    const writable1 = port.writable;
    const writable2 = port.writable;

    expect(readable1).toBe(readable2);
    expect(writable1).toBe(writable2);
    await port.close();
  });

  it('swallows purge errors during readable cancel', async () => {
    const {serial, transport} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    jest.spyOn(transport, 'purgeHwBuffers').mockRejectedValueOnce(
      new Error('purge failed'),
    );

    await expect(port.readable!.cancel()).resolves.toBeUndefined();
    await port.close();
  });

  it('swallows purge errors during writable abort', async () => {
    const {serial, transport} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    jest.spyOn(transport, 'purgeHwBuffers').mockRejectedValueOnce(
      new Error('purge failed'),
    );

    await expect(port.writable!.abort()).resolves.toBeUndefined();
    await port.close();
  });

  it('runs writable close algorithm', async () => {
    const {serial} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    await expect(port.writable!.close()).resolves.toBeUndefined();
    await port.close();
  });

  it('ignores close() cancel/abort rejections from locked streams', async () => {
    const {serial} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    const readable = port.readable!;
    const writable = port.writable!;
    const reader = readable.getReader();
    const writer = writable.getWriter();

    const closing = port.close();

    // Unblock pending close by releasing locks and completing cancel/abort.
    reader.releaseLock();
    writer.releaseLock();
    await readable.cancel().catch(() => {});
    await writable.abort().catch(() => {});

    await expect(closing).resolves.toBeUndefined();
  });

  it('ignores non-matching data/error events for readable subscriptions', async () => {
    const transport = new VirtualSerialTransport();
    const a = transport.addDevice(new SilentDevice(FTDI), {hasPermission: true});
    const b = transport.addDevice(
      new SilentDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
      {hasPermission: true},
    );
    const serial = new Serial(transport);
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const reader = port.readable!.getReader();

    await transport.open(b.deviceId, b.portNumber, {baudRate: 9600});
    await transport.startReading(b.deviceId, b.portNumber);
    b.push([0x99]);
    b.emitError('other-device-error');
    await Promise.resolve();

    const pending = reader.read();
    a.push([0x42]);
    const got = await pending;

    expect(Array.from(got.value ?? new Uint8Array())).toEqual([0x42]);
    reader.releaseLock();
    await port.close();
  });

  it('wraps write transport failures as NetworkError and closes writable stream', async () => {
    const {serial, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const writer = port.writable!.getWriter();

    device.failNext('write');

    await expect(writer.write(Uint8Array.from([0xaa]))).rejects.toMatchObject({
      name: 'NetworkError',
    });

    writer.releaseLock();
    expect(port.writable).toBeNull();
    await port.close();
  });
});

describe('Serial connect/disconnect events', () => {
  it('fires the onconnect property handler when a device is (re)attached', () => {
    const {serial, transport, device} = setup();
    const onconnect = jest.fn();
    serial.onconnect = onconnect;
    transport.detach(device);
    transport.attach(device);
    expect(onconnect).toHaveBeenCalled();
  });

  it('fires the ondisconnect property handler when a device is detached', () => {
    const {serial, transport, device} = setup();
    const ondisconnect = jest.fn();
    serial.ondisconnect = ondisconnect;
    transport.detach(device);
    expect(ondisconnect).toHaveBeenCalled();
  });

  it('replaces existing onconnect handler and supports clearing it', () => {
    const {serial, transport, device} = setup();
    const first = jest.fn();
    const second = jest.fn();

    serial.onconnect = first;
    expect(serial.onconnect).toBe(first);

    serial.onconnect = second;
    expect(serial.onconnect).toBe(second);

    transport.detach(device);
    transport.attach(device);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    serial.onconnect = null;
    expect(serial.onconnect).toBeNull();

    transport.detach(device);
    transport.attach(device);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('replaces existing ondisconnect handler and supports clearing it', () => {
    const {serial, transport, device} = setup();
    const first = jest.fn();
    const second = jest.fn();

    serial.ondisconnect = first;
    expect(serial.ondisconnect).toBe(first);

    serial.ondisconnect = second;
    expect(serial.ondisconnect).toBe(second);

    transport.detach(device);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    serial.ondisconnect = null;
    expect(serial.ondisconnect).toBeNull();

    transport.attach(device);
    transport.detach(device);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('dispatches serial-level connect/disconnect for unrelated devices', async () => {
    const transport = new VirtualSerialTransport();
    const first = transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    transport.addDevice(new EchoDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}), {
      hasPermission: true,
    });

    const serial = new Serial(transport);
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    const connectSpy = jest.fn();
    const disconnectSpy = jest.fn();
    serial.onconnect = connectSpy;
    serial.ondisconnect = disconnectSpy;

    const other = transport.devices.find(d => d.deviceId !== first.deviceId)!;
    other.detach();
    other.attach();

    expect(connectSpy).toHaveBeenCalled();
    expect(disconnectSpy).toHaveBeenCalled();
    await port.close();
  });

  it('treats same-VID but different-PID attach as unrelated connect', async () => {
    const transport = new VirtualSerialTransport();
    transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    const sibling = transport.addDevice(
      new EchoDevice({usbVendorId: FTDI.usbVendorId, usbProductId: 0x6015}),
      {hasPermission: true},
    );

    const serial = new Serial(transport);
    await serial.getPorts();
    const connectSpy = jest.fn();
    serial.onconnect = connectSpy;

    sibling.detach();
    sibling.attach();

    expect(connectSpy).toHaveBeenCalled();
  });

  it('fires serial-level connect when an attached brand-new identity has no known-port match', async () => {
    const transport = new VirtualSerialTransport();
    transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    const serial = new Serial(transport);
    await serial.getPorts();

    const connectSpy = jest.fn();
    serial.onconnect = connectSpy;

    const newcomer = transport.addDevice(
      new EchoDevice({usbVendorId: 0x1a86, usbProductId: 0x7523}),
      {hasPermission: true},
    );
    newcomer.detach();
    newcomer.attach();

    expect(connectSpy).toHaveBeenCalled();
  });
});

describe('SerialPort connect/disconnect event handlers', () => {
  it('replaces existing port onconnect handler and supports clearing it', async () => {
    const {serial, transport, device} = setup();
    const [port] = await serial.getPorts();
    const first = jest.fn();
    const second = jest.fn();

    port.onconnect = first;
    expect(port.onconnect).toBe(first);

    port.onconnect = second;
    expect(port.onconnect).toBe(second);

    transport.detach(device);
    transport.attach(device);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    port.onconnect = null;
    expect(port.onconnect).toBeNull();

    transport.detach(device);
    transport.attach(device);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('replaces existing port ondisconnect handler and supports clearing it', async () => {
    const {serial, transport, device} = setup();
    const [port] = await serial.getPorts();
    const first = jest.fn();
    const second = jest.fn();

    port.ondisconnect = first;
    expect(port.ondisconnect).toBe(first);

    port.ondisconnect = second;
    expect(port.ondisconnect).toBe(second);

    transport.detach(device);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    port.ondisconnect = null;
    expect(port.ondisconnect).toBeNull();

    transport.attach(device);
    transport.detach(device);

    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('Serial.requestPort()', () => {
  it('throws NotFoundError if transport initialization fails', async () => {
    const serial = setupBrokenSerial();

    await expect(serial.requestPort()).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('rejects invalid bluetooth + usbVendorId filter combinations', async () => {
    const {serial} = setup();

    await expect(
      serial.requestPort({
        filters: [{bluetoothServiceClassId: 0x1101, usbVendorId: FTDI.usbVendorId}],
      }),
    ).rejects.toThrow(
      'A filter cannot specify both bluetoothServiceClassId and usbVendorId.',
    );
  });

  it('rejects invalid bluetooth + usbProductId filter combinations', async () => {
    const {serial} = setup();

    await expect(
      serial.requestPort({
        filters: [{bluetoothServiceClassId: 0x1101, usbProductId: FTDI.usbProductId}],
      }),
    ).rejects.toThrow(
      'A filter cannot specify both bluetoothServiceClassId and usbProductId.',
    );
  });

  it('rejects a usbProductId filter without usbVendorId', async () => {
    const {serial} = setup();

    await expect(
      serial.requestPort({filters: [{usbProductId: FTDI.usbProductId}]}),
    ).rejects.toThrow(
      'A filter must specify usbVendorId if usbProductId is specified, or must not be empty.',
    );
  });

  it('passes only USB filters to the native picker', async () => {
    const {serial, transport} = setup();
    const pickerSpy = jest.spyOn(transport, 'showPortPicker');

    await serial.requestPort({
      filters: [
        {bluetoothServiceClassId: 0x1101},
        {usbVendorId: FTDI.usbVendorId, usbProductId: FTDI.usbProductId},
      ],
    });

    expect(pickerSpy).toHaveBeenCalledWith([
      {usbVendorId: FTDI.usbVendorId, usbProductId: FTDI.usbProductId},
    ]);
  });

  it('reuses an existing known port when the same port is picked again', async () => {
    const {serial} = setup();
    const first = await serial.requestPort();
    const second = await serial.requestPort();

    expect(second).toBe(first);
  });
});

describe('Serial initialization fallback', () => {
  it('returns an empty list from getPorts() if transport initialization fails', async () => {
    const serial = setupBrokenSerial();

    await expect(serial.getPorts()).resolves.toEqual([]);
  });

  it('returns empty info when a SerialPort has no usb identifiers', () => {
    const transport = new VirtualSerialTransport();
    const fake = new SerialPort(
      transport,
      1,
      0,
      undefined as unknown as number,
      undefined as unknown as number,
    );
    expect(fake.getInfo()).toEqual({});
  });
});
