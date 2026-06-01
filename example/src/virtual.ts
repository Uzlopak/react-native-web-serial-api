import {VirtualSerialTransport} from 'react-native-web-serial-api/testing';

const encode = (text: string): number[] =>
  Array.from(text, c => c.charCodeAt(0) & 0xff);

/**
 * Build the in-memory transport used by the example's "Virtual device (demo)"
 * mode, so the entire Devices → Connect → Terminal flow works with no USB
 * hardware attached — on a device, an emulator, or in the browser.
 *
 * Two fake devices:
 *  - an FTDI that echoes everything you type (already permitted), and
 *  - a CP210x "sensor" that replies to each line with a fake reading and starts
 *    un-permitted, so you can exercise the tap-to-grant flow too.
 */
export function createDemoTransport(): VirtualSerialTransport {
  // A little latency makes streaming feel like real hardware.
  const transport = new VirtualSerialTransport({latencyMs: 15});

  transport.addDevice({
    usbVendorId: 0x0403,
    usbProductId: 0x6001,
    serialNumber: 'VIRT-FTDI-ECHO',
    hasPermission: true,
    behavior: 'echo',
  });

  transport.addDevice({
    usbVendorId: 0x10c4,
    usbProductId: 0xea60,
    serialNumber: 'VIRT-CP210x-SENSOR',
    hasPermission: false,
    behavior: data => {
      const line = String.fromCharCode(...data).trim();
      const celsius = (20 + Math.random() * 5).toFixed(1);
      return encode(`sensor[${line || 'ping'}] = ${celsius}C\r\n`);
    },
  });

  return transport;
}
