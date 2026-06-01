import {
  EchoDevice,
  VirtualSerialTransport,
} from 'react-native-web-serial-api/testing';
import {SensorDevice} from './devices/SensorDevice';

/**
 * Build the in-memory transport used by the example's "Virtual device (demo)"
 * mode, so the entire Devices → Connect → Terminal flow works with no USB
 * hardware attached — on a device, an emulator, or in the browser.
 *
 * Both devices are authored as `SerialDevice`s (the same model a consumer would
 * write for their own E2E tests):
 *  - an FTDI {@link EchoDevice} that echoes everything you type (already permitted), and
 *  - a CP210x {@link SensorDevice} that streams readings + answers commands and
 *    starts un-permitted, so you can exercise the tap-to-grant flow too.
 */
export function createDemoTransport(): VirtualSerialTransport {
  // A little latency makes streaming feel like real hardware.
  const transport = new VirtualSerialTransport({latencyMs: 15});

  transport.addDevice(
    new EchoDevice({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      serialNumber: 'VIRT-FTDI-ECHO',
    }),
    {hasPermission: true},
  );

  transport.addDevice(new SensorDevice(), {hasPermission: false});

  return transport;
}
