/**
 * @format
 */

import {describe, expect, it} from '@jest/globals';
import {ByteReader, ByteWriter} from '../../src/devices/wmbus/bytes';
import {
  addressFromPacket,
  buildWMBusPacket,
  readAddress,
  writeAddress,
} from '../../src/devices/wmbus/frame';

const ADDRESS = {
  manufacturerId: 0x1234,
  deviceId: 0x56789abc,
  version: 0x01,
  type: 0x07,
};

describe('WM-Bus frame helpers', () => {
  it('writes and reads an address in wire order', () => {
    const w = new ByteWriter();
    writeAddress(w, ADDRESS);
    expect(readAddress(new ByteReader(w.bytes))).toEqual(ADDRESS);
  });

  it('builds a packet with the computed length and default C-field', () => {
    const packet = buildWMBusPacket(ADDRESS, [0x01, 0x02, 0x03]);
    expect(packet[0]).toBe(packet.length - 1);
    expect(packet[1]).toBe(0x44);
    expect(addressFromPacket(packet)).toEqual(ADDRESS);
    expect(packet.slice(-3)).toEqual([0x01, 0x02, 0x03]);
  });

  it('supports a custom C-field', () => {
    const packet = buildWMBusPacket(ADDRESS, [], 0x99);
    expect(packet[1]).toBe(0x99);
  });

  it('defaults to an empty payload when no data is supplied', () => {
    const packet = buildWMBusPacket(ADDRESS);
    expect(packet).toHaveLength(1 + 1 + 2 + 4 + 1 + 1);
    expect(packet.slice(-2)).toEqual([ADDRESS.version, ADDRESS.type]);
  });
});
