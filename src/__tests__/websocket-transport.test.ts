/**
 * Tests for the client `WebSocketSerialTransport` over an in-memory fake
 * WebSocket, plus an end-to-end echo that drives the real `Serial`/`SerialPort`
 * polyfill through the transport and the bridge core (no sockets, no hardware).
 */
import {describe, expect, it, jest} from '@jest/globals';
import {Serial} from '../WebSerial';
import {attachBridge, type SerialLike, type WsLike} from '../websocket/bridge';
import type {InputSignals} from '../websocket/protocol';
import {
  type WebSocketCtor,
  type WebSocketLike,
  WebSocketSerialTransport,
} from '../websocket/WebSocketSerialTransport';

/** A fake WebSocket the transport constructs; the test drives the far end. */
class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  public url: string = '';

  binaryType = 'blob';
  readonly #listeners: Record<string, Array<(e: {data?: unknown}) => void>> =
    {};
  onSend?: (data: string | ArrayBufferLike | ArrayBufferView) => void;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(
    type: string,
    listener: (e: {data?: unknown}) => void,
  ): void {
    this.#listeners[type] ??= [];
    this.#listeners[type].push(listener);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.onSend?.(data);
  }
  close(): void {
    this.#fire('close');
  }
  #fire(type: string, event: {data?: unknown} = {}): void {
    for (const l of this.#listeners[type] ?? []) {
      l(event);
    }
  }
  fireOpen(): void {
    this.#fire('open');
  }
  fireClose(): void {
    this.#fire('close');
  }
  deliverText(text: string): void {
    this.#fire('message', {data: text});
  }
  deliverBinary(bytes: number[]): void {
    this.#fire('message', {data: Uint8Array.from(bytes).buffer});
  }
}

const toU8 = (d: string | ArrayBufferLike | ArrayBufferView): Uint8Array => {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) {
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  }
  return new Uint8Array(0);
};

/** Construct a transport whose fake socket auto-answers control commands. */
function mount(
  opts: {
    signals?: InputSignals;
    reconnect?: boolean;
    connectTimeoutMs?: number;
    portInfo?: {
      usbVendorId?: number;
      usbProductId?: number;
      serialNumber?: string;
    };
  } = {},
) {
  FakeWebSocket.instances = [];
  const transport = new WebSocketSerialTransport('ws://test', {
    WebSocket: FakeWebSocket as unknown as WebSocketCtor,
    reconnect: opts.reconnect,
    connectTimeoutMs: opts.connectTimeoutMs,
  });
  const ws = FakeWebSocket.instances[0];
  const commands: Array<{
    id: number;
    command: string;
    args?: Record<string, unknown>;
  }> = [];
  const binary: Uint8Array[] = [];
  ws.onSend = d => {
    if (typeof d === 'string') {
      const m = JSON.parse(d);
      if (m.type === 'command') {
        commands.push(m);
        const result =
          m.command === 'getSignals'
            ? (opts.signals ?? {cts: false, dsr: false, dcd: false, ri: false})
            : m.command === 'getPortInfo'
              ? (opts.portInfo ?? null)
              : null;
        ws.deliverText(
          JSON.stringify({type: 'response', id: m.id, error: null, result}),
        );
      }
    } else {
      binary.push(toU8(d));
    }
  };
  ws.fireOpen();
  return {transport, ws, commands, binary};
}

