/**
 * @format
 */
import {describe, expect, it} from '@jest/globals';
import {crc16, crc16Bytes} from '../../src/devices/wmbus/crc16';

const ascii = (s: string): number[] => Array.from(s, c => c.charCodeAt(0));

describe('crc16 (IBM-SDLC / X-25)', () => {
  it('matches the canonical check vector for "123456789"', () => {
    // CRC-16/X-25 check value.
    expect(crc16(ascii('123456789'))).toBe(0x906e);
  });

  it('returns 0x0000 for an empty input', () => {
    expect(crc16([])).toBe(0x0000);
  });

  it('appends the CRC LSB first', () => {
    expect(crc16Bytes(ascii('123456789'))).toEqual([0x6e, 0x90]);
  });

  it('ignores bits above the low byte of each input value', () => {
    expect(crc16([0x1ff, 0x200])).toBe(crc16([0xff, 0x00]));
  });

  it('detects single-bit corruption', () => {
    const msg = [0x01, 0x01, 0x16, 0x07];
    const bad = [...msg];
    bad[2] ^= 0x01;
    expect(crc16(bad)).not.toBe(crc16(msg));
  });
});
