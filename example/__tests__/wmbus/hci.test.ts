/**
 * @format
 */
import {describe, expect, it} from '@jest/globals';
import {DevMgmt, decodeHci, encodeHci, Sap} from '../../src/devices/wmbus/hci';
import {slipEncode} from '../../src/devices/wmbus/slip';

describe('HCI message encode/decode', () => {
  it('encodes the spec Ping-request vector incl. CRC and SLIP', () => {
    // Spec p9: Request : C0 01 01 16 07 C0
    expect(encodeHci(Sap.DevMgmt, DevMgmt.PingReq)).toEqual([
      0x01, 0x01, 0x16, 0x07,
    ]);
    expect(slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingReq))).toEqual([
      0xc0, 0x01, 0x01, 0x16, 0x07, 0xc0,
    ]);
  });

  it('encodes the spec Ping-response vector', () => {
    // Spec p9: Response: C0 01 02 00 A0 AF C0
    expect(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp, [0x00])).toEqual([
      0x01, 0x02, 0x00, 0xa0, 0xaf,
    ]);
  });

  it('round-trips an arbitrary message', () => {
    const frame = encodeHci(Sap.WMBus, 0x20, [1, 2, 3]);
    expect(decodeHci(frame)).toEqual({
      sap: 0x09,
      msg: 0x20,
      payload: [1, 2, 3],
    });
  });

  it('rejects a frame with a corrupted CRC', () => {
    const frame = encodeHci(Sap.DevMgmt, DevMgmt.PingReq);
    frame[frame.length - 1] ^= 0xff;
    expect(decodeHci(frame)).toBeNull();
  });

  it('rejects a too-short frame', () => {
    expect(decodeHci([0x01, 0x02])).toBeNull();
  });
});
