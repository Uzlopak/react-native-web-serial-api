/**
 * @format
 */

import {describe, expect, it} from '@jest/globals';
import {Serial} from 'react-native-web-serial-api';
import {readBytes} from 'react-native-web-serial-api/testing';
import {createDemoTransport} from '../src/virtual';

describe('createDemoTransport', () => {
  it('registers the expected mix of virtual devices', async () => {
    const transport = createDemoTransport();
    const serial = new Serial(transport);

    const drivers = await transport.findAllDrivers();
    const ports = await serial.getPorts();

    expect(drivers).toHaveLength(4);
    expect(ports).toHaveLength(3);
    expect(
      drivers.some(p => p.usbVendorId === 0x10c4 && !p.hasPermission),
    ).toBe(true);
    expect(ports.map(p => p.getInfo())).toEqual(
      expect.arrayContaining([
        {usbVendorId: 0x0403, usbProductId: 0x6001},
        {usbVendorId: 0x04b4, usbProductId: 0x0003},
        {usbVendorId: 0x1546, usbProductId: 0x01a7},
      ]),
    );
  });

  it('keeps the FTDI loopback port echoing bytes', async () => {
    const transport = createDemoTransport();
    const serial = new Serial(transport);
    const [port] = (await serial.getPorts()).filter(
      p => p.getInfo().usbVendorId === 0x0403,
    );
    if (!port) throw new Error('expected the FTDI loopback port');

    await port.open({baudRate: 115200});
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();
    await writer.write(Uint8Array.from([0x61, 0x62, 0x63]));
    expect(Array.from(await readBytes(reader, 3))).toEqual([0x61, 0x62, 0x63]);
    reader.releaseLock();
    writer.releaseLock();
    await port.close();
  });
});
