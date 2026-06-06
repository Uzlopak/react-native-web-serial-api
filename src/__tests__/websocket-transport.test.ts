/**
 * Tests for the client `WebSocketSerialTransport` over an in-memory fake
 * WebSocket, plus an end-to-end echo that drives the real `Serial`/`SerialPort`
 * polyfill through the transport and the bridge core (no sockets, no hardware).
 */
import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {FlowControl} from '../transport';
import {Serial} from '../WebSerial';
import {attachBridge, type SerialLike, type WsLike} from '../websocket/bridge';
import type {InputSignals} from '../websocket/protocol';
import {
  type WebSocketCtor,
  type WebSocketLike,
  WebSocketSerialTransport,
} from '../websocket/WebSocketSerialTransport';

/** Every transport created during a test — disconnected automatically after each test. */
const createdTransports: WebSocketSerialTransport[] = [];
afterEach(() => {
  for (const t of createdTransports) t.disconnect();
  createdTransports.length = 0;
  FakeWebSocket.instances = [];
});

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
    } | null;
  } = {},
) {
  FakeWebSocket.instances = [];
  const transport = new WebSocketSerialTransport('ws://test', {
    WebSocket: FakeWebSocket as unknown as WebSocketCtor,
    reconnect: opts.reconnect,
    connectTimeoutMs: opts.connectTimeoutMs,
  });
  createdTransports.push(transport);
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
    createdTransports.push(transport);
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

  it('handles WebSocket constructor throwing synchronously', () => {
    FakeWebSocket.instances = [];
    const ThrowCtor = class {
      constructor() {
        throw new Error('connection refused');
      }
      addEventListener() {}
      close() {}
      send() {}
    };
    const transport = new WebSocketSerialTransport('ws://fail', {
      WebSocket: ThrowCtor as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    expect(transport.connectionState).toBe('closed');
  });

  it('returns a single port from showPortPicker (auto-grant)', async () => {
    const {transport} = mount();
    const port = await transport.showPortPicker([]);
    expect(port).toMatchObject({
      deviceId: 1,
      portNumber: 0,
      hasPermission: true,
    });
  });

  it('auto-grants permission requests', async () => {
    const {transport} = mount();
    await expect(transport.requestPermission(1)).resolves.toBe(true);
  });

  it('reports isOpen state', async () => {
    const {transport, commands} = mount();
    expect(transport.isOpen(1, 0)).toBe(false);
    await transport.open(1, 0, {baudRate: 115200});
    expect(transport.isOpen(1, 0)).toBe(true);
    const setLine = commands.find(c => c.command === 'setLineCoding');
    expect(setLine?.args).toBeTruthy();
  });

  it('setRTS/getRTS round-trip', async () => {
    const {transport} = mount();
    expect(await transport.getRTS(1, 0)).toBe(false);
    await transport.setRTS(1, 0, true);
    expect(await transport.getRTS(1, 0)).toBe(true);
  });

  it('getCD/getDSR/getRI relay getSignals results', async () => {
    const {transport} = mount({
      signals: {cts: false, dsr: true, dcd: true, ri: true},
    });
    expect(await transport.getCD(1, 0)).toBe(true);
    expect(await transport.getDSR(1, 0)).toBe(true);
    expect(await transport.getRI(1, 0)).toBe(true);
  });

  it('getControlLines builds a list of active signals', async () => {
    const {transport} = mount({
      signals: {cts: true, dsr: true, dcd: true, ri: true},
    });
    await transport.setDTR(1, 0, true);
    await transport.setRTS(1, 0, true);
    const lines = await transport.getControlLines(1, 0);
    expect(lines).toEqual(
      expect.arrayContaining(['RTS', 'DTR', 'CTS', 'DSR', 'CD', 'RI']),
    );
  });

  it('setBreak sends brk signal', async () => {
    const {transport, commands} = mount();
    await transport.setBreak(1, 0, true);
    expect(commands.find(c => c.command === 'setSignals')?.args).toMatchObject({
      brk: true,
    });
  });

  it('purgeHwBuffers sends flush command (errors swallowed)', async () => {
    const {transport, commands} = mount();
    await transport.purgeHwBuffers(1, 0, true, true);
    expect(commands.find(c => c.command === 'flush')).toBeTruthy();
  });

  it('purgeHwBuffers swallows a rejected flush response', async () => {
    const {transport, ws} = mount();
    const baseOnSend = ws.onSend!;
    ws.onSend = d => {
      if (typeof d === 'string') {
        const msg = JSON.parse(d);
        if (msg.type === 'command' && msg.command === 'flush') {
          ws.deliverText(
            JSON.stringify({
              type: 'response',
              id: msg.id,
              error: 'flush failed',
            }),
          );
          return;
        }
      }
      baseOnSend(d);
    };

    await expect(
      transport.purgeHwBuffers(1, 0, true, true),
    ).resolves.toBeUndefined();
  });

  it('setFlowControl is a no-op; getFlowControl and getSupportedFlowControl return defaults', async () => {
    const {transport} = mount();
    await expect(
      transport.setFlowControl(1, 0, 'NONE' as FlowControl),
    ).resolves.toBeUndefined();
    await expect(transport.getFlowControl(1, 0)).resolves.toBe('NONE');
    const supported = await transport.getSupportedFlowControl(1, 0);
    expect(supported).toEqual(['NONE', 'RTS_CTS']);
  });

  it('stopReading sends the stopReading command', async () => {
    const {transport, commands} = mount();
    await transport.stopReading(1, 0);
    expect(commands.find(c => c.command === 'stopReading')).toBeTruthy();
  });

  it('forwards control-line event from bridge (close event)', () => {
    const {transport, ws} = mount({reconnect: false});
    const onDisconnect = jest.fn();
    transport.onDisconnect(onDisconnect);
    ws.deliverText(JSON.stringify({type: 'event', event: 'close'}));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('forwards error event from the bridge', () => {
    const {transport, ws} = mount();
    const onError = jest.fn();
    transport.onError(onError);
    ws.deliverText(
      JSON.stringify({type: 'event', event: 'error', error: 'cable fault'}),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({error: 'cable fault'}),
    );
  });

  it('drops non-command/non-response/non-event text messages silently', () => {
    const {transport, ws} = mount();
    const onError = jest.fn();
    transport.onError(onError);
    ws.deliverText('not JSON');
    expect(onError).not.toHaveBeenCalled();
    ws.deliverText(JSON.stringify({type: 'unknown'}));
    expect(onError).not.toHaveBeenCalled();
  });

  it('silently ignores a "command"-type message received from the server', () => {
    const {ws} = mount();
    // Server-to-client 'command' messages are not part of the protocol but
    // must not throw. parseControlMessage returns non-null for type='command',
    // which falls through the response/event checks silently.
    expect(() => {
      ws.deliverText(JSON.stringify({type: 'command', id: 1, command: 'ping'}));
    }).not.toThrow();
  });

  it('uses globalThis.WebSocket when no options are passed', () => {
    FakeWebSocket.instances = [];
    const prev = (globalThis as {WebSocket?: WebSocketCtor}).WebSocket;
    (globalThis as {WebSocket?: WebSocketCtor}).WebSocket =
      FakeWebSocket as unknown as WebSocketCtor;
    try {
      const t = new WebSocketSerialTransport('ws://test');
      createdTransports.push(t);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      (globalThis as {WebSocket?: WebSocketCtor}).WebSocket = prev;
    }
  });

  it('wraps a non-Error thrown by ws.send in a new Error', async () => {
    const {transport, ws} = mount();
    ws.onSend = d => {
      if (typeof d === 'string') throw 'string-error';
    };
    await expect(transport.open(1, 0, {baudRate: 9600})).rejects.toThrow(
      'string-error',
    );
  });

  it('ignores response with no matching pending command', () => {
    const {ws} = mount();
    expect(() => {
      ws.deliverText(
        JSON.stringify({type: 'response', id: 999, error: null, result: null}),
      );
    }).not.toThrow();
  });

  it('getSerial returns the configured serial number after loading port info', async () => {
    const {transport} = mount({
      portInfo: {serialNumber: 'SN-12345'},
    });
    // findAllDrivers awaits #loadPortInfo inside
    await transport.findAllDrivers();
    await expect(transport.getSerial(1, 0)).resolves.toBe('SN-12345');
  });

  it('setParameters updates the stored line coding', async () => {
    const {transport, commands} = mount();
    await transport.setParameters(1, 0, {
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: 2,
    });
    const cmd = commands.find(c => c.command === 'setLineCoding');
    expect(cmd?.args).toMatchObject({
      baudRate: 9600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
    });
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
    createdTransports.push(transport);
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
    createdTransports.push(transport);
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
    createdTransports.push(transport);
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
    createdTransports.push(transport);
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
    createdTransports.push(transport);
    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();

    transport.disconnect();
    await tick();

    expect(FakeWebSocket.instances).toHaveLength(1); // no new socket
    expect(transport.connectionState).toBe('closed');
  });

  it('rejects open() with a timeout error when setLineCoding never gets a response', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      commandTimeoutMs: 50,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];

    // Answer only getPortInfo (from #loadPortInfo in #onOpen); let setLineCoding hang.
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as {type: string; command: string; id: number};
      if (m.command === 'getPortInfo') {
        ws.deliverText(
          JSON.stringify({
            type: 'response',
            id: m.id,
            error: null,
            result: null,
          }),
        );
      }
      // setLineCoding: intentionally not answered → command times out after 50 ms
    };
    ws.fireOpen();
    await tick(); // let #onOpen settle (getPortInfo resolved synchronously)

    await expect(
      transport.open(1, 0, {baudRate: 115200, dataBits: 8, parity: 1}),
    ).rejects.toThrow(/timed out/);
  }, 5000);

  it('keeps a response that arrives before the timeout callback runs', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      commandTimeoutMs: 50,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    const commands: Array<{id: number; command: string}> = [];
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as {type: string; id: number; command: string};
      if (m.type === 'command') {
        commands.push(m);
      }
    };

    const callbacks: Array<() => void> = [];
    const setTimeoutSpy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(
        (callback: unknown, _ms?: number, ...args: unknown[]) => {
          callbacks.push(() => {
            if (typeof callback === 'function') {
              callback(...args);
            }
          });
          return 0 as unknown as ReturnType<typeof setTimeout>;
        },
      );
    const clearTimeoutSpy = jest
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);

    try {
      const pending = transport.setDTR(1, 0, true);
      await Promise.resolve();
      const [command] = commands;
      ws.deliverText(
        JSON.stringify({
          type: 'response',
          id: command.id,
          error: null,
          result: null,
        }),
      );

      await expect(pending).resolves.toBeUndefined();
      expect(callbacks).toHaveLength(1);
      callbacks[0]();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('stays stable and reaches open state after 10 rapid drop/reconnect cycles', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    createdTransports.push(transport);

    for (let i = 0; i < 10; i++) {
      const ws = FakeWebSocket.instances[i];
      autoAnswer(ws);
      ws.fireOpen();
      await tick();
      ws.fireClose();
      await tick();
    }

    // Final reconnect should succeed.
    const wsFinal = FakeWebSocket.instances[10];
    autoAnswer(wsFinal);
    wsFinal.fireOpen();
    await tick();

    expect(transport.connectionState).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(11);

    // Disconnects fired during the cycles must not have accumulated into the
    // listener set — only the explicitly registered listener fires once.
    const onDisconnect = jest.fn();
    transport.onDisconnect(onDisconnect);
    wsFinal.fireClose();
    await tick();
    expect(onDisconnect.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('WebSocketSerialTransport — coverage gaps', () => {
  it('throws when no WebSocket implementation is available', () => {
    // Save and clear global WebSocket
    const originalWebSocket = (globalThis as {WebSocket?: WebSocketCtor})
      .WebSocket;
    (globalThis as {WebSocket?: WebSocketCtor}).WebSocket = undefined;
    try {
      expect(() => {
        new WebSocketSerialTransport('ws://test', {
          WebSocket: undefined as unknown as WebSocketCtor,
        });
      }).toThrow('No WebSocket implementation is available.');
    } finally {
      (globalThis as {WebSocket?: WebSocketCtor}).WebSocket = originalWebSocket;
    }
  });

  it('does not reconnect when already closed in #connect', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    // Close socket → schedules a 0ms reconnect timer
    ws.fireClose();
    // Disconnect immediately → state = 'closed' before the timer fires
    transport.disconnect();
    // Timer fires on next tick → #connect() → state === 'closed' → return (line 178)
    await tick();

    expect(transport.connectionState).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1); // no second socket was created
  });

  it('ignores stale open and message events from a replaced socket', async () => {
    FakeWebSocket.instances = [];
    const onConnected = jest.fn();
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
      onConnected,
    });
    createdTransports.push(transport);
    const onData = jest.fn();
    transport.onData(onData);

    const ws1 = FakeWebSocket.instances[0];
    autoAnswer(ws1);
    ws1.fireOpen();
    await tick();
    expect(onConnected).toHaveBeenCalledWith({reconnected: false});

    ws1.fireClose();
    await tick();

    const ws2 = FakeWebSocket.instances[1];
    autoAnswer(ws2);
    ws2.fireOpen();
    await tick();
    expect(onConnected).toHaveBeenCalledWith({reconnected: true});

    const connectedCalls = onConnected.mock.calls.length;
    const dataCalls = onData.mock.calls.length;

    // The old socket can still fire events, but the transport must ignore them.
    ws1.fireOpen();
    ws1.deliverBinary([1, 2, 3]);

    expect(onConnected).toHaveBeenCalledTimes(connectedCalls);
    expect(onData).toHaveBeenCalledTimes(dataCalls);
    transport.disconnect();
  });

  it('handles error during session restore (#restoreSession throws) in #onOpen', async () => {
    // #loadPortInfo silently swallows errors; only #restoreSession can throw into
    // #onOpen's catch (line 230). #restoreSession throws when it has a session to restore
    // (portOpen=true, lastLineCoding set) and the socket dies mid-command.
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    createdTransports.push(transport);
    const ws0 = FakeWebSocket.instances[0];
    autoAnswer(ws0);
    ws0.fireOpen();
    await tick(); // transport is 'open'
    await transport.open(1, 0, {baudRate: 115200}); // sets portOpen=true, lastLineCoding

    // Drop ws0 → schedules 0ms reconnect
    ws0.fireClose();
    await tick(); // reconnect timer fires → #connect() → ws1 created

    const ws1 = FakeWebSocket.instances[1];
    // Don't set ws1.onSend — setLineCoding in #restoreSession will go unanswered
    ws1.fireOpen(); // #onOpen → #restoreSession → sends setLineCoding (now in #pending)
    ws1.fireClose(); // #failAll rejects setLineCoding → #restoreSession throws → line 230
    await tick(); // #onOpen catch runs (line 230); reconnect timer also fires → ws2
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('handles error in #probeAlive and triggers socket down', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws); // answers getPortInfo during initial #onOpen
    ws.fireOpen();
    await tick(); // transport is now 'open'

    // Stop answering commands — getSignals will go unanswered
    ws.onSend = () => {};

    // Start findAllDrivers: #whenConnected resolves, #probeAlive sends getSignals
    const driversPromise = transport.findAllDrivers();
    await tick(); // getSignals is now pending with no answer
    // Close socket: #failAll rejects getSignals → #probeAlive catch (lines 290-291)
    // Then #handleSocketDown in catch → #terminate → state already 'closed' → line 323
    ws.fireClose();
    const ports = await driversPromise;
    expect(ports).toEqual([]);
  });

  it('handles socket down when already closed', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    transport.disconnect();
    expect(transport.connectionState).toBe('closed');

    // Fire close again - should be a no-op
    ws.fireClose();
    expect(transport.connectionState).toBe('closed');
  });

  it('clears reconnect timer in #terminate', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 1000, // long delay so timer is active
      maxReconnectAttempts: 1,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    // Close the socket to trigger reconnect scheduling
    ws.fireClose();
    await tick(); // let the reconnect timer be set

    // Now disconnect() which calls #terminate and should clear the timer
    transport.disconnect();
    expect(transport.connectionState).toBe('closed');
  });

  it('clears reconnect timer in #suspend', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 1000, // long delay so the timer stays pending
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    await transport.open(1, 0, {baudRate: 115200});

    // Close socket → schedules a 1000ms reconnect timer
    ws.fireClose();
    await tick(); // reconnect timer is now pending

    // close() → #sendCommand stopReading → #suspend → clears the timer (lines 351-352)
    await transport.close(1, 0);
    expect(transport.connectionState).toBe('suspended');
  });

  it('rejects waiters when connection is closed', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
      connectTimeoutMs: 100,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    transport.disconnect();

    // Try to open after disconnect - should reject
    await expect(transport.open(1, 0, {baudRate: 115200})).rejects.toThrow(
      'WebSocket transport is closed.',
    );
  });

  it('disconnect() rejects pending #whenConnected waiters (lines 391-392, 408)', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
      connectTimeoutMs: 5000,
    });
    createdTransports.push(transport);
    // Don't fire open — transport stays in 'connecting' state
    // findAllDrivers calls #whenConnected which adds a waiter to #connectWaiters
    const driversPromise = transport.findAllDrivers();
    // disconnect() → #rejectWaiters(reason) → waiter.reject(reason) (line 408)
    //   → clearTimeout(timer) (line 391), reject(e) (line 392)
    transport.disconnect();
    // findAllDrivers catches the rejection and returns []
    const drivers = await driversPromise;
    expect(drivers).toEqual([]);
  });

  it('handles non-string, non-ArrayBuffer data in #onMessage', () => {
    FakeWebSocket.instances = [];
    createdTransports.push(
      new WebSocketSerialTransport('ws://test', {
        WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      }),
    );
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();

    // Deliver a number (not string or ArrayBuffer) - should be ignored silently
    expect(() => {
      ws.deliverText(123 as unknown as string);
    }).not.toThrow();

    // Deliver null - should be ignored silently
    expect(() => {
      ws.deliverText(null as unknown as string);
    }).not.toThrow();
  });

  it('rejects pending command on error response', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      commandTimeoutMs: 5000,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    // After initial handshake, capture the next command ID without answering it
    let capturedId: number | undefined;
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d);
      if (m.type === 'command') capturedId = m.id;
    };

    const promise = transport.setDTR(1, 0, true);
    await tick();
    ws.deliverText(
      JSON.stringify({
        type: 'response',
        id: capturedId,
        error: 'signal error',
        result: null,
      }),
    );
    await expect(promise).rejects.toThrow('signal error');
  });

  it('handles send error in #sendCommand', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick(); // initial handshake done

    // After the handshake, make ws.send() throw synchronously
    ws.onSend = () => {
      throw new Error('send failed');
    };

    // #sendCommand catches the throw and rejects its promise
    await expect(transport.setDTR(1, 0, true)).rejects.toThrow('send failed');
  });

  it('handles error in close() when sending stopReading', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    await transport.open(1, 0, {baudRate: 115200});

    // Override onSend AFTER the handshake so stopReading throws
    ws.onSend = d => {
      if (typeof d === 'string') {
        const m = JSON.parse(d);
        if (m.command === 'stopReading') throw new Error('send failed');
      }
    };

    // close() swallows stopReading errors (.catch(() => undefined))
    await expect(transport.close(1, 0)).resolves.toBeUndefined();
    expect(transport.connectionState).toBe('suspended');
  });

  it('throws when writing to closed transport', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    transport.disconnect();

    await expect(transport.write(1, 0, [1, 2, 3])).rejects.toThrow(
      'WebSocket transport is closed.',
    );
  });

  it('getSupportedControlLines returns all supported lines', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    const lines = await transport.getSupportedControlLines(1, 0);
    expect(lines).toEqual(['RTS', 'CTS', 'DTR', 'DSR', 'CD', 'RI']);
  });

  it('clears reconnect timer in disconnect()', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 1000,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    // Close socket to trigger reconnect timer
    ws.fireClose();
    await tick();

    // disconnect() should clear the timer
    transport.disconnect();
    expect(transport.connectionState).toBe('closed');
  });

  it('disconnect() is idempotent', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    transport.disconnect();
    expect(transport.connectionState).toBe('closed');

    // Second disconnect should not throw
    transport.disconnect();
    expect(transport.connectionState).toBe('closed');
  });

  it('waiter times out waiting for connection', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
      connectTimeoutMs: 50,
    });
    createdTransports.push(transport);
    await expect(transport.open(1, 0, {baudRate: 115200})).rejects.toThrow(
      'Timed out waiting for the WebSocket connection.',
    );
  }, 5000);

  it('#failAll rejects pending commands when socket closes', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      commandTimeoutMs: 5000,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    ws.onSend = () => {}; // stop answering after initial handshake
    const promise = transport.setDTR(1, 0, true);
    await tick();
    ws.fireClose();
    await expect(promise).rejects.toThrow('WebSocket connection lost');
  });

  it('close() is idempotent when already suspended or closed', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    await transport.open(1, 0, {baudRate: 115200});
    await transport.close(1, 0);
    expect(transport.connectionState).toBe('suspended');

    await expect(transport.close(1, 0)).resolves.toBeUndefined();
    expect(transport.connectionState).toBe('suspended');

    transport.disconnect();
    await expect(transport.close(1, 0)).resolves.toBeUndefined();
  });

  it('onReconnecting callback fires with attempt count', async () => {
    const onReconnecting = jest.fn();
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
      onReconnecting,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    ws.fireClose();
    await tick();

    expect(onReconnecting).toHaveBeenCalledWith(1, expect.any(Number));
    expect(transport.connectionState).toBe('reconnecting');
    transport.disconnect();
  });

  it('onConnected fires with reconnected=false on first connect and reconnected=true after', async () => {
    const onConnected = jest.fn();
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
      onConnected,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    expect(onConnected).toHaveBeenCalledWith({reconnected: false});
    expect(transport.connectionState).toBe('open');

    ws.fireClose();
    await tick();
    const ws2 = FakeWebSocket.instances[1];
    autoAnswer(ws2);
    ws2.fireOpen();
    await tick();

    expect(onConnected).toHaveBeenCalledWith({reconnected: true});
    transport.disconnect();
  });

  it('onClosed fires with "closed by client" reason when manually disconnected', async () => {
    const onClosed = jest.fn();
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
      onClosed,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    transport.disconnect();
    expect(onClosed).toHaveBeenCalledWith('closed by client');
  });

  it('onClosed fires when reconnect budget is exhausted', async () => {
    const onClosed = jest.fn();
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
      maxReconnectAttempts: 1,
      onClosed,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    ws.fireClose();
    await tick();
    const ws2 = FakeWebSocket.instances[1];
    ws2.fireClose();

    expect(onClosed).toHaveBeenCalledWith(
      'WebSocket connection lost and will not be retried.',
    );
    expect(transport.connectionState).toBe('closed');
  });

  it('WebSocket constructor throwing on reconnect leaves transport in reconnecting state', async () => {
    let shouldThrow = false;
    class ThrowingCtor extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        if (shouldThrow) throw new Error('connection refused');
      }
    }

    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: ThrowingCtor as unknown as WebSocketCtor,
      reconnectInitialDelayMs: 0,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0] as ThrowingCtor;
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    shouldThrow = true;
    ws.fireClose();
    await tick();

    expect(transport.connectionState).toBe('reconnecting');
    transport.disconnect();
  });

  it('error event with no error field uses "serial error" fallback', () => {
    const {transport, ws} = mount();
    const onError = jest.fn();
    transport.onError(onError);
    ws.deliverText(
      JSON.stringify({type: 'event', event: 'error', error: undefined}),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({error: 'serial error'}),
    );
  });

  it('setDTR sends setSignals with only dtr', async () => {
    const {transport, commands} = mount();
    await transport.setDTR(1, 0, true);
    expect(commands.find(c => c.command === 'setSignals')?.args).toMatchObject({
      dtr: true,
    });
  });

  it('setRTS sends setSignals with only rts', async () => {
    const {transport, commands} = mount();
    await transport.setRTS(1, 0, true);
    expect(commands.find(c => c.command === 'setSignals')?.args).toMatchObject({
      rts: true,
    });
  });

  it('setBreak(false) sends setSignals with brk false', async () => {
    const {transport, commands} = mount();
    await transport.setBreak(1, 0, false);
    expect(commands.find(c => c.command === 'setSignals')?.args).toMatchObject({
      brk: false,
    });
  });

  it('purgeHwBuffers sends flush for (true,false), (false,true), and (false,false)', async () => {
    const {transport, commands} = mount();
    await transport.purgeHwBuffers(1, 0, true, false);
    expect(commands.find(c => c.command === 'flush')).toBeTruthy();

    commands.length = 0;
    await transport.purgeHwBuffers(1, 0, false, true);
    expect(commands.find(c => c.command === 'flush')).toBeTruthy();

    commands.length = 0;
    await transport.purgeHwBuffers(1, 0, false, false);
    expect(commands.find(c => c.command === 'flush')).toBeTruthy();
  });

  it('getSerial returns empty string when serialNumber is empty', async () => {
    const {transport} = mount({portInfo: {serialNumber: ''}});
    await transport.findAllDrivers();
    await expect(transport.getSerial(1, 0)).resolves.toBe('');
  });

  it('getSerial returns empty string when portInfo is null', async () => {
    const {transport} = mount({portInfo: null});
    await transport.findAllDrivers();
    await expect(transport.getSerial(1, 0)).resolves.toBe('');
  });

  it('parity mapping: 0=none, 1=odd, 2=even, 3=none (fallback), 4=none (fallback)', async () => {
    const {transport, commands} = mount();

    await transport.open(1, 0, {baudRate: 9600, parity: 0});
    expect(
      commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      parity: 'none',
    });

    commands.length = 0;
    await transport.setParameters(1, 0, {baudRate: 9600, parity: 1});
    expect(
      commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      parity: 'odd',
    });

    commands.length = 0;
    await transport.setParameters(1, 0, {baudRate: 9600, parity: 2});
    expect(
      commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      parity: 'even',
    });

    commands.length = 0;
    await transport.setParameters(1, 0, {baudRate: 9600, parity: 3});
    expect(
      commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      parity: 'none',
    });

    commands.length = 0;
    await transport.setParameters(1, 0, {baudRate: 9600, parity: 4});
    expect(
      commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      parity: 'none',
    });
  });

  it('multiple onData listeners: removing one stops it receiving data', () => {
    const {transport, ws} = mount();
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const sub1 = transport.onData(listener1);
    transport.onData(listener2);

    ws.deliverBinary([1, 2, 3]);
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    sub1.remove();
    ws.deliverBinary([4, 5, 6]);
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(2);
  });

  it('multiple onError listeners: removing one stops it receiving errors', () => {
    const {transport, ws} = mount();
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const sub1 = transport.onError(listener1);
    transport.onError(listener2);

    ws.deliverText(
      JSON.stringify({type: 'event', event: 'error', error: 'err1'}),
    );
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    sub1.remove();
    ws.deliverText(
      JSON.stringify({type: 'event', event: 'error', error: 'err2'}),
    );
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(2);
  });

  it('onConnect listeners: both called on initial connection, removed one skipped', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);

    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const sub1 = transport.onConnect(listener1);
    transport.onConnect(listener2);

    // Remove one before the initial connection fires
    sub1.remove();

    ws.fireOpen();
    await tick();

    expect(listener1).not.toHaveBeenCalled(); // removed before first connect
    expect(listener2).toHaveBeenCalledTimes(1);
    transport.disconnect();
  });

  it('multiple onDisconnect listeners are both called on terminal disconnect', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    const listener1 = jest.fn();
    const listener2 = jest.fn();
    transport.onDisconnect(listener1);
    transport.onDisconnect(listener2);

    ws.fireClose();
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  it('subscription.remove() is idempotent', () => {
    const {transport} = mount();
    const sub = transport.onData(jest.fn());
    sub.remove();
    expect(() => sub.remove()).not.toThrow();
    expect(() => sub.remove()).not.toThrow();
  });

  it('write() with an empty data array sends an empty binary frame', async () => {
    const {transport, binary} = mount();
    await transport.write(1, 0, []);
    expect(binary).toHaveLength(1);
    expect(Array.from(binary[0])).toEqual([]);
  });

  it('write() with a large data array sends all bytes', async () => {
    const {transport, binary} = mount();
    const large = Array.from({length: 10000}, (_, i) => i % 256);
    await transport.write(1, 0, large);
    expect(Array.from(binary[0])).toEqual(large);
  });

  it('startReading and stopReading can each be called multiple times', async () => {
    const {transport, commands} = mount();
    await transport.startReading(1, 0);
    await transport.startReading(1, 0);
    expect(commands.filter(c => c.command === 'startReading')).toHaveLength(2);

    commands.length = 0;
    await transport.stopReading(1, 0);
    await transport.stopReading(1, 0);
    expect(commands.filter(c => c.command === 'stopReading')).toHaveLength(2);
  });

  it('setParameters works when the port has not been opened', async () => {
    const {transport, commands} = mount();
    await transport.setParameters(1, 0, {baudRate: 9600});
    expect(
      commands.find(c => c.command === 'setLineCoding')?.args,
    ).toMatchObject({
      baudRate: 9600,
    });
  });

  it('getControlLines returns empty list when all signals are inactive', async () => {
    const {transport} = mount({
      signals: {cts: false, dsr: false, dcd: false, ri: false},
    });
    expect(await transport.getControlLines(1, 0)).toEqual([]);
  });

  it('getControlLines returns only local signals (DTR, RTS) when set', async () => {
    const {transport} = mount({
      signals: {cts: false, dsr: false, dcd: false, ri: false},
    });
    await transport.setDTR(1, 0, true);
    await transport.setRTS(1, 0, true);
    const lines = await transport.getControlLines(1, 0);
    expect(lines).toEqual(expect.arrayContaining(['DTR', 'RTS']));
    expect(lines).not.toContain('CTS');
  });

  it('getControlLines returns only remote signals when CTS/DSR/CD/RI are active', async () => {
    const {transport} = mount({
      signals: {cts: true, dsr: true, dcd: true, ri: true},
    });
    const lines = await transport.getControlLines(1, 0);
    expect(lines).toEqual(expect.arrayContaining(['CTS', 'DSR', 'CD', 'RI']));
    expect(lines).not.toContain('DTR');
    expect(lines).not.toContain('RTS');
  });

  it('showPortPicker with a vendor/product filter returns the single port', async () => {
    const {transport} = mount();
    const port = await transport.showPortPicker([
      {usbVendorId: 0x0403},
      {usbProductId: 0x6001},
    ]);
    expect(port).toMatchObject({
      deviceId: 1,
      portNumber: 0,
      hasPermission: true,
    });
  });

  it('findAllDrivers returns port with default IDs when portInfo is null', async () => {
    const {transport} = mount({portInfo: null});
    const ports = await transport.findAllDrivers();
    expect(ports).toHaveLength(1);
    expect(ports[0].usbVendorId).toBe(0);
    expect(ports[0].usbProductId).toBe(0);
  });

  it('findAllDrivers fills missing portInfo fields with defaults', async () => {
    const {transport} = mount({portInfo: {usbVendorId: 0x1234}});
    const ports = await transport.findAllDrivers();
    expect(ports[0].usbVendorId).toBe(0x1234);
    expect(ports[0].usbProductId).toBe(0);
  });

  it('findAllDrivers handles non-object portInfo response gracefully', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as {type: string; command: string; id: number};
      if (m.command === 'getSignals') {
        ws.deliverText(
          JSON.stringify({
            type: 'response',
            id: m.id,
            error: null,
            result: {cts: false, dsr: false, dcd: false, ri: false},
          }),
        );
      }
      if (m.command === 'getPortInfo') {
        ws.deliverText(
          JSON.stringify({
            type: 'response',
            id: m.id,
            error: null,
            result: 'not an object',
          }),
        );
      }
    };
    ws.fireOpen();
    await tick();

    const ports = await transport.findAllDrivers();
    expect(ports).toHaveLength(1);
    expect(ports[0].usbVendorId).toBe(0);
    expect(ports[0].usbProductId).toBe(0);
  });

  it('findAllDrivers returns a port with defaults when getPortInfo times out', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
      commandTimeoutMs: 50,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as {type: string; command: string; id: number};
      if (m.command === 'getSignals') {
        ws.deliverText(
          JSON.stringify({
            type: 'response',
            id: m.id,
            error: null,
            result: {cts: false, dsr: false, dcd: false, ri: false},
          }),
        );
      }
      // getPortInfo: intentionally not answered → times out after 50 ms
    };
    ws.fireOpen();
    await tick();

    const ports = await transport.findAllDrivers();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({
      deviceId: 1,
      portNumber: 0,
      hasPermission: true,
    });
  }, 5000);

  it('isOpen returns false after the port is closed', async () => {
    const {transport} = mount();
    await transport.open(1, 0, {baudRate: 115200});
    expect(transport.isOpen(1, 0)).toBe(true);
    await transport.close(1, 0);
    expect(transport.isOpen(1, 0)).toBe(false);
  });

  it('command times out and rejects with a descriptive message', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      commandTimeoutMs: 50,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    autoAnswer(ws);
    ws.fireOpen();
    await tick();

    ws.onSend = () => {}; // stop answering
    await expect(transport.setDTR(1, 0, true)).rejects.toThrow(
      'Command "setSignals" timed out.',
    );
  }, 5000);

  it('unknown bridge event type is silently ignored', () => {
    const {transport, ws} = mount();
    const onError = jest.fn();
    transport.onError(onError);
    ws.deliverText(JSON.stringify({type: 'event', event: 'unknown'}));
    expect(onError).not.toHaveBeenCalled();
  });

  it('open event from bridge does not trigger onConnect', () => {
    const {transport, ws} = mount();
    const onConnect = jest.fn();
    transport.onConnect(onConnect);
    ws.deliverText(JSON.stringify({type: 'event', event: 'open'}));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('getSignals returning null causes all signal getters to return false', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as {type: string; command: string; id: number};
      if (m.command === 'getSignals') {
        ws.deliverText(
          JSON.stringify({
            type: 'response',
            id: m.id,
            error: null,
            result: null,
          }),
        );
      }
    };
    ws.fireOpen();
    await tick();

    expect(await transport.getCTS(1, 0)).toBe(false);
    expect(await transport.getDSR(1, 0)).toBe(false);
    expect(await transport.getCD(1, 0)).toBe(false);
    expect(await transport.getRI(1, 0)).toBe(false);
  });

  it('getSignals returning partial signals defaults missing ones to false', async () => {
    FakeWebSocket.instances = [];
    const transport = new WebSocketSerialTransport('ws://test', {
      WebSocket: FakeWebSocket as unknown as WebSocketCtor,
      reconnect: false,
    });
    createdTransports.push(transport);
    const ws = FakeWebSocket.instances[0];
    ws.onSend = d => {
      if (typeof d !== 'string') return;
      const m = JSON.parse(d) as {type: string; command: string; id: number};
      if (m.command === 'getSignals') {
        ws.deliverText(
          JSON.stringify({
            type: 'response',
            id: m.id,
            error: null,
            result: {cts: true},
          }),
        );
      }
    };
    ws.fireOpen();
    await tick();

    expect(await transport.getCTS(1, 0)).toBe(true);
    expect(await transport.getDSR(1, 0)).toBe(false);
    expect(await transport.getCD(1, 0)).toBe(false);
    expect(await transport.getRI(1, 0)).toBe(false);
  });

  it('setDTR false / getDTR round-trip', async () => {
    const {transport} = mount();
    await transport.setDTR(1, 0, true);
    expect(await transport.getDTR(1, 0)).toBe(true);
    await transport.setDTR(1, 0, false);
    expect(await transport.getDTR(1, 0)).toBe(false);
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
    createdTransports.push(transport);
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
