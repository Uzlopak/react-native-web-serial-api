/**
 * `exposeSimulatedDevice` — run a {@link SimulatedDevice} simulator behind a WebSocket
 * server so a real app (on a device/emulator) can connect to it with
 * `new Serial(new WebSocketSerialTransport(url))` and drive the *same* simulated
 * peripheral your Jest tests drive. The test process keeps the
 * {@link DeviceHandle} handle, so it can inject frames / move the GPS and
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
 * const ex = exposeSimulatedDevice(new WMBusGateway('iU891A-XL'), {
 *   port: 8090,
 *   WebSocketServer,
 * });
 * // …app connects to ex.url…
 * await ex.whenOpened();
 * ex.simulatedDevice.addMeter(meter);
 * meter.sendTelegram(); // the app receives the 0x20 telegram event
 * await ex.close();
 */

import {
  attachBridge,
  portInfoFromDevice,
  SimulatedDeviceToSerialLike,
  type WsLike,
} from '../websocket';
import type {DeviceOptions} from './in-memory-serial-transport';
import {
  type DeviceHandle,
  InMemorySerialTransport,
} from './in-memory-serial-transport';
import type {
  SimulatedDevice,
  SimulatedDeviceOpenOptions,
} from './simulated-device';

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

export type ExposeSimulatedDeviceOptions = {
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
  device?: DeviceOptions;
};

export type ExposedDevice<D extends SimulatedDevice = SimulatedDevice> = {
  /** The URL the app connects to, e.g. `ws://localhost:8090`. */
  url: string;
  transport: InMemorySerialTransport;
  /** The transport-side handle: push/emitError/whenOpened/whenClosed/… */
  device: DeviceHandle;
  /** The concrete device simulator, typed (drive it from the test). */
  simulatedDevice: D;
  /** Resolve when the app opens the port (now if already open). */
  whenOpened(): Promise<SimulatedDeviceOpenOptions>;
  /** Resolve when the app closes the port (now if not open). */
  whenClosed(): Promise<void>;
  /** Stop the WebSocket server. */
  close(): Promise<void>;
};

/** Resolve a `ws` WebSocketServer lazily, in Node only, invisibly to bundlers. */
function loadWebSocketServer(): WebSocketServerCtor {
  const specifier = 'ws';
  const nodeRequire =
    // @ts-ignore
    typeof module !== 'undefined' &&
    // @ts-ignore
    typeof (module as {require?: unknown}).require === 'function'
      ? // @ts-ignore
        (module as {require: (id: string) => unknown}).require.bind(module)
      : /* istanbul ignore next */ undefined;
  /* istanbul ignore next — only reachable in non-Node bundled environments */
  if (!nodeRequire) {
    throw new Error(
      "exposeSimulatedDevice could not load 'ws'. Pass options.WebSocketServer, " +
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

export function exposeSimulatedDevice<D extends SimulatedDevice>(
  simulatedDevice: D,
  options: ExposeSimulatedDeviceOptions,
): ExposedDevice<D> {
  const transport = new InMemorySerialTransport();
  const device = transport.addDevice(simulatedDevice, {
    hasPermission: true,
    ...options.device,
  });

  const Ctor = options.WebSocketServer ?? loadWebSocketServer();
  const server = new Ctor({port: options.port, host: options.host});
  server.on('connection', socket => {
    const serial = SimulatedDeviceToSerialLike(transport, device);
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
    simulatedDevice,
    whenOpened: () => device.whenOpened(),
    whenClosed: () => device.whenClosed(),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
