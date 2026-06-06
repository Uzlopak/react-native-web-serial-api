/**
 * `mountSerialDevice` — the one-call fixture for testing serial code. It wires a
 * {@link SerialDevice} simulator to a {@link VirtualSerialTransport} + `Serial`,
 * and hands back everything a test needs to drive *both* sides:
 *
 *   - `serial`/`port` — what the app-under-test consumes,
 *   - `serialDevice` (typed) + `device` handle — drive the device (inject data,
 *     move the GPS, inject faults),
 *   - `client` — a host-side {@link SerialTestHarness} (for protocol tests), and
 *   - `whenOpened()/whenClosed()` — `await` the app connecting.
 *
 * @example Test how your app reacts to a device event
 * const {serialDevice, device, whenOpened} = await mountSerialDevice(new MyGps());
 * renderMyApp(); // opens the port itself
 * await whenOpened();
 * serialDevice.update({latitude: 51.48, longitude: 0});
 * // …assert your app's UI updated
 */

import {setUsbSerial} from '../UsbSerial';
import type {SerialPort} from '../WebSerial';
import {Serial} from '../WebSerial';
import type {SerialDevice, SerialDeviceOpenOptions} from './serial-device';
import {SerialTestHarness} from './serial-test-harness';
import type {
  VirtualSerialDeviceOptions,
  VirtualSerialTransportOptions,
} from './virtual-serial-device';
import {
  type VirtualSerialDevice,
  VirtualSerialTransport,
} from './virtual-serial-device';

export type MountSerialDeviceOptions = {
  /** Per-device transport knobs (single-device form). */
  device?: VirtualSerialDeviceOptions;
  /** Per-device transport knobs, by index (multi-device form). */
  devices?: VirtualSerialDeviceOptions[];
  /** Transport-level options (latencyMs, chunkSize, autoGrantPermission). */
  transport?: VirtualSerialTransportOptions;
  /** Whether each device is already permitted. Defaults to true (so it lists). */
  hasPermission?: boolean;
  /** Also `setUsbSerial(transport)` so a running app's `serial` sees it. Default false. */
  installGlobally?: boolean;
  /** Options for the host-side {@link SerialTestHarness}. */
  client?: {defaultTimeoutMs?: number};
};

export type MountedSerialDevice<D extends SerialDevice = SerialDevice> = {
  transport: VirtualSerialTransport;
  serial: Serial;
  port: SerialPort;
  /** The transport-side handle: push/emitError/failNext/written/attach/detach/… */
  device: VirtualSerialDevice;
  /** The concrete device simulator, typed (e.g. call `gps.update(...)`). */
  serialDevice: D;
  /** A host-side client bound to `port` — NOT opened (call `client.open()`). */
  client: SerialTestHarness;
  /** Resolve when the app opens the port (now if already open). */
  whenOpened(): Promise<SerialDeviceOpenOptions>;
  /** Resolve when the app closes the port (now if not open). */
  whenClosed(): Promise<void>;
};

export type MountedSerialDevices = {
  transport: VirtualSerialTransport;
  serial: Serial;
  ports: SerialPort[];
  devices: VirtualSerialDevice[];
  serialDevices: SerialDevice[];
  clients: SerialTestHarness[];
  /** Resolve when device `index` opens, or any device when `index` is omitted. */
  whenOpened(index?: number): Promise<SerialDeviceOpenOptions>;
  /** Resolve when device `index` closes, or any device when `index` is omitted. */
  whenClosed(index?: number): Promise<void>;
};

export function mountSerialDevice<D extends SerialDevice>(
  device: D,
  options?: MountSerialDeviceOptions,
): Promise<MountedSerialDevice<D>>;
export function mountSerialDevice(
  devices: SerialDevice[],
  options?: MountSerialDeviceOptions,
): Promise<MountedSerialDevices>;
export async function mountSerialDevice(
  deviceOrDevices: SerialDevice | SerialDevice[],
  options: MountSerialDeviceOptions = {},
): Promise<MountedSerialDevice | MountedSerialDevices> {
  const list = Array.isArray(deviceOrDevices)
    ? deviceOrDevices
    : [deviceOrDevices];
  const hasPermission = options.hasPermission ?? true;
  const transport = new VirtualSerialTransport(options.transport);
  const handles = list.map((dev, i) =>
    transport.addDevice(dev, {
      hasPermission,
      ...(Array.isArray(deviceOrDevices)
        ? options.devices?.[i]
        : options.device),
    }),
  );
  const serial = new Serial(transport);
  if (options.installGlobally) setUsbSerial(transport);

  const ports = await serial.getPorts();
  const clients = ports.map(
    p =>
      new SerialTestHarness(p, {
        defaultTimeoutMs: options.client?.defaultTimeoutMs,
      }),
  );

  if (!Array.isArray(deviceOrDevices)) {
    const handle = handles[0];
    const port = ports[0];
    if (!port) throw new Error('mountSerialDevice: device did not enumerate');
    return {
      transport,
      serial,
      port,
      device: handle,
      serialDevice: deviceOrDevices,
      client: clients[0],
      whenOpened: () => handle.whenOpened(),
      whenClosed: () => handle.whenClosed(),
    };
  }

  return {
    transport,
    serial,
    ports,
    devices: handles,
    serialDevices: list,
    clients,
    whenOpened: (index?: number) =>
      index === undefined
        ? Promise.race(handles.map(h => h.whenOpened()))
        : handles[index].whenOpened(),
    whenClosed: (index?: number) =>
      index === undefined
        ? Promise.race(handles.map(h => h.whenClosed()))
        : handles[index].whenClosed(),
  };
}
