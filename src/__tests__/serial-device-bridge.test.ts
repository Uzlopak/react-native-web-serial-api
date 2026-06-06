/**
 * Tests for exposing an in-memory {@link SerialDevice} simulator over the
 * WebSocket bridge: the `serialDeviceToSerialLike` adapter and the
 * `exposeSerialDevice` server wrapper (driven with `ws`/socket fakes).
 */
import {describe, expect, it, jest} from '@jest/globals';
import {
  EchoDevice,
  exposeSerialDevice,
  LineDevice,
  VirtualSerialTransport,
  type WebSocketServerLike,
} from '../testing';
import type {WsLike} from '../websocket';
import {
  attachBridge,
  portInfoFromDevice,
  serialDeviceToSerialLike,
} from '../websocket';

const FTDI = {usbVendorId: 0x0403, usbProductId: 0x6001} as const;
const flush = () => new Promise<void>(r => setTimeout(r, 0));

/** A `ws`-like socket that records frames and lets the test inject messages. */
class FakeWs implements WsLike {
  readonly sent: Array<string | Uint8Array> = [];
  readonly #listeners: Record<string, Array<(...a: never[]) => void>> = {};

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  on(event: string, listener: (...a: never[]) => void): void {
    this.#listeners[event] ??= [];
    this.#listeners[event].push(listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.#listeners[event] ?? []) {
      (l as (...a: unknown[]) => void)(...args);
    }
  }
  recvBinary(bytes: number[]): void {
    this.emit('message', Uint8Array.from(bytes), true);
  }
  recvCommand(message: object): void {
    this.emit('message', JSON.stringify(message), false);
  }
  responses(): Array<Record<string, unknown>> {
    return this.sent
      .filter((f): f is string => typeof f === 'string')
      .map(f => JSON.parse(f));
  }
  binary(): Uint8Array[] {
    return this.sent.filter((f): f is Uint8Array => f instanceof Uint8Array);
  }
}

/** The app's open handshake: set the line coding, then start reading. */
async function openFromApp(ws: FakeWs, baudRate = 115200): Promise<void> {
  ws.recvCommand({
    type: 'command',
    id: 1,
    command: 'setLineCoding',
    args: {baudRate},
  });
  ws.recvCommand({type: 'command', id: 2, command: 'startReading'});
  await flush();
}

