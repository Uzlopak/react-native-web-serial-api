/**
 * Unit tests for the WebSocket bridge core ({@link attachBridge}) and CLI arg
 * parsing — exercised with fakes, no real `serialport`/`ws`/sockets.
 */
import {describe, expect, it} from '@jest/globals';
import {
  attachBridge,
  parseBridgeArgs,
  type SerialLike,
  type WsLike,
} from '../websocket/bridge';

/** A fake serial port that echoes writes back as `data` (like a loopback). */
class FakeSerial implements SerialLike {
  readonly #listeners: Record<string, Array<(...a: never[]) => void>> = {};
  dtr = false;
  rts = false;
  brk = false;
  signals = {cts: true, dsr: false, dcd: true, ri: false};
  lastBaud = 0;
  flushed = 0;

  on(event: string, listener: (...a: never[]) => void): void {
    this.#listeners[event] ??= [];
    this.#listeners[event].push(listener);
  }
  removeListener(event: string, listener: (...a: never[]) => void): void {
    this.#listeners[event] = (this.#listeners[event] ?? []).filter(
      l => l !== listener,
    );
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.#listeners[event] ?? []) {
      (l as (...a: unknown[]) => void)(...args);
    }
  }
  write(data: Uint8Array, cb?: (err?: Error | null) => void): void {
    queueMicrotask(() => {
      this.emit('data', data); // echo
      cb?.(null);
    });
  }
  set(
    opts: {dtr?: boolean; rts?: boolean; brk?: boolean},
    cb?: (err?: Error | null) => void,
  ): void {
    if (opts.dtr !== undefined) this.dtr = opts.dtr;
    if (opts.rts !== undefined) this.rts = opts.rts;
    if (opts.brk !== undefined) this.brk = opts.brk;
    cb?.(null);
  }
  get(
    cb: (
      err: Error | null,
      s?: {cts?: boolean; dsr?: boolean; dcd?: boolean; ri?: boolean},
    ) => void,
  ): void {
    cb(null, this.signals);
  }
  update(opts: {baudRate: number}, cb?: (err?: Error | null) => void): void {
    this.lastBaud = opts.baudRate;
    cb?.(null);
  }
  flush(cb?: (err?: Error | null) => void): void {
    this.flushed++;
    cb?.(null);
  }
  drain(cb?: (err?: Error | null) => void): void {
    cb?.(null);
  }
  close(cb?: (err?: Error | null) => void): void {
    this.emit('close');
    cb?.(null);
  }
}

class FakeWs implements WsLike {
  readonly sent: Array<string | Uint8Array> = [];
  #onMessage?: (data: unknown, isBinary: boolean) => void;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  on(event: string, listener: (...a: never[]) => void): void {
    if (event === 'message') {
      this.#onMessage = listener as (data: unknown, isBinary: boolean) => void;
    }
  }
  recvBinary(bytes: number[]): void {
    this.#onMessage?.(Uint8Array.from(bytes), true);
  }
  recvCommand(message: object): void {
    this.#onMessage?.(JSON.stringify(message), false);
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

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('attachBridge', () => {
  it('writes incoming binary frames to the serial port (and echoes back)', async () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws);

    ws.recvBinary([1, 2, 3]);
    await flush();

    expect(ws.binary()).toHaveLength(1);
    expect(Array.from(ws.binary()[0])).toEqual([1, 2, 3]);
  });

  it('forwards serial data to the client as a binary frame', () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws);

    serial.emit('data', Uint8Array.from([9, 8, 7]));
    expect(Array.from(ws.binary()[0])).toEqual([9, 8, 7]);
  });

  it('stops forwarding after a stopReading command', () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws);

    ws.recvCommand({type: 'command', id: 1, command: 'stopReading'});
    serial.emit('data', Uint8Array.from([1]));
    expect(ws.binary()).toHaveLength(0);
  });

  it('applies setSignals and replies ok', () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws);

    ws.recvCommand({
      type: 'command',
      id: 7,
      command: 'setSignals',
      args: {dtr: true, rts: false},
    });
    expect(serial.dtr).toBe(true);
    expect(serial.rts).toBe(false);
    expect(ws.responses()).toContainEqual({
      type: 'response',
      id: 7,
      error: null,
      result: null,
    });
  });

  it('answers getSignals with the input signal state', () => {
    const serial = new FakeSerial();
    serial.signals = {cts: true, dsr: true, dcd: false, ri: true};
    const ws = new FakeWs();
    attachBridge(serial, ws);

    ws.recvCommand({type: 'command', id: 3, command: 'getSignals'});
    const rsp = ws.responses().find(r => r.id === 3);
    expect(rsp?.result).toEqual({cts: true, dsr: true, dcd: false, ri: true});
  });

  it('answers getPortInfo when bridge metadata is provided', () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws, {
      portInfo: {
        usbVendorId: 0x0403,
        usbProductId: 0x6001,
        serialNumber: 'ABC123',
      },
    });

    ws.recvCommand({type: 'command', id: 9, command: 'getPortInfo'});
    const rsp = ws.responses().find(r => r.id === 9);
    expect(rsp?.result).toEqual({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      serialNumber: 'ABC123',
    });
  });

  it('maps setBaudRate to a live baud-rate update', () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws);

    ws.recvCommand({
      type: 'command',
      id: 5,
      command: 'setBaudRate',
      args: {baudRate: 9600},
    });
    expect(serial.lastBaud).toBe(9600);
  });

  it('surfaces a serial error as an event frame', () => {
    const serial = new FakeSerial();
    const ws = new FakeWs();
    attachBridge(serial, ws);

    serial.emit('error', new Error('boom'));
    expect(ws.responses()).toContainEqual({
      type: 'event',
      event: 'error',
      error: 'boom',
    });
  });
});

describe('parseBridgeArgs', () => {
  it('applies sensible defaults (localhost)', () => {
    const a = parseBridgeArgs(['--port', '/dev/ttyUSB0']);
    expect(a).toMatchObject({
      port: '/dev/ttyUSB0',
      baudRate: 115200,
      wsPort: 8080,
      host: '127.0.0.1',
      allowRemote: false,
    });
  });

  it('reads short flags and --allow-remote (binds 0.0.0.0)', () => {
    const a = parseBridgeArgs([
      '-p',
      'COM3',
      '-b',
      '9600',
      '-w',
      '9000',
      '--allow-remote',
    ]);
    expect(a).toMatchObject({
      port: 'COM3',
      baudRate: 9600,
      wsPort: 9000,
      host: '0.0.0.0',
      allowRemote: true,
    });
  });

  it('falls back to environment variables', () => {
    const a = parseBridgeArgs([], {
      SERIAL_PORT: '/dev/ttyACM0',
      BAUD_RATE: '57600',
      WS_PORT: '7000',
      HOST: '192.168.1.5',
    });
    expect(a).toMatchObject({
      port: '/dev/ttyACM0',
      baudRate: 57600,
      wsPort: 7000,
      host: '192.168.1.5',
    });
  });
});
