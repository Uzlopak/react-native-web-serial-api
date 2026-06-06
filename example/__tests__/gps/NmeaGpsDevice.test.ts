/**
 * Integration tests for the NMEA GPS emulator driven through the real
 * Serial/SerialPort polyfill over a InMemorySerialTransport — plus the
 * programmatic update() path (no serial round-trip).
 */
import {afterEach, describe, expect, it} from '@jest/globals';
import type {SerialPort} from 'react-native-web-serial-api';
import {Serial} from 'react-native-web-serial-api';
import {InMemorySerialTransport} from 'react-native-web-serial-api/testing';
import {NmeaGpsDevice} from '../../src/devices/gps/NmeaGpsDevice';
import {makeSatellites} from '../../src/devices/gps/nmea';

const FIXED = new Date(Date.UTC(2024, 0, 2, 12, 0, 0));

async function mount(device: NmeaGpsDevice): Promise<SerialPort> {
  const transport = new InMemorySerialTransport();
  transport.addDevice(device, {hasPermission: true});
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) throw new Error('expected exactly one virtual port');
  await port.open({baudRate: 9600});
  return port;
}

function decode(bytes: Uint8Array | undefined): string {
  return bytes ? String.fromCharCode(...bytes) : '';
}

/** Read from the port until `marker` appears (or the stream closes). */
async function readUntil(port: SerialPort, marker: string): Promise<string> {
  const reader = port.readable!.getReader();
  let text = '';
  try {
    while (!text.includes(marker)) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decode(value);
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

describe('NmeaGpsDevice', () => {
  let port: SerialPort | undefined;

  afterEach(async () => {
    if (port) {
      await port.close().catch(() => undefined);
      port = undefined;
    }
  });

  it('streams a Greenwich $GPGGA over the serial port on open', async () => {
    const gps = new NmeaGpsDevice({clock: () => FIXED});
    port = await mount(gps);

    const text = await readUntil(port, '$GPGGA');
    expect(text).toContain('5128.6111,N,00000.0300,W');

    const gga = text.split('\r\n').find(l => l.startsWith('$GPGGA'));
    expect(gga).toMatch(/^\$GPGGA,.*\*[0-9A-F]{2}$/);
  });

  it('changes position and signal strength via update() — no serial write', () => {
    const gps = new NmeaGpsDevice({clock: () => FIXED});

    // Drive the receiver to Sydney and set 12 satellites at 50 dB SNR, all
    // programmatically — without writing anything to the serial port.
    gps.update({latitude: -33.8688, longitude: 151.2093});
    gps.update({
      satellites: makeSatellites(12, {snrDb: 50}),
      satellitesUsed: 12,
    });

    const lines = gps.sentences();
    const gga = lines.find(l => l.startsWith('$GPGGA'));
    expect(gga).toContain('3352.1280,S,15112.5580,E');

    const gsv = lines.filter(l => l.startsWith('$GPGSV')).join('');
    expect(gsv).toContain('50'); // SNR / signal strength is reflected
    expect(gps.fix.latitude).toBeCloseTo(-33.8688);
    expect(gps.fix.satellitesUsed).toBe(12);
  });

  it('survives a close + reopen (clean timer lifecycle)', async () => {
    const gps = new NmeaGpsDevice({clock: () => FIXED});

    port = await mount(gps);
    expect(await readUntil(port, '$GPGGA')).toContain('$GPGGA');
    await port.close();

    port = await mount(gps);
    expect(await readUntil(port, '$GPGGA')).toContain('$GPGGA');
  });
});
