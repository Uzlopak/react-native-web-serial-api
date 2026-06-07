/**
 * @format
 */

import {describe, expect, it} from '@jest/globals';
import {ByteReader, ByteWriter} from '../../src/devices/wmbus/bytes';

describe('ByteWriter / ByteReader', () => {
  it('writes integers in little- and big-endian form', () => {
    const bytes = new ByteWriter()
      .u8(0x11)
      .u16le(0x2233)
      .u32le(0x44556677)
      .u16be(0x8899)
      .u32be(0xaabbccdd).bytes;

    expect(bytes).toEqual([
      0x11, 0x33, 0x22, 0x77, 0x66, 0x55, 0x44, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
      0xdd,
    ]);
  });

  it('writes raw data and ASCII strings with optional padding', () => {
    const bytes = new ByteWriter().raw([0x01, 0x1ff]).ascii('AB', 4).bytes;
    expect(bytes).toEqual([0x01, 0xff, 0x41, 0x42, 0x00, 0x00]);
  });

  it('reads values back and exposes the remaining byte count', () => {
    const r = new ByteReader([0x11, 0x33, 0x22, 0x77, 0x66, 0x55, 0x44]);
    expect(r.remaining).toBe(7);
    expect(r.u8()).toBe(0x11);
    expect(r.u16le()).toBe(0x2233);
    expect(r.u32le()).toBe(0x44556677);
    expect(r.remaining).toBe(0);
  });

  it('reads big-endian values and the rest of the buffer', () => {
    const r = new ByteReader([0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd]);
    expect(r.u16be()).toBe(0x8899);
    expect(r.u32be()).toBe(0xaabbccdd);
    expect(r.rest()).toEqual([]);
  });
});
