/**
 * Adapt an in-memory {@link VirtualSerialDevice} simulator to the
 * `serialport`-style {@link SerialLike} that {@link attachBridge} consumes, so a
 * test can expose a *simulated* device over a WebSocket and have a real app
 * connect to it with `new WebSocketSerialTransport(url)`. This is what makes the
 * *same* device-driving test run in Jest (in-memory) and on a device/emulator
 * (over the socket).
 *
 * Pure — no `ws`/`serialport`/Node imports — so it unit-tests with the same
 * `FakeWs` + `attachBridge` fakes the bridge core uses. The lazy-`ws` server
 * wrapper lives in `react-native-web-serial-api/testing` (`exposeSerialDevice`).
 *
 * Mapping (host app ⇄ simulator):
 *   - client binary frame → `write` → `device.onData`,
 *   - `setLineCoding`/`setBaudRate` → `update` → opens the sim + starts reading,
 *   - `setSignals` → `set` → `device.onHostSignals`,
 *   - `getSignals` → `get` → the device's asserted input signals,
 *   - `device.send(...)` → `'data'` → client binary frame,
 *   - `getPortInfo` → {@link portInfoFromDevice}.
 */

import type {
  VirtualSerialDevice,
  VirtualSerialTransport,
} from '../testing/virtual-serial-device';
import type {DataEvent, ErrorEvent} from '../transport';
import type {SerialLike} from './bridge';
import type {PortInfo} from './protocol';

/** The bridge's `getPortInfo` metadata, taken from the device's USB identity. */
export function portInfoFromDevice(device: VirtualSerialDevice): PortInfo {
  return {
    usbVendorId: device.usbVendorId,
    usbProductId: device.usbProductId,
    serialNumber: device.serialNumber,
  };
}

/**
 * Build a {@link SerialLike} backed by `device` (already registered on
 * `transport` via `addDevice`). One adapter per WebSocket connection; its
 * transport subscriptions are released when the bridge tears down its listeners.
 */
export function serialDeviceToSerialLike(
  transport: VirtualSerialTransport,
  device: VirtualSerialDevice,
): SerialLike {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const errorListeners = new Set<(err: Error) => void>();
  const openListeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();

  // The device's `send(...)` surfaces here as a transport data event; forward
  // the bytes of *this* device to the bridge's 'data' listener.
  const dataSub = transport.onData((e: DataEvent) => {
    if (e.deviceId !== device.deviceId) return;
    const bytes = Uint8Array.from(e.data);
    for (const l of dataListeners) l(bytes);
  });
  const errorSub = transport.onError((e: ErrorEvent) => {
    if (e.deviceId !== device.deviceId) return;
    const err = new Error(e.error);
    err.name = e.errorName ?? err.name;
    for (const l of errorListeners) l(err);
  });

  const id = () => device.deviceId;
  const port = () => device.portNumber;

  /** Open the sim on first use (the app's open handshake), else just re-baud. */
  const ensureOpen = async (baudRate: number): Promise<void> => {
    if (device.isOpen) {
      await transport.setParameters(id(), port(), {baudRate});
      return;
    }
    await transport.open(id(), port(), {baudRate});
    // The device only forwards `send(...)` while "reading"; the bridge's own
    // startReading toggles client forwarding, not the device, so enable it here.
    await transport.startReading(id(), port());
    for (const l of openListeners) l();
  };

  const cleanupIfIdle = (): void => {
    if (dataListeners.size === 0 && errorListeners.size === 0) {
      dataSub.remove();
      errorSub.remove();
    }
  };

  return {
    write(data, cb) {
      transport.write(id(), port(), Array.from(data)).then(
        () => cb?.(null),
        err => cb?.(err as Error),
      );
    },
    set(opts, cb) {
      const ops: Array<Promise<void>> = [];
      if (opts.dtr !== undefined)
        ops.push(transport.setDTR(id(), port(), opts.dtr));
      if (opts.rts !== undefined)
        ops.push(transport.setRTS(id(), port(), opts.rts));
      if (opts.brk !== undefined)
        ops.push(transport.setBreak(id(), port(), opts.brk));
      Promise.all(ops).then(
        () => cb?.(null),
        err => cb?.(err as Error),
      );
    },
    get(cb) {
      Promise.all([
        transport.getCTS(id(), port()),
        transport.getDSR(id(), port()),
        transport.getCD(id(), port()),
        transport.getRI(id(), port()),
      ]).then(
        ([cts, dsr, dcd, ri]) => cb(null, {cts, dsr, dcd, ri}),
        err => cb(err as Error),
      );
    },
    update(opts, cb) {
      ensureOpen(opts.baudRate).then(
        () => cb?.(null),
        err => cb?.(err as Error),
      );
    },
    flush(cb) {
      cb?.(null);
    },
    drain(cb) {
      cb?.(null);
    },
    close(cb) {
      transport.close(id(), port()).then(
        () => {
          for (const l of closeListeners) l();
          cb?.(null);
        },
        err => cb?.(err as Error),
      );
    },
    on(event: string, listener: (...args: never[]) => void) {
      if (event === 'data')
        dataListeners.add(listener as (d: Uint8Array) => void);
      else if (event === 'error')
        errorListeners.add(listener as (e: Error) => void);
      else if (event === 'open') openListeners.add(listener as () => void);
      else if (event === 'close') closeListeners.add(listener as () => void);
    },
    removeListener(event: string, listener: (...args: never[]) => void) {
      if (event === 'data')
        dataListeners.delete(listener as (d: Uint8Array) => void);
      else if (event === 'error')
        errorListeners.delete(listener as (e: Error) => void);
      else if (event === 'open') openListeners.delete(listener as () => void);
      else if (event === 'close') closeListeners.delete(listener as () => void);
      cleanupIfIdle();
    },
  };
}