describe('serialDeviceToSerialLike', () => {
  it('pipes app writes into the device and the device reply back out', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws, {
      portInfo: portInfoFromDevice(device),
    });

    await openFromApp(ws);
    ws.recvBinary([1, 2, 3, 4]); // app writes; EchoDevice echoes
    await flush();

    expect(ws.binary()).toHaveLength(1);
    expect(Array.from(ws.binary()[0])).toEqual([1, 2, 3, 4]);
  });

  it('answers getPortInfo with the device identity', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(
      new EchoDevice({usbVendorId: 0x2341, usbProductId: 0x0043}),
      {hasPermission: true, serialNumber: 'SN-9'},
    );
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws, {
      portInfo: portInfoFromDevice(device),
    });

    ws.recvCommand({type: 'command', id: 7, command: 'getPortInfo'});
    await flush();

    const reply = ws.responses().find(r => r.id === 7);
    expect(reply?.result).toMatchObject({
      usbVendorId: 0x2341,
      usbProductId: 0x0043,
      serialNumber: 'SN-9',
    });
  });

  it('routes setSignals to the device and reflects them via getSignals', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    ws.recvCommand({
      type: 'command',
      id: 3,
      command: 'setSignals',
      args: {dtr: true, rts: true},
    });
    await flush();
    ws.recvCommand({type: 'command', id: 4, command: 'getSignals'});
    await flush();

    const signals = ws.responses().find(r => r.id === 4)?.result as Record<
      string,
      boolean
    >;
    // Loopback wiring: DTR→DSR+DCD, RTS→CTS.
    expect(signals).toMatchObject({dsr: true, dcd: true, cts: true});
  });

  it('delivers a device-driven push to the connected app', async () => {
    // A device the test drives unprompted (e.g. a sensor reading).
    class Sensor extends LineDevice {
      readonly usbVendorId = FTDI.usbVendorId;
      readonly usbProductId = FTDI.usbProductId;
      onLine(): void {}
      report(text: string): void {
        this.send(text);
      }
    }
    const transport = new VirtualSerialTransport();
    const sensor = new Sensor();
    const device = transport.addDevice(sensor, {hasPermission: true});
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    sensor.report('hi\n'); // driven by the test, not a reply to a write
    await flush();

    expect(ws.binary().map(b => Array.from(b))).toContainEqual([
      ...Buffer.from('hi\n'),
    ]);
  });

  it('ensureOpen calls setParameters (not open again) when device is already open', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws); // device is now open (setLineCoding + startReading)

    // setBaudRate → update() → ensureOpen() → device.isOpen=true → setParameters (lines 73-74)
    ws.recvCommand({
      type: 'command',
      id: 3,
      command: 'setBaudRate',
      args: {baudRate: 9600},
    });
    await flush();

    const reply = ws.responses().find(r => r.id === 3);
    expect(reply?.error).toBeNull();
  });

  it('write error calls the bridge log callback', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    const log = jest.fn();
    attachBridge(serialDeviceToSerialLike(transport, device), ws, {log});
    await openFromApp(ws);

    device.failNext('write'); // makes transport.write() reject → line 94
    ws.recvBinary([1, 2]);
    await flush();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/write failed/));
  });

  it('set (setSignals) error propagates to the reply', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    device.failNext('setSignals'); // makes transport.setDTR() reject → set error cb line 107
    ws.recvCommand({
      type: 'command',
      id: 3,
      command: 'setSignals',
      args: {dtr: true},
    });
    await flush();

    const reply = ws.responses().find(r => r.id === 3);
    expect(reply?.error).toMatch(/setSignals failed/);
  });

  it('get (getSignals) error propagates to the reply', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    // getCD uses _consumeFail('getSignals') → Promise.all rejects → get error cb line 118
    device.failNext('getSignals');
    ws.recvCommand({type: 'command', id: 3, command: 'getSignals'});
    await flush();

    const reply = ws.responses().find(r => r.id === 3);
    expect(reply?.error).toMatch(/getSignals failed/);
  });

  it('update error (open fails) propagates to the reply', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);

    // Device is not yet open; open() will fail → ensureOpen throws → update error cb line 124
    device.failNext('open');
    ws.recvCommand({
      type: 'command',
      id: 1,
      command: 'setLineCoding',
      args: {baudRate: 115200},
    });
    await flush();

    const reply = ws.responses().find(r => r.id === 1);
    expect(reply?.error).toMatch(/open failed/);
  });

  it('close error propagates to the reply', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    device.failNext('close'); // makes transport.close() reject → close error cb line 139
    ws.recvCommand({type: 'command', id: 3, command: 'close'});
    await flush();

    const reply = ws.responses().find(r => r.id === 3);
    expect(reply?.error).toMatch(/close failed/);
  });

  it('invokes close listeners on a successful close', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    ws.recvCommand({type: 'command', id: 3, command: 'close'});
    await flush();

    const reply = ws.responses().find(r => r.id === 3);
    expect(reply?.error).toBeNull();
  });

  it('setSignals with only rts (no dtr) skips the dtr branch', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);
    await openFromApp(ws);

    ws.recvCommand({
      type: 'command',
      id: 3,
      command: 'setSignals',
      args: {rts: true}, // dtr not provided → opts.dtr === undefined → else branch
    });
    await flush();

    const reply = ws.responses().find(r => r.id === 3);
    expect(reply?.error).toBeNull();
  });

  it('on() with an unknown event name is a no-op', () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);
    const anySerial = serial as unknown as {
      on: (e: string, l: () => void) => void;
    };

    expect(() => anySerial.on('unknown_event', () => {})).not.toThrow();
  });

  it('removeListener() with an unknown event name is a no-op', () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);
    const anySerial = serial as unknown as {
      on: (e: string, l: () => void) => void;
      removeListener: (e: string, l: () => void) => void;
    };
    const listener = () => {};
    anySerial.on('unknown_event', listener);

    expect(() =>
      anySerial.removeListener('unknown_event', listener),
    ).not.toThrow();
  });

  it('ignores data events from a different device on the same transport', async () => {
    const transport = new VirtualSerialTransport();
    const d1 = transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    const d2 = transport.addDevice(
      new EchoDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
      {hasPermission: true},
    );
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, d1), ws1);
    attachBridge(serialDeviceToSerialLike(transport, d2), ws2);
    await openFromApp(ws1); // open d1
    await openFromApp(ws2); // open d2 (so push() will fire a DataEvent)

    const sentBefore = ws1.sent.length;
    d2.push([0xde, 0xad]); // fires DataEvent with d2.deviceId → filtered by line 56
    await flush();

    expect(ws1.sent).toHaveLength(sentBefore); // d1's bridge sees nothing
  });

  it('ignores error events from a different device on the same transport', async () => {
    const transport = new VirtualSerialTransport();
    const d1 = transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
    const d2 = transport.addDevice(
      new EchoDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
      {hasPermission: true},
    );
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, d1), ws);
    await openFromApp(ws);

    const sentBefore = ws.sent.length;
    d2.emitError('irrelevant error'); // fires ErrorEvent with d2.deviceId → filtered by line 61
    await flush();

    expect(ws.sent).toHaveLength(sentBefore); // d1's bridge sees nothing
  });
});

