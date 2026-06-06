/**
 * `exposeSerialDevice` — run a {@link SerialDevice} simulator behind a WebSocket
 * server so a real app (on a device/emulator) can connect to it with
 * `new Serial(new WebSocketSerialTransport(url))` and drive the *same* simulated
 * peripheral your Jest tests drive. The test process keeps the
 * {@link VirtualSerialDevice} handle, so it can inject frames / move the GPS and
 * `await whenOpened()` for the app to connect — turning an in-memory device
 * suite into an on-device E2E without changing the device code.
 *
 * `ws` is an *optional* dependency: it is loaded lazily (and only in Node), via
 * an indirect require so app bundlers never pull it into a mobile bundle. Pass
 * `options.WebSocketServer` to inject your own (e.g. `import {WebSocketServer}
 * from 'ws'`) and skip the lazy load entirely.
 *
 * @example
 * import {WebSocketServer} from 'ws';
 * const ex = exposeSerialDevice(new WMBusGateway('iU891A-XL'), {
 *   port: 8090,
 *   WebSocketServer,
 * });
 * // …app connects to ex.url…
 * await ex.whenOpened();
 * ex.serialDevice.addMeter(meter);
 * meter.sendTelegram(); // the app receives the 0x20 telegram event
 * await ex.close();
 */

import {
  attachBridge,
  portInfoFromDevice,
  serialDeviceToSerialLike,
  type WsLike,
} from '../websocket';
import type {SerialDevice, SerialDeviceOpenOptions} from './serial-device';
import type {VirtualSerialDeviceOptions} from './virtual-serial-device';
import {
  type VirtualSerialDevice,
  VirtualSerialTransport,
} from './virtual-serial-device';

/** The `ws` WebSocketServer surface this helper uses. */
export type WebSocketServerLike = {
  on(event: 'connection', listener: (socket: WsLike) => void): void;
  close(cb?: () => void): void;
};

/** A `ws`-compatible `WebSocketServer` constructor. */
export type WebSocketServerCtor = new (options: {
  port: number;
  host?: string;
}) => WebSocketServerLike;

export type ExposeSerialDeviceOptions = {
  /** TCP port for the WebSocket server. */
  port: number;
  /** Listen address. Defaults to `localhost`. Use `0.0.0.0` for an emulator. */
  host?: string;
  /** Inject a `ws`-compatible `WebSocketServer` (skips the lazy `require('ws')`). */
  WebSocketServer?: WebSocketServerCtor;
  /** Forward device→client data before the app sends startReading. Default true. */
  readingByDefault?: boolean;
  /** Diagnostics logger. */
  log?: (message: string) => void;
  /** Transport-side device options (hasPermission defaults to true). */
  device?: VirtualSerialDeviceOptions;
};

export type ExposedSerialDevice<D extends SerialDevice = SerialDevice> = {
  /** The URL the app connects to, e.g. `ws://localhost:8090`. */
  url: string;
  transport: VirtualSerialTransport;
  /** The transport-side handle: push/emitError/whenOpened/whenClosed/… */
  device: VirtualSerialDevice;
  /** The concrete device simulator, typed (drive it from the test). */
  serialDevice: D;
  /** Resolve when the app opens the port (now if already open). */
  whenOpened(): Promise<SerialDeviceOpenOptions>;
  /** Resolve when the app closes the port (now if not open). */
  whenClosed(): Promise<void>;
  /** Stop the WebSocket server. */
  close(): Promise<void>;
};

/** Resolve a `ws` WebSocketServer lazily, in Node only, invisibly to bundlers. */
function loadWebSocketServer(): WebSocketServerCtor {
  const specifier = 'ws';
  const nodeRequire =
    typeof module !== 'undefined' &&
    typeof (module as {require?: unknown}).require === 'function'
      ? (module as {require: (id: string) => unknown}).require.bind(module)
      : undefined;
  if (!nodeRequire) {
    throw new Error(
      "exposeSerialDevice could not load 'ws'. Pass options.WebSocketServer, " +
        'or run it in a Node process with the optional `ws` package installed.',
    );
  }
  const ws = nodeRequire(specifier) as {
    WebSocketServer?: WebSocketServerCtor;
    Server?: WebSocketServerCtor;
  };
  const Ctor = ws.WebSocketServer ?? ws.Server;
  if (!Ctor) {
    throw new Error("the 'ws' package did not export a WebSocketServer.");
  }
  return Ctor;
}

export function exposeSerialDevice<D extends SerialDevice>(
  serialDevice: D,
  options: ExposeSerialDeviceOptions,
): ExposedSerialDevice<D> {
  const transport = new VirtualSerialTransport();
  const device = transport.addDevice(serialDevice, {
    hasPermission: true,
    ...options.device,
  });

  const Ctor = options.WebSocketServer ?? loadWebSocketServer();
  const server = new Ctor({port: options.port, host: options.host});
  server.on('connection', socket => {
    const serial = serialDeviceToSerialLike(transport, device);
    attachBridge(serial, socket, {
      portInfo: portInfoFromDevice(device),
      readingByDefault: options.readingByDefault,
      log: options.log,
    });
  });

  const host = options.host ?? 'localhost';
  return {
    url: `ws://${host}:${options.port}`,
    transport,
    device,
    serialDevice,
    whenOpened: () => device.whenOpened(),
    whenClosed: () => device.whenClosed(),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
