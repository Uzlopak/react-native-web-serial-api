/**
 * @format
 */

import {describe, expect, it} from '@jest/globals';
import {DEFAULT_SETTINGS, toSerialOptions} from '../src/settings';

describe('settings', () => {
  it('maps the connection form onto Web Serial open options', () => {
    expect(
      toSerialOptions({
        baudRate: 57600,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
        flowControl: 'hardware',
      }),
    ).toEqual({
      baudRate: 57600,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
      flowControl: 'hardware',
    });
  });

  it('keeps the default connection settings intact', () => {
    expect(toSerialOptions(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});