describe('WebSocketSerialTransport', () => {
  it('reports a single port once connected', async () => {
    const {transport} = mount();
    const ports = await transport.findAllDrivers();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({
      deviceId: 1,
      portNumber: 0,
      hasPermission: true,
    });
  });

  it('uses bridge metadata for vendor/product IDs and serial number', async () => {
    const {transport} = mount({
      portInfo: {
        usbVendorId: 0x0403,
        usbProductId: 0x6001,
        serialNumber: 'FTDI-1',
      },
    });
    const ports = await transport.findAllDrivers();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
    });
    await expect(transport.getSerial(1, 0)).resolves.toBe('FTDI-1');
  });

  it('returns no devices when the websocket endpoint is unreachable', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://down', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: true,
      connectTimeoutMs: 5,
    });
    const ports = await transport.findAllDrivers();
    expect(ports).toEqual([]);
  });

  it('open() sends setLineCoding with the parity mapped to a string', async () => {
    const {transport, commands} = mount();
    await transport.open(1, 0, {baudRate: 115200, dataBits: 8, parity: 1});
    const cmd = commands.find(c => c.command === 'setLineCoding');
    expect(cmd?.args).toMatchObject({
      baudRate: 115200,
      dataBits: 8,
      parity: 'odd',
    });
  });

  it('write() sends a binary frame', async () => {
    const {transport, binary} = mount();
    await transport.write(1, 0, [1, 2, 3]);
    expect(binary).toHaveLength(1);
    expect(Array.from(binary[0])).toEqual([1, 2, 3]);
  });

  it('routes incoming binary frames to onData', () => {
    const {transport, ws} = mount();
    const events: number[][] = [];
    transport.onData(e => events.push(e.data));
    ws.deliverBinary([4, 5, 6]);
    expect(events).toEqual([[4, 5, 6]]);
  });

  it('round-trips signals (setDTR/getDTR, getSignals)', async () => {
    const {transport} = mount({
      signals: {cts: true, dsr: false, dcd: true, ri: false},
    });
    await transport.setDTR(1, 0, true);
    expect(await transport.getDTR(1, 0)).toBe(true);
    expect(await transport.getCTS(1, 0)).toBe(true);
    expect(await transport.getCD(1, 0)).toBe(true);
    expect(await transport.getDSR(1, 0)).toBe(false);
  });

  it('emits disconnect when the WebSocket closes', () => {
    const {transport, ws} = mount({reconnect: false});
    const onDisconnect = jest.fn();
    transport.onDisconnect(onDisconnect);
    ws.fireClose();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

// ── reconnection / resilience ────────────────────────────────────────────────

/** Wire a fake socket to auto-answer control commands (one per reconnect). */
function autoAnswer(
  ws: FakeWebSocket,
  opts: {
    signals?: InputSignals;
    portInfo?: {
      usbVendorId?: number;
      usbProductId?: number;
      serialNumber?: string;
    };
  } = {},
) {
  const commands: Array<{
    id: number;
    command: string;
    args?: Record<string, unknown>;
  }> = [];
  const binary: Uint8Array[] = [];
  ws.onSend = d => {
    if (typeof d === 'string') {
      const m = JSON.parse(d);
      if (m.type === 'command') {
        commands.push(m);
        const result =
          m.command === 'getSignals'
            ? (opts.signals ?? {cts: false, dsr: false, dcd: false, ri: false})
            : m.command === 'getPortInfo'
              ? (opts.portInfo ?? null)
              : null;
        ws.deliverText(
          JSON.stringify({type: 'response', id: m.id, error: null, result}),
        );
      }
    } else {
      binary.push(toU8(d));
    }
  };
  return {commands, binary};
}

/** Let pending microtasks + a `setTimeout(0)` (e.g. the reconnect backoff) run. */
const tick = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

describe('WebSocketSerialTransport — reconnection', () => {
  it('reconnects transparently after a drop and restores the open session', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();

    // Establish session state that must survive a reconnect.
    await transport.open(1, 0, {baudRate: 115200, dataBits: 8, parity: 1});
    await transport.startReading(1, 0);
    await transport.setDTR(1, 0, true);

    const onDisconnect = jest.fn();
    transport.onDisconnect(onDisconnect);

    // Unexpected drop — must NOT surface as a serial disconnect.
    ws1.fireClose();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(transport.connectionState).toBe('reconnecting');

    // The backoff timer fires and opens a fresh socket.
    await tick();
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeTruthy();
    const a2 = autoAnswer(ws2);
    ws2.fireOpen();
    await tick(); // flush the restore-session command chain

    expect(transport.connectionState).toBe('open');
    const restored = a2.commands.map(c => c.command);
    expect(restored).toEqual(
      expect.arrayContaining(['setLineCoding', 'setSignals', 'startReading']),
    );
    expect(
      a2.commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      baudRate: 115200,
      parity: 'odd',
    });
    expect(
      a2.commands.find(c => c.command === 'setSignals')?.args,
    ).toMatchObject({
      dtr: true,
    });

    // I/O works again on the new socket.
    await transport.write(1, 0, [9]);
    expect(a2.binary.map(b => Array.from(b))).toContainEqual([9]);
    expect(onDisconnect).not.toHaveBeenCalled();

    transport.disconnect();
  });

  it('queues a write during the gap and flushes it after reconnecting', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();
    await transport.open(1, 0, {baudRate: 9600});

    ws1.fireClose(); // drop while "connected"
    const write = transport.write(1, 0, [0xaa]); // issued while reconnecting

    await tick();
    const ws2 = FakeWebSocket.instances[1];
    const a2 = autoAnswer(ws2);
    ws2.fireOpen();
    await write; // resolves once the reconnection is up

    expect(a2.binary.map(b => Array.from(b))).toContainEqual([0xaa]);
    transport.disconnect();
  });

  it('gives up and disconnects once the reconnect budget is exhausted', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
      maxReconnectAttempts: 1,
    });
    const onDisconnect = jest.fn();
    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();
    transport.onDisconnect(onDisconnect);

    ws1.fireClose(); // schedules the one allowed retry
    await tick();
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeTruthy();
    ws2.fireClose(); // budget exhausted -> terminal disconnect

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(transport.connectionState).toBe('closed');
  });

  it('releases the socket on close() and reconnects on the next open()', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();
    await transport.open(1, 0, {baudRate: 115200});
    expect(transport.connectionState).toBe('open');

    // close() drops the socket (ends the bridge session) and does NOT auto-reconnect.
    await transport.close(1, 0);
    expect(transport.connectionState).toBe('suspended');
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Reopening reconnects on demand and re-sends the line coding.
    const reopened = transport.open(1, 0, {baudRate: 9600});
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeTruthy();
    const a2 = autoAnswer(ws2);
    ws2.fireOpen();
    await reopened;

    expect(transport.connectionState).toBe('open');
    expect(
      a2.commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      baudRate: 9600,
    });
    transport.disconnect();
  });

  it('does not reconnect after an explicit disconnect()', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();

    transport.disconnect();
    await tick();

    expect(FakeWebSocket.instances).toHaveLength(1); // no new socket
    expect(transport.connectionState).toBe('closed');
  });
});

