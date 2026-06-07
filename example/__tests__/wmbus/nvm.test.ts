/**
 * @format
 */

import {expect, it} from '@jest/globals';
import {encodeDeviceItem} from '../../src/devices/wmbus/nvm';

it('pads short device-list keys with zeroes', () => {
  const bytes = encodeDeviceItem({
    address: {
      manufacturerId: 0x1234,
      deviceId: 0x56789abc,
      version: 0x01,
      type: 0x07,
    },
    key: [0xaa, 0xbb],
  });

  expect(bytes).toHaveLength(24);
  expect(bytes.slice(8)).toEqual([
    0xaa, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
});
