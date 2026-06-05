/**
 * installSerialMock — point the library at a virtual device set in one call.
 *
 * Built for E2E: call it once at app startup, behind your own env/build flag, to
 * make `navigator.serial` / this library's `serial` talk to simulated
 * {@link SerialDevice}s instead of real USB hardware while a test driver
 * (Maestro, Detox, …) exercises the app on a device/emulator.
 *
 * @example
 * // index.js (debug/E2E build only)
 * import {installSerialMock, EchoDevice} from 'react-native-web-serial-api/testing';
 * installSerialMock({
 *   enabled: process.env.RNWS_SERIAL_MOCK === '1',
 *   devices: [new EchoDevice(), new MyThermometer()],
 * });
 */
import {setUsbSerial} from '../UsbSerial';
import {SerialDevice} from './serial-device';
import type {
  VirtualSerialDeviceOptions,
  VirtualSerialTransportOptions,
} from './virtual-serial-device';
import {VirtualSerialTransport} from './virtual-serial-device';

/** A device to register: a SerialDevice, optionally with transport options. */
export type SerialMockDevice =
  | SerialDevice
  | {device: SerialDevice; options?: VirtualSerialDeviceOptions};

export type InstallSerialMockOptions = {
  /** The simulated devices to expose. */
  devices: SerialMockDevice[];
  /** When false, no mock is installed and `null` is returned. Defaults to true. */
  enabled?: boolean;
  /** Transport-level options (latency, chunkSize, …). */
  transport?: VirtualSerialTransportOptions;
};

/**
 * Build a {@link VirtualSerialTransport} from `devices` and install it globally
 * via {@link setUsbSerial}. SerialDevices default to granted USB permission (so
 * they show up immediately); pass the `{device, options}` form to override.
 * Returns the transport (handy for driving devices in-test), or `null` when
 * disabled.
 */
export function installSerialMock(
  options: InstallSerialMockOptions,
): VirtualSerialTransport | null {
  if (options.enabled === false) return null;

  const transport = new VirtualSerialTransport(options.transport);
  for (const entry of options.devices) {
    if (entry instanceof SerialDevice) {
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
