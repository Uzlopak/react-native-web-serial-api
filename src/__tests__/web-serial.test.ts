/**
 * Direct unit tests for the Serial/SerialPort polyfill, driven entirely through
 * an injected VirtualSerialTransport (no native module, no NativeModules mocks).
 * These complement the shared conformance suite with finer-grained assertions.
 */
import {describe, expect, it, jest} from '@jest/globals';
import type {Event} from '../lib/event-target';
import {
  EchoDevice,
  type SerialDevice,
  SilentDevice,
} from '../testing/serial-device';
import {VirtualSerialTransport} from '../testing/virtual-serial';
import type {SerialTransport} from '../transport';
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

  it('forget() closes an open port before marking it forgotten', async () => {
    const {serial} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();

    await port.open({baudRate: 9600});
    expect(port.connected).toBe(true);
    expect(port.readable).not.toBeNull();
    expect(port.writable).not.toBeNull();

    await port.forget();

    expect(port.connected).toBe(false);
    expect(port.readable).toBeNull();
    expect(port.writable).toBeNull();

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
    await expect(port.close()).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('rejects zero bufferSize', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(port.open({baudRate: 9600, bufferSize: 0})).rejects.toThrow(
      'bufferSize must be a positive, non-zero value.',
    );
  });

  it('rejects negative baudRate and negative bufferSize', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(port.open({baudRate: -1})).rejects.toThrow(
      'baudRate must be a positive, non-zero value.',
    );
    await expect(port.open({baudRate: 9600, bufferSize: -1})).rejects.toThrow(
      'bufferSize must be a positive, non-zero value.',
    );
  });

  it('rejects non-finite baudRate and non-finite bufferSize', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(port.open({baudRate: Number.NaN})).rejects.toThrow(
      'baudRate must be a positive, non-zero value.',
    );
    await expect(
      port.open({baudRate: Number.POSITIVE_INFINITY}),
    ).rejects.toThrow('baudRate must be a positive, non-zero value.');
    await expect(
      port.open({baudRate: 9600, bufferSize: Number.NaN}),
    ).rejects.toThrow('bufferSize must be a positive, non-zero value.');
    await expect(
      port.open({baudRate: 9600, bufferSize: Number.POSITIVE_INFINITY}),
    ).rejects.toThrow('bufferSize must be a positive, non-zero value.');
  });

  it('rejects invalid parity values', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(
      port.open({baudRate: 9600, parity: 'mark' as unknown as 'none'}),
    ).rejects.toThrow('parity must be one of: none, even, odd.');
  });

  it('rejects invalid flowControl values', async () => {
    const {serial} = setup();
    const [port] = await serial.getPorts();

    await expect(
      port.open({baudRate: 9600, flowControl: 'software' as never}),
    ).rejects.toThrow('flowControl must be one of: none, hardware.');
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

  it('wraps flow-control setup failures and remains re-openable afterwards', async () => {
    const {serial, transport} = setup();
    const [port] = await serial.getPorts();

    jest
      .spyOn(transport, 'setFlowControl')
      .mockRejectedValueOnce(new Error('flow-control failed'));

    await expect(
      port.open({baudRate: 9600, flowControl: 'hardware'}),
    ).rejects.toMatchObject({name: 'NetworkError'});

    await expect(port.open({baudRate: 9600})).resolves.toBeUndefined();
    await port.close();
  });

  it('wraps startReading failures and remains re-openable afterwards', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();

    device.failNext('startReading');

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'NetworkError',
    });

    await expect(port.open({baudRate: 9600})).resolves.toBeUndefined();
    await port.close();
  });

  it('does not revive a port if forget() is called while open() is in flight', async () => {
    const {serial, transport} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();

    let releaseOpen: () => void = () => {
      throw new Error('open gate resolver not initialized');
    };
    const openGate = new Promise<void>(resolve => {
      releaseOpen = () => resolve();
    });

    const realOpen = transport.open.bind(transport);
    jest.spyOn(transport, 'open').mockImplementationOnce(async (...args) => {
      await openGate;
      return realOpen(...args);
    });

    const opening = port.open({baudRate: 9600});
    await Promise.resolve(); // let open() enter the "opening" state

    await port.forget();
    releaseOpen();

    await expect(opening).rejects.toMatchObject({name: 'InvalidStateError'});
    expect(port.connected).toBe(false);
    expect(port.readable).toBeNull();
    expect(port.writable).toBeNull();

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('does not revive a port if forget() is called while close() is in flight', async () => {
    const {serial} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();

    await port.open({baudRate: 9600});
    const readable = port.readable!;
    const writable = port.writable!;
    const reader = readable.getReader();
    const writer = writable.getWriter();

    const closing = port.close();
    await Promise.resolve(); // let close() move into "closing"

    await port.forget();

    // Unblock close() so it can complete after forget().
    reader.releaseLock();
    writer.releaseLock();
    await readable.cancel().catch(() => {});
    await writable.abort().catch(() => {});
    await closing;

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('throws NetworkError when state changes during open() for non-forget reasons', async () => {
    const {serial, transport, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();

    jest.spyOn(transport, 'startReading').mockImplementationOnce(async () => {
      // Simulate a detach while open() is still in flight. This transitions
      // the port away from "opening" without going through forget().
      device.detach();
    });

    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'NetworkError',
      message: expect.stringContaining('state changed while opening'),
    });

    expect(port.connected).toBe(false);
    expect(port.readable).toBeNull();
    expect(port.writable).toBeNull();
  });

  it('keeps forgotten state when startReading fails after forget() during open()', async () => {
    const {serial, transport} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();

    let releaseStartReading: () => void = () => {
      throw new Error('startReading gate resolver not initialized');
    };
    const startReadingGate = new Promise<void>(resolve => {
      releaseStartReading = () => resolve();
    });

    jest.spyOn(transport, 'startReading').mockImplementationOnce(async () => {
      await startReadingGate;
      throw new Error('startReading failed after forget');
    });

    const opening = port.open({baudRate: 9600});
    await Promise.resolve(); // let open() enter the "opening" state

    await port.forget();
    releaseStartReading();

    await expect(opening).rejects.toMatchObject({name: 'NetworkError'});
    await expect(port.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
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

    await expect(port.setSignals({requestToSend: true})).rejects.toMatchObject({
      name: 'NetworkError',
    });

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

    jest
      .spyOn(transport, 'purgeHwBuffers')
      .mockRejectedValueOnce(new Error('purge failed'));

    await expect(port.readable!.cancel()).resolves.toBeUndefined();
    await port.close();
  });

  it('swallows purge errors during writable abort', async () => {
    const {serial, transport} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    jest
      .spyOn(transport, 'purgeHwBuffers')
      .mockRejectedValueOnce(new Error('purge failed'));

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
    const a = transport.addDevice(new SilentDevice(FTDI), {
      hasPermission: true,
    });
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
    let seenEvent: Event | undefined;
    const onconnect = jest.fn();
    serial.onconnect = event => {
      seenEvent = event as unknown as Event;
      onconnect(event);
    };
    transport.detach(device);
    transport.attach(device);
    expect(onconnect).toHaveBeenCalledTimes(1);
    expect(seenEvent?.type).toBe('connect');
    expect(seenEvent?.target).toBe(serial);
  });

  it('fires the ondisconnect property handler when a device is detached', () => {
    const {serial, transport, device} = setup();
    let seenEvent: Event | undefined;
    const ondisconnect = jest.fn();
    serial.ondisconnect = event => {
      seenEvent = event as unknown as Event;
      ondisconnect(event);
    };
    transport.detach(device);
    expect(ondisconnect).toHaveBeenCalledTimes(1);
    expect(seenEvent?.type).toBe('disconnect');
    expect(seenEvent?.target).toBe(serial);
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
    const first = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    transport.addDevice(
      new EchoDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
      {
        hasPermission: true,
      },
    );

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

  it('does not remap an ambiguous attach when multiple disconnected ports share VID/PID', async () => {
    const transport = new VirtualSerialTransport();
    const a = transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    const b = transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    const serial = new Serial(transport);
    const ports = await serial.getPorts();
    expect(ports).toHaveLength(2);

    const portConnectA = jest.fn();
    const portConnectB = jest.fn();
    const serialConnect = jest.fn();
    ports[0].addEventListener('connect', portConnectA);
    ports[1].addEventListener('connect', portConnectB);
    serial.onconnect = serialConnect;

    a.detach();
    b.detach();
    portConnectA.mockClear();
    portConnectB.mockClear();
    serialConnect.mockClear();

    a.attach();

    expect(portConnectA).not.toHaveBeenCalled();
    expect(portConnectB).not.toHaveBeenCalled();
    expect(serialConnect).toHaveBeenCalledTimes(1);
  });

  it('does not remap forgotten ports on attach, and surfaces serial-level connect', async () => {
    const {serial, transport, device} = setup();
    const [port] = await serial.getPorts();

    const portConnect = jest.fn();
    const serialConnect = jest.fn();
    port.onconnect = portConnect;
    serial.onconnect = serialConnect;

    await port.forget();
    transport.detach(device);
    portConnect.mockClear();
    serialConnect.mockClear();

    transport.attach(device);

    expect(portConnect).not.toHaveBeenCalled();
    expect(serialConnect).toHaveBeenCalledTimes(1);

    const [reacquired] = await serial.getPorts();
    expect(reacquired).not.toBe(port);
  });

  it('bubbles connect to serial with target set to the known port', async () => {
    const {serial, transport, device} = setup();
    const [port] = await serial.getPorts();

    let seenEvent: Event | undefined;
    const onconnect = jest.fn();
    serial.onconnect = event => {
      seenEvent = event;
      onconnect(event);
    };

    transport.detach(device);
    transport.attach(device);

    expect(onconnect).toHaveBeenCalledTimes(1);
    expect(seenEvent?.type).toBe('connect');
    expect(seenEvent?.target).toBe(port);
  });

  it('bubbles disconnect to serial with target set to the known port', async () => {
    const {serial, transport, device} = setup();
    const [port] = await serial.getPorts();

    let seenEvent: Event | undefined;
    const ondisconnect = jest.fn();
    serial.ondisconnect = event => {
      seenEvent = event;
      ondisconnect(event);
    };

    transport.detach(device);

    expect(ondisconnect).toHaveBeenCalledTimes(1);
    expect(seenEvent?.type).toBe('disconnect');
    expect(seenEvent?.target).toBe(port);
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
        filters: [
          {bluetoothServiceClassId: 0x1101, usbVendorId: FTDI.usbVendorId},
        ],
      }),
    ).rejects.toThrow(
      'A filter cannot specify both bluetoothServiceClassId and usbVendorId.',
    );
  });

  it('rejects invalid bluetooth + usbProductId filter combinations', async () => {
    const {serial} = setup();

    await expect(
      serial.requestPort({
        filters: [
          {bluetoothServiceClassId: 0x1101, usbProductId: FTDI.usbProductId},
        ],
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

  it('rejects an empty filter object', async () => {
    const {serial} = setup();

    await expect(serial.requestPort({filters: [{}]})).rejects.toThrow(
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

  it('rejects allowedBluetoothServiceClassIds in Android USB mode', async () => {
    const {serial} = setup();

    await expect(
      serial.requestPort({allowedBluetoothServiceClassIds: [0x1101]}),
    ).rejects.toThrow(
      'allowedBluetoothServiceClassIds is not supported in Android USB mode.',
    );
  });

  it('reuses an existing known port when the same port is picked again', async () => {
    const {serial} = setup();
    const first = await serial.requestPort();
    const second = await serial.requestPort();

    expect(second).toBe(first);
  });

  it('returns a fresh openable port after the previous instance was forgotten', async () => {
    const {serial} = setup();
    const first = await serial.requestPort();

    await first.forget();
    await expect(first.open({baudRate: 9600})).rejects.toMatchObject({
      name: 'InvalidStateError',
    });

    const second = await serial.requestPort();
    expect(second).not.toBe(first);

    await expect(second.open({baudRate: 9600})).resolves.toBeUndefined();
    await second.close();
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

describe('SerialPort review-hardening fixes', () => {
  it('does not drop inbound data sent before readable is first accessed', async () => {
    const {serial, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    // The device transmits immediately on open, before the app has touched
    // port.readable. When the read subscription is only wired on the first
    // readable access, these bytes are dropped on the floor; they must instead
    // be buffered and delivered to the eventual reader.
    device.push([0xde, 0xad, 0xbe, 0xef]);

    // Let the transport actually dispatch the inbound data BEFORE port.readable
    // is ever accessed — reproducing the real native race where data events
    // fire between open() resolving and the first readable access.
    await new Promise(resolve => setTimeout(resolve, 0));

    const reader = port.readable!.getReader();
    const {value} = await reader.read();
    expect(value ? Array.from(value) : []).toEqual([0xde, 0xad, 0xbe, 0xef]);
    reader.releaseLock();

    await port.close();
  });

  it('scales the native write timeout with payload size and baud rate', async () => {
    const {serial, transport} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    const writeSpy = jest.spyOn(transport, 'write');
    const writer = port.writable!.getWriter();

    await writer.write(new Uint8Array([1, 2, 3]));
    const smallTimeout = writeSpy.mock.calls[0][3] as number;
    expect(typeof smallTimeout).toBe('number');
    expect(smallTimeout).toBeGreaterThanOrEqual(2000);

    await writer.write(new Uint8Array(20000));
    const bigTimeout = writeSpy.mock.calls[1][3] as number;
    // 20 kB at 9600 baud (~21 s of line time) cannot drain within the 2 s
    // floor, so the computed timeout must grow well past the small-write one.
    expect(bigTimeout).toBeGreaterThan(smallTimeout);

    writer.releaseLock();
    await port.close();
  });

  it('writes any BufferSource chunk, not just Uint8Array', async () => {
    const {serial, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const writer = port.writable!.getWriter();

    // Per the Web Serial spec the writable accepts a BufferSource. A bare
    // ArrayBuffer and a DataView are valid chunks but are NOT array-like, so a
    // naive Array.from() would silently send zero bytes.
    const ab = new Uint8Array([1, 2, 3]).buffer;
    await writer.write(ab as unknown as Uint8Array);

    // DataView over a non-zero byteOffset slice -> bytes 9,8,7
    const dvBacking = new Uint8Array([0, 0, 9, 8, 7]);
    const dv = new DataView(dvBacking.buffer, 2, 3);
    await writer.write(dv as unknown as Uint8Array);

    // A typed-array view with a byteOffset must respect offset/length -> 4,5
    const sub = new Uint8Array([0, 0, 4, 5]).subarray(2);
    await writer.write(sub);

    writer.releaseLock();
    expect(device.written).toEqual([
      [1, 2, 3],
      [9, 8, 7],
      [4, 5],
    ]);
    await port.close();
  });

  it('remaps a reattached device and supports reopen + I/O on the new deviceId', async () => {
    const {serial, device} = setup(new EchoDevice(FTDI));
    const [port] = await serial.getPorts();
    const firstDeviceId = device.deviceId;
    await port.open({baudRate: 9600});

    // Echo works on the first physical connection.
    let writer = port.writable!.getWriter();
    let reader = port.readable!.getReader();
    await writer.write(Uint8Array.from([10, 20]));
    expect(Array.from((await reader.read()).value ?? [])).toEqual([10, 20]);
    writer.releaseLock();
    reader.releaseLock();

    // Unplug while open, then replug. Android assigns a brand-new deviceId on
    // re-attach; the polyfill must remap the same SerialPort onto it.
    device.loseDevice();
    await Promise.resolve();
    device.attach();
    await Promise.resolve();

    expect(device.deviceId).not.toBe(firstDeviceId);
    const [portAfter] = await serial.getPorts();
    expect(portAfter).toBe(port);
    expect(port.connected).toBe(false);

    // Reopen on the NEW deviceId and confirm I/O still flows end-to-end.
    await port.open({baudRate: 9600});
    writer = port.writable!.getWriter();
    reader = port.readable!.getReader();
    await writer.write(Uint8Array.from([30, 40]));
    expect(Array.from((await reader.read()).value ?? [])).toEqual([30, 40]);
    writer.releaseLock();
    reader.releaseLock();
    await port.close();
  });

  it('does not crash when inbound data races readable cancel()', async () => {
    const {serial, transport, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const reader = port.readable!.getReader();

    // Gate cancel()'s purgeHwBuffers so the stream is already closed but the
    // native data subscription is still attached — the window in which a late
    // data event would enqueue into an already-closed controller and throw.
    let releasePurge: (() => void) | undefined;
    jest.spyOn(transport, 'purgeHwBuffers').mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releasePurge = resolve;
        }),
    );

    const caught: unknown[] = [];
    const capture = (e: unknown) => {
      caught.push(e);
    };
    process.on('uncaughtException', capture);
    process.on('unhandledRejection', capture);
    try {
      const cancelPromise = reader.cancel();
      device.push([1, 2, 3]); // arrives while the stream is mid-cancel
      await new Promise(resolve => setTimeout(resolve, 0));
      releasePurge?.();
      await cancelPromise;
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      process.off('uncaughtException', capture);
      process.off('unhandledRejection', capture);
    }

    expect(caught).toEqual([]);
    await port.close();
  });

  it('re-acquires readable after cancel() and keeps receiving while open', async () => {
    const {serial, device} = setup(new SilentDevice(FTDI));
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});

    const reader1 = port.readable!.getReader();
    device.push([1, 1]);
    expect(Array.from((await reader1.read()).value ?? [])).toEqual([1, 1]);
    await reader1.cancel();
    reader1.releaseLock();

    // The port is still open, so a fresh readable must deliver later data
    // (and the stale subscription must not double-enqueue or throw).
    const readable2 = port.readable;
    expect(readable2).not.toBeNull();
    const reader2 = readable2!.getReader();
    device.push([2, 2]);
    expect(Array.from((await reader2.read()).value ?? [])).toEqual([2, 2]);
    reader2.releaseLock();

    await port.close();
  });
});
