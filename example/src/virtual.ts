import {
  InMemorySerialTransport,
  LoopbackDevice,
} from 'react-native-web-serial-api/testing';
import {NmeaGpsDevice} from './devices/gps/NmeaGpsDevice';
import {SensorDevice} from './devices/SensorDevice';
import {WMBusGateway} from './devices/wmbus/WMBusGateway';
import {WMBusMeter} from './devices/wmbus/WMBusMeter';

/**
 * Build the in-memory transport used by the example's "Virtual device (demo)"
 * mode, so the entire Devices → Connect → Terminal flow works with no USB
 * hardware attached — on a device, an emulator, or in the browser.
 *
 * Every device is authored as a `SimulatedDevice` (the same model a consumer would
 * write for their own E2E tests):
 *  - an FTDI {@link LoopbackDevice} that echoes everything you type (already permitted),
 *  - a CP210x {@link SensorDevice} that streams readings + answers commands and
 *    starts un-permitted, so you can exercise the tap-to-grant flow too,
 *  - a CH340 {@link WMBusGateway} speaking the full IMST HCI protocol, hosting a
 *    virtual meter that streams WM-Bus telegrams (HCI 0x20 events), and
 *  - a u-blox {@link NmeaGpsDevice} streaming NMEA 0183 sentences ($GPGGA,
 *    $GPRMC, …) for the Greenwich Royal Observatory position.
 */
export function createDemoTransport(): InMemorySerialTransport {
  // A little latency makes streaming feel like real hardware.
  const transport = new InMemorySerialTransport({latencyMs: 15});

  transport.addDevice(
    new LoopbackDevice({
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      serialNumber: 'VIRT-FTDI-ECHO',
    }),
    {hasPermission: true},
  );

  transport.addDevice(new SensorDevice(), {hasPermission: false});

  // A WM-Bus gateway (presented as a CH340 to stand apart from the FTDI/CP210x
  // above) hosting one encrypted virtual meter. Like real hardware, its
  // receiver is OFF until the host selects a link mode — send Set Active
  // Configuration (T-mode) as HEX to switch it on:
  //   C0 09 03 02 0E 00 00 00 32 00 88 13 00 00 D8 27 C0
  // after which the meter streams a telegram every 2s as an HCI WM-Bus Packet
  // Received (0x20) event.
  const gateway = new WMBusGateway('iU891A-XL', {
    usbVendorId: 0x04b4,
    usbProductId: 0x0003,
    serialNumber: 'VIRT-WMBUS-GW',
  });
  gateway.addMeter(
    new WMBusMeter({
      address: {
        manufacturerId: 0x1234,
        deviceId: 0x56789abc,
        version: 0x01,
        type: 0x07,
      },
      encryptionKey: new Array(16).fill(0xaa),
      linkMode: 2,
      rssi: -55,
      payloadTemplate: [0x2f, 0x2f, 0x01, 0x02, 0x03],
      intervalMs: 2000,
    }),
  );
  transport.addDevice(gateway, {hasPermission: true});

  // A GPS receiver streaming NMEA 0183 from the Greenwich Royal Observatory.
  transport.addDevice(new NmeaGpsDevice(), {hasPermission: true});

  return transport;
}
