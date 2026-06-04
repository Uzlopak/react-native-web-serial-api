/**
 * @format
 */
import {describe, expect, it} from '@jest/globals';
import {SLIP, SlipDecoder, slipEncode} from '../../src/devices/wmbus/slip';

describe('SLIP framing', () => {
  it('wraps the payload in END … END', () => {
    expect(slipEncode([0x01, 0x02])).toEqual([
      SLIP.END,
      0x01,
      0x02,
      SLIP.END,
    ]);
  });

  it('escapes END and ESC bytes in the payload', () => {
    expect(slipEncode([SLIP.END, SLIP.ESC, 0x00])).toEqual([
      SLIP.END,
      SLIP.ESC,
      SLIP.ESC_END,
      SLIP.ESC,
      SLIP.ESC_ESC,
      0x00,
      SLIP.END,
    ]);
  });

  it('round-trips an arbitrary payload including escaped bytes', () => {
    const payload = [0x09, 0x20, SLIP.END, SLIP.ESC, 0xff, 0x00];
    const frames = new SlipDecoder().push(slipEncode(payload));
    expect(frames).toEqual([payload]);
  });

  it('decodes two concatenated frames from one chunk', () => {
    const chunk = [...slipEncode([0x01]), ...slipEncode([0x02, 0x03])];
    expect(new SlipDecoder().push(chunk)).toEqual([[0x01], [0x02, 0x03]]);
  });

  it('reassembles a frame split across two pushes', () => {
    const encoded = slipEncode([0x0a, 0x0b, 0x0c]);
    const cut = 3;
    const dec = new SlipDecoder();
    expect(dec.push(encoded.slice(0, cut))).toEqual([]);
    expect(dec.push(encoded.slice(cut))).toEqual([[0x0a, 0x0b, 0x0c]]);
  });

  it('ignores empty frames and leading junk before the first END', () => {
    const dec = new SlipDecoder();
    const stream = [
      0x99, // junk before any END — discarded
      SLIP.END,
      SLIP.END, // empty frame — ignored
      0x42,
      SLIP.END,
    ];
    expect(dec.push(stream)).toEqual([[0x42]]);
  });
});
