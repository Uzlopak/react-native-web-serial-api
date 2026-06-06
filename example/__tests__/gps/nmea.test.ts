/**
 * Unit tests for the pure NMEA 0183 core (no SimulatedDevice, no transport).
 * Greenwich Royal Observatory: lat 51.476852, lon -0.000500.
 */
import {describe, expect, it} from '@jest/globals';
import {
  assemble,
  buildCycle,
  checksum,
  DEFAULT_FIX,
  formatLatitude,
  formatLongitude,
  makeSatellites,
  utcDate,
  utcTime,
} from '../../src/devices/gps/nmea';

// 2024-01-02 12:00:00.000 UTC — a fixed clock for deterministic time fields.
const FIXED = new Date(Date.UTC(2024, 0, 2, 12, 0, 0));

/** Re-derive the checksum from the sentence body and compare to the suffix. */
function checksumValid(sentence: string): boolean {
  const match = sentence.match(/^\$(.+)\*([0-9A-F]{2})\r\n$/);
  return match ? checksum(match[1]) === match[2] : false;
}

describe('checksum', () => {
  it('matches the reference XOR vector', () => {
    expect(
      checksum(
        'GPRMC,095940.000,A,5432.216088,N,01832.664132,E,0.019,0.00,130720,,,A',
      ),
    ).toBe('59');
  });
});

describe('coordinate formatting (ddmm.mmmm / dddmm.mmmm)', () => {
  it('formats the Greenwich latitude', () => {
    expect(formatLatitude(51.476852)).toEqual({
      value: '5128.6111',
      hemisphere: 'N',
    });
  });

  it('formats a longitude just west of the prime meridian', () => {
    expect(formatLongitude(-0.0005)).toEqual({
      value: '00000.0300',
      hemisphere: 'W',
    });
  });

  it('selects S/E hemispheres for negative lat / positive lon', () => {
    expect(formatLatitude(-33.8688).hemisphere).toBe('S');
    expect(formatLongitude(151.2093).hemisphere).toBe('E');
  });
});

describe('utc helpers', () => {
  it('formats time as hhmmss.ss and date as ddmmyy', () => {
    expect(utcTime(FIXED)).toBe('120000.00');
    expect(utcDate(FIXED)).toBe('020124');
  });
});

describe('assemble', () => {
  it('wraps fields as $GP<type>,<fields>*HH\\r\\n with a valid checksum', () => {
    const sentence = assemble('GLL', [
      '5128.6111',
      'N',
      '00000.0300',
      'W',
      '120000.00',
      'A',
    ]);
    expect(sentence.startsWith('$GPGLL,')).toBe(true);
    expect(sentence.endsWith('\r\n')).toBe(true);
    expect(checksumValid(sentence)).toBe(true);
  });
});

describe('buildCycle (default Greenwich fix)', () => {
  const lines = buildCycle(DEFAULT_FIX, FIXED);

  it('encodes the Greenwich position in GGA and RMC', () => {
    const gga = lines.find(l => l.startsWith('$GPGGA'));
    const rmc = lines.find(l => l.startsWith('$GPRMC'));
    expect(gga).toContain('5128.6111,N,00000.0300,W');
    expect(rmc).toContain('5128.6111,N,00000.0300,W');
  });

  it('produces a valid checksum on every emitted sentence', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(checksumValid(line)).toBe(true);
    }
  });

  it('reports satellites in view via GSV', () => {
    expect(lines.some(l => l.startsWith('$GPGSV'))).toBe(true);
  });

  it('matches the golden GGA prefix (fixed clock)', () => {
    const gga = lines.find(l => l.startsWith('$GPGGA'));
    expect(gga).toContain('$GPGGA,120000.00,5128.6111,N,00000.0300,W,1,12,');
  });
});

describe('makeSatellites', () => {
  it('creates the requested count with a uniform SNR when given', () => {
    const sats = makeSatellites(12, {snrDb: 50});
    expect(sats).toHaveLength(12);
    expect(sats.every(s => s.snrDb === 50)).toBe(true);
  });
});