/** A fake `ws` server: hands the test the connection handler to drive. */
class FakeWebSocketServer implements WebSocketServerLike {
  static instances: FakeWebSocketServer[] = [];
  readonly options: {port: number; host?: string};
  #onConnection?: (socket: WsLike) => void;
  closed = false;

  constructor(options: {port: number; host?: string}) {
    this.options = options;
    FakeWebSocketServer.instances.push(this);
  }
  on(event: 'connection', listener: (socket: WsLike) => void): void {
    if (event === 'connection') this.#onConnection = listener;
  }
  connect(socket: WsLike): void {
    this.#onConnection?.(socket);
  }
  close(cb?: () => void): void {
    this.closed = true;
    cb?.();
  }
}

describe('exposeSerialDevice', () => {
  it('serves a typed simulator and resolves whenOpened on connect', async () => {
    FakeWebSocketServer.instances.length = 0;
    const ex = exposeSerialDevice(new EchoDevice(FTDI), {
      port: 8090,
      WebSocketServer: FakeWebSocketServer,
    });
    expect(ex.url).toBe('ws://localhost:8090');
    const server = FakeWebSocketServer.instances.at(-1) as FakeWebSocketServer;
    expect(server.options).toEqual({port: 8090, host: undefined});

    const ws = new FakeWs();
    const opened = ex.whenOpened();
    server.connect(ws);
    await openFromApp(ws);
    await expect(opened).resolves.toMatchObject({baudRate: 115200});

    ws.recvBinary([9, 8, 7]);
    await flush();
    expect(Array.from(ex.device.written.flat())).toEqual([9, 8, 7]);
    expect(Array.from(ws.binary()[0])).toEqual([9, 8, 7]); // echoed back

    await ex.close();
    expect(server.closed).toBe(true);
  });

  it('builds the URL with a custom host', () => {
    const ex = exposeSerialDevice(new EchoDevice(FTDI), {
      port: 8091,
      host: '0.0.0.0',
      WebSocketServer: FakeWebSocketServer,
    });
    expect(ex.url).toBe('ws://0.0.0.0:8091');
  });

  it('lazy-loads the ws package when WebSocketServer option is omitted', async () => {
    jest.resetModules();
    jest.doMock('ws', () => ({Server: FakeWebSocketServer}));
    let closePromise: Promise<void> | undefined;
    try {
      jest.isolateModules(() => {
        const {
          exposeSerialDevice: isolatedExposeSerialDevice,
        } = require('../testing/expose');
        FakeWebSocketServer.instances.length = 0;
        const ex = isolatedExposeSerialDevice(new EchoDevice(FTDI), {
          port: 47199,
        });
        expect(FakeWebSocketServer.instances).toHaveLength(1);
        expect(ex.url).toBe('ws://localhost:47199');
        closePromise = ex.close();
      });
      await closePromise;
    } finally {
      jest.dontMock('ws');
      jest.resetModules();
    }
  });

  it('falls back to ws.Server when WebSocketServer is absent', async () => {
    jest.resetModules();
    jest.doMock('ws', () => ({Server: FakeWebSocketServer}));
    let closePromise: Promise<void> | undefined;
    try {
      jest.isolateModules(() => {
        const {
          exposeSerialDevice: isolatedExposeSerialDevice,
        } = require('../testing/expose');
        FakeWebSocketServer.instances.length = 0;
        const ex = isolatedExposeSerialDevice(new EchoDevice(FTDI), {
          port: 47198,
        });
        expect(FakeWebSocketServer.instances).toHaveLength(1);
        expect(ex.url).toBe('ws://localhost:47198');
        closePromise = ex.close();
      });
      await closePromise;
    } finally {
      jest.dontMock('ws');
      jest.resetModules();
    }
  });

  it('throws when the ws package exports neither WebSocketServer nor Server', () => {
    jest.resetModules();
    jest.doMock('ws', () => ({}));
    try {
      jest.isolateModules(() => {
        const {
          exposeSerialDevice: isolatedExposeSerialDevice,
        } = require('../testing/expose');
        expect(() => {
          isolatedExposeSerialDevice(new EchoDevice(FTDI), {port: 47197});
        }).toThrow("the 'ws' package did not export a WebSocketServer.");
      });
    } finally {
      jest.dontMock('ws');
      jest.resetModules();
    }
  });

  it('whenClosed() resolves immediately when the device has never been opened', async () => {
    // Covers expose.ts line 140: whenClosed: () => device.whenClosed()
    // VirtualSerialDevice.whenClosed() returns Promise.resolve() when !isOpen (line 262)
    const ex = exposeSerialDevice(new EchoDevice(FTDI), {
      port: 47200,
      WebSocketServer: FakeWebSocketServer,
    });
    await expect(ex.whenClosed()).resolves.toBeUndefined();
    await ex.close();
  });
});
