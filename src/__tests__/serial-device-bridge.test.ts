/**
 * Tests for exposing an in-memory {@link SerialDevice} simulator over the
 * WebSocket bridge: the `serialDeviceToSerialLike` adapter and the
 * `exposeSerialDevice` server wrapper (driven with `ws`/socket fakes).
 */
import {describe, expect, it} from '@jest/globals';
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
    // No WebSocketServer option → exposeSerialDevice calls module.require('ws').
    // ws IS installed as a dev dep, so this succeeds in the Jest/Node process.
    const ex = exposeSerialDevice(new EchoDevice(FTDI), {port: 47199});
    expect(ex.url).toBe('ws://localhost:47199');
    await ex.close();
  });
});
