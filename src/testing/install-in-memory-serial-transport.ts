/**
 * installInMemorySerialTransport — point the library at a simulated device set in one call.
 *
 * Built for E2E: call it once at app startup, behind your own env/build flag, to
 * make `navigator.serial` / this library's `serial` talk to simulated
 * {@link SimulatedDevice}s instead of real USB hardware while a test driver
 * (Maestro, Detox, …) exercises the app on a device/emulator.
 *
 * @example
 * // index.js (debug/E2E build only)
 * import {installInMemorySerialTransport, LoopbackDevice} from 'react-native-web-serial-api/testing';
 * installInMemorySerialTransport({
 *   enabled: process.env.RNWS_SERIAL_MOCK === '1',
 *   devices: [new LoopbackDevice(), new MyThermometer()],
 * });
 */
import {setUsbSerial} from '../UsbSerial';
import type {
  DeviceOptions,
  InMemorySerialTransportOptions,
} from './in-memory-serial-transport';
import {InMemorySerialTransport} from './in-memory-serial-transport';
import {SimulatedDevice} from './simulated-device';

/** A device to register: a SimulatedDevice, optionally with transport options. */
export type SimulatedTransportDevice =
  | SimulatedDevice
  | {device: SimulatedDevice; options?: DeviceOptions};

export type InstallInMemorySerialTransportOptions = {
  /** The simulated devices to expose. */
  devices: SimulatedTransportDevice[];
  /** When false, no mock is installed and `null` is returned. Defaults to true. */
  enabled?: boolean;
  /** Transport-level options (latency, chunkSize, …). */
  transport?: InMemorySerialTransportOptions;
};

/**
 * Build an {@link InMemorySerialTransport} from `devices` and install it globally
 * via {@link setUsbSerial}. SimulatedDevices default to granted USB permission (so
 * they show up immediately); pass the `{device, options}` form to override.
 * Returns the transport (handy for driving devices in-test), or `null` when
 * disabled.
 */
export function installInMemorySerialTransport(
  options: InstallInMemorySerialTransportOptions,
): InMemorySerialTransport | null {
  if (options.enabled === false) return null;

  const transport = new InMemorySerialTransport(options.transport);
  for (const entry of options.devices) {
    if (entry instanceof SimulatedDevice) {
      transport.addDevice(entry, {hasPermission: true});
    } else {
      transport.addDevice(entry.device, {
        hasPermission: true,
        ...entry.options,
      });
    }
  }

  setUsbSerial(transport);
  return transport;
}
