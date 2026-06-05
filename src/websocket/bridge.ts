/**
 * Server-side core of the WebSocket serial bridge — deliberately free of any
 * `serialport`/`ws`/Node imports so it is unit-testable with fakes. The thin
 * `bin/expose-serial.js` wrapper supplies the real `serialport` port and `ws`
 * socket objects and calls {@link attachBridge} for each connection.
 */
import {
  type ControlMessage,
  type PortInfo,
  parseControlMessage,
} from './protocol';

/** The subset of a `serialport` SerialPort that the bridge uses (callback API). */
export interface SerialLike {
  write(data: Uint8Array, cb?: (err?: Error | null) => void): void;
  set(
    opts: {dtr?: boolean; rts?: boolean; brk?: boolean},
    cb?: (err?: Error | null) => void,
  ): void;
  get(
    cb: (
      err: Error | null,
      signals?: {cts?: boolean; dsr?: boolean; dcd?: boolean; ri?: boolean},
    ) => void,
  ): void;
  update(opts: {baudRate: number}, cb?: (err?: Error | null) => void): void;
  flush(cb?: (err?: Error | null) => void): void;
  drain(cb?: (err?: Error | null) => void): void;
  close(cb?: (err?: Error | null) => void): void;
  on(event: 'data', listener: (data: Uint8Array) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'open' | 'close', listener: () => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

/** The subset of a `ws` WebSocket that the bridge uses. */
export interface WsLike {
  send(data: string | Uint8Array): void;
  on(
    event: 'message',
    listener: (data: unknown, isBinary: boolean) => void,
  ): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type BridgeOptions = {
  /** Whether the port forwards serial→client data before `startReading`. */
  readingByDefault?: boolean;
  /** Optional logger for diagnostics. */
  log?: (message: string) => void;
  /** Optional static metadata or callback exposed via `getPortInfo`. */
  portInfo?: PortInfo | (() => PortInfo | null | undefined);
};

/** Normalise any binary payload (Buffer/ArrayBuffer/typed array) to bytes. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return Uint8Array.from(data as number[]);
  }
  return new Uint8Array(0);
}

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Wire a single WebSocket connection to a single serial port: binary frames are
 * piped both ways, JSON control frames invoke the corresponding serial method
 * and get a response, and the port's data/error/close are surfaced as frames.
 * Returns a teardown function that detaches the serial listeners.
 */
export function attachBridge(
  serial: SerialLike,
  ws: WsLike,
  options: BridgeOptions = {},
): () => void {
  let reading = options.readingByDefault ?? true;

  const onData = (data: Uint8Array): void => {
    if (reading) {
      ws.send(toBytes(data));
    }
  };
  const sendEvent = (event: 'open' | 'close' | 'error', error?: string): void =>
    ws.send(JSON.stringify({type: 'event', event, ...(error ? {error} : {})}));
  const onError = (err: Error): void => sendEvent('error', err.message);
  const onOpen = (): void => sendEvent('open');
  const onClose = (): void => sendEvent('close');

  serial.on('data', onData);
  serial.on('error', onError);
  serial.on('open', onOpen);
  serial.on('close', onClose);

  const reply = (id: number, error: unknown, result: unknown = null): void =>
    ws.send(
      JSON.stringify({
        type: 'response',
        id,
        error: error ? errMessage(error) : null,
        result,
      }),
    );

  const handleCommand = (msg: Extract<ControlMessage, {type: 'command'}>) => {
    const {id, command} = msg;
    const args = (msg.args ?? {}) as Record<string, number | boolean>;
    switch (command) {
      // Note: serialport can change the baud rate live; data-bits/parity/stop-bits
      // are fixed at the rate the bridge process was started with.
      case 'setLineCoding':
      case 'setBaudRate':
        serial.update({baudRate: Number(args.baudRate)}, e => reply(id, e));
        break;
      case 'setSignals': {
        const set: {dtr?: boolean; rts?: boolean; brk?: boolean} = {};
        if (typeof args.dtr === 'boolean') set.dtr = args.dtr;
        if (typeof args.rts === 'boolean') set.rts = args.rts;
        if (typeof args.brk === 'boolean') set.brk = args.brk;
        serial.set(set, e => reply(id, e));
        break;
      }
      case 'getSignals':
        serial.get((e, s) =>
          reply(
            id,
            e,
            s
              ? {cts: !!s.cts, dsr: !!s.dsr, dcd: !!s.dcd, ri: !!s.ri}
              : {cts: false, dsr: false, dcd: false, ri: false},
          ),
        );
        break;
      case 'getPortInfo': {
        const info =
          typeof options.portInfo === 'function'
            ? options.portInfo()
            : options.portInfo;
        reply(
          id,
          null,
          info
            ? {
                usbVendorId: info.usbVendorId,
                usbProductId: info.usbProductId,
                serialNumber: info.serialNumber,
              }
            : null,
        );
        break;
      }
      case 'startReading':
        reading = true;
        reply(id, null);
        break;
      case 'stopReading':
        reading = false;
        reply(id, null);
        break;
      case 'flush':
        serial.flush(e => reply(id, e));
        break;
      case 'drain':
        serial.drain(e => reply(id, e));
        break;
      case 'break':
        serial.set({brk: true}, () =>
          setTimeout(
            () => serial.set({brk: false}, e => reply(id, e)),
            Number(args.duration ?? 100),
          ),
        );
        break;
      case 'close':
        serial.close(e => reply(id, e));
        break;
      default:
        reply(id, new Error(`unknown command: ${command}`));
    }
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      serial.write(toBytes(data), err => {
        if (err) {
          options.log?.(`serial write failed: ${errMessage(err)}`);
        }
      });
      return;
    }
    const text =
      typeof data === 'string' ? data : new TextDecoder().decode(toBytes(data));
    const msg = parseControlMessage(text);
    if (msg?.type === 'command') {
      handleCommand(msg);
    }
  });

  const teardown = (): void => {
    serial.removeListener('data', onData as (...a: never[]) => void);
    serial.removeListener('error', onError as (...a: never[]) => void);
    serial.removeListener('open', onOpen as (...a: never[]) => void);
    serial.removeListener('close', onClose as (...a: never[]) => void);
  };
  ws.on('close', teardown);
  ws.on('error', err => options.log?.(`ws error: ${errMessage(err)}`));

  return teardown;
}

// ── CLI argument parsing (pure, testable) ────────────────────────────────────

export type BridgeArgs = {
  port?: string;
  baudRate: number;
  wsPort: number;
  host: string;
  allowRemote: boolean;
  help: boolean;
};

/** Parse `expose-serial` CLI args + env into a normalised options object. */
export function parseBridgeArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): BridgeArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '-p':
      case '--port':
        args.port = take();
        break;
      case '-b':
      case '--baudrate':
        args.baudRate = take();
        break;
      case '-w':
      case '--ws-port':
        args.wsPort = take();
        break;
      case '--host':
        args.host = take();
        break;
      case '--allow-remote':
        args.allowRemote = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
    }
  }

  const allowRemote = args.allowRemote === true;
  const host =
    (args.host as string) ??
    env.HOST ??
    (allowRemote ? '0.0.0.0' : '127.0.0.1');

  return {
    port: (args.port as string) ?? env.SERIAL_PORT,
    baudRate: Number(args.baudRate ?? env.BAUD_RATE ?? 115200),
    wsPort: Number(args.wsPort ?? env.WS_PORT ?? 8080),
    host,
    allowRemote,
    help: args.help === true,
  };
}

export const USAGE = `expose-serial-websocket — bridge a serial port to a WebSocket

Usage:
  expose-serial-websocket --port <path> [--baudrate 115200] [--ws-port 8080]
                          [--host 127.0.0.1] [--allow-remote]

Options:
  -p, --port <path>       Serial device (e.g. /dev/ttyUSB0, COM3)   [env SERIAL_PORT]
  -b, --baudrate <n>      Baud rate (default 115200)                [env BAUD_RATE]
  -w, --ws-port <n>       WebSocket port (default 8080)             [env WS_PORT]
      --host <addr>       Listen address (default 127.0.0.1)        [env HOST]
      --allow-remote      Bind 0.0.0.0 (exposes the port to the network!)
  -h, --help              Show this help

Connect from the app with:
  new Serial(new WebSocketSerialTransport('ws://localhost:8080'))
`;