// ── end-to-end: Serial → WebSocketSerialTransport → bridge → echo serial ──────

/** Minimal echo serial for the bridge (writes come back as data). */
class EchoSerial implements SerialLike {
  readonly #l: Record<string, Array<(...a: never[]) => void>> = {};
  on(e: string, l: (...a: never[]) => void): void {
    this.#l[e] ??= [];
    this.#l[e].push(l);
  }
  removeListener(e: string, l: (...a: never[]) => void): void {
    this.#l[e] = (this.#l[e] ?? []).filter(x => x !== l);
  }
  #emit(e: string, ...a: unknown[]): void {
    for (const l of this.#l[e] ?? []) (l as (...a: unknown[]) => void)(...a);
  }
  write(data: Uint8Array, cb?: (err?: Error | null) => void): void {
    queueMicrotask(() => {
      this.#emit('data', data);
      cb?.(null);
    });
  }
  set(_o: object, cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }
  get(cb: (err: Error | null, s?: object) => void): void {
    cb(null, {cts: true, dsr: true, dcd: false, ri: false});
  }
  update(_o: object, cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }
  flush(cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }
  drain(cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }
  close(cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }
}

/** Wire the bridge core to the transport's fake socket. */
function wireBridge(clientWs: FakeWebSocket, serial: SerialLike): void {
  const handlers: Record<string, (...a: never[]) => void> = {};
  const serverWs: WsLike = {
    send: data => {
      if (typeof data === 'string') {
        clientWs.deliverText(data);
      } else {
        clientWs.deliverBinary(Array.from(toU8(data)));
      }
    },
    on: (event: string, listener: (...a: never[]) => void) => {
      handlers[event] = listener;
    },
  };
  attachBridge(serial, serverWs);
  clientWs.onSend = data => {
    if (typeof data === 'string') {
      (handlers.message as (d: unknown, b: boolean) => void)?.(data, false);
    } else {
      (handlers.message as (d: unknown, b: boolean) => void)?.(
        toU8(data),
        true,
      );
    }
  };
}

describe('end-to-end echo through Serial + bridge', () => {
  it('writes a frame and reads the echo back through the polyfill', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
    });
    const ws = FakeWebSocket.instances[0];
    wireBridge(ws, new EchoSerial());
    ws.fireOpen();

    const serial = new Serial(transport);
    const [port] = await serial.getPorts();
    expect(port).toBeTruthy();
    await port.open({baudRate: 115200});

    const writer = port.writable!.getWriter();
    const reader = port.readable!.getReader();
    await writer.write(Uint8Array.from([0x68, 0x69])); // "hi"
    const {value} = await reader.read();
    expect(Array.from(value ?? [])).toEqual([0x68, 0x69]);

    writer.releaseLock();
    reader.releaseLock();
    await port.close();
  });
});
