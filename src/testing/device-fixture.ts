/**
 * `createDeviceFixture` — the one-call fixture for testing serial code. It wires a
 * {@link SimulatedDevice} simulator to an {@link InMemorySerialTransport} + `Serial`,
 * and hands back everything a test needs to drive *both* sides:
 *
 *   - `serial`/`port` — what the app-under-test consumes,
 *   - `simulatedDevice` (typed) + `device` handle — drive the device (inject data,
 *     move the GPS, inject faults),
 *   - `client` — a host-side {@link SerialClient} (for protocol tests), and
 *   - `whenOpened()/whenClosed()` — `await` the app connecting.
 *
 * @example Test how your app reacts to a device event
 * const {simulatedDevice, device, whenOpened} = await createDeviceFixture(new MyGps());
 * renderMyApp(); // opens the port itself
 * await whenOpened();
 * simulatedDevice.update({latitude: 51.48, longitude: 0});
 * // …assert your app's UI updated
 */

import {setUsbSerial} from '../UsbSerial';
import type {SerialPort} from '../WebSerial';
import {Serial} from '../WebSerial';
import type {
  DeviceOptions,
  InMemorySerialTransportOptions,
} from './in-memory-serial-transport';
import {
  type DeviceHandle,
  InMemorySerialTransport,
} from './in-memory-serial-transport';
import {SerialClient} from './serial-client';
import type {
  SimulatedDevice,
  SimulatedDeviceOpenOptions,
} from './simulated-device';

export type DeviceFixtureOptions = {
  /** Per-device transport knobs (single-device form). */
  device?: DeviceOptions;
  /** Per-device transport knobs, by index (multi-device form). */
  devices?: DeviceOptions[];
  /** Transport-level options (latencyMs, chunkSize, autoGrantPermission). */
  transport?: InMemorySerialTransportOptions;
  /** Whether each device is already permitted. Defaults to true (so it lists). */
  hasPermission?: boolean;
  /** Also `setUsbSerial(transport)` so a running app's `serial` sees it. Default false. */
  installGlobally?: boolean;
  /** Options for the host-side {@link SerialClient}. */
  client?: {defaultTimeoutMs?: number};
};

export type MountedDeviceFixture<D extends SimulatedDevice = SimulatedDevice> =
  {
    transport: InMemorySerialTransport;
    serial: Serial;
    port: SerialPort;
    /** The transport-side handle: push/emitError/failNext/written/attach/detach/… */
    device: DeviceHandle;
    /** The concrete device simulator, typed (e.g. call `gps.update(...)`). */
    simulatedDevice: D;
    /** A host-side client bound to `port` — NOT opened (call `client.open()`). */
    client: SerialClient;
    /** Resolve when the app opens the port (now if already open). */
    whenOpened(): Promise<SimulatedDeviceOpenOptions>;
    /** Resolve when the app closes the port (now if not open). */
    whenClosed(): Promise<void>;
  };

export type MountedDeviceFixtures = {
  transport: InMemorySerialTransport;
  serial: Serial;
  ports: SerialPort[];
  devices: DeviceHandle[];
  simulatedDevices: SimulatedDevice[];
  clients: SerialClient[];
  /** Resolve when device `index` opens, or any device when `index` is omitted. */
  whenOpened(index?: number): Promise<SimulatedDeviceOpenOptions>;
  /** Resolve when device `index` closes, or any device when `index` is omitted. */
  whenClosed(index?: number): Promise<void>;
};

export function createDeviceFixture<D extends SimulatedDevice>(
  device: D,
  options?: DeviceFixtureOptions,
): Promise<MountedDeviceFixture<D>>;
export function createDeviceFixture(
  devices: SimulatedDevice[],
  options?: DeviceFixtureOptions,
): Promise<MountedDeviceFixtures>;
export async function createDeviceFixture(
  deviceOrDevices: SimulatedDevice | SimulatedDevice[],
  options: DeviceFixtureOptions = {},
): Promise<MountedDeviceFixture | MountedDeviceFixtures> {
  const list = Array.isArray(deviceOrDevices)
    ? deviceOrDevices
    : [deviceOrDevices];
  const hasPermission = options.hasPermission ?? true;
  const transport = new InMemorySerialTransport(options.transport);
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
      new SerialClient(p, {
        defaultTimeoutMs: options.client?.defaultTimeoutMs,
      }),
  );

  if (!Array.isArray(deviceOrDevices)) {
    const handle = handles[0];
    const port = ports[0];
    if (!port) throw new Error('createDeviceFixture: device did not enumerate');
    return {
      transport,
      serial,
      port,
      device: handle,
      simulatedDevice: deviceOrDevices,
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
    simulatedDevices: list,
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
