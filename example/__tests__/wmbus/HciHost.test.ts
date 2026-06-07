/**
 * @format
 */

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {HciHost} from '../../src/devices/wmbus/HciHost';
import {DevMgmt, encodeHci, Sap, WMBus} from '../../src/devices/wmbus/hci';
import {slipEncode} from '../../src/devices/wmbus/slip';

function makeClient(chunks: Uint8Array[] = []) {
  const queue = [...chunks];
  const client = {
    ended: false,
    write: jest.fn(async () => undefined),
    readAvailable: jest.fn(async () => {
      if (queue.length === 0) {
        throw new Error('timed out');
      }
      return queue.shift() as Uint8Array;
    }),
    close: jest.fn(async () => {
      client.ended = true;
    }),
  };
  return client;
}

describe('HciHost', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips unsolicited messages before the matching response', async () => {
    const client = makeClient([
      Uint8Array.from(
        slipEncode(encodeHci(Sap.WMBus, WMBus.RxMessageInd, [1])),
      ),
      Uint8Array.from(
        slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp, [0x00])),
      ),
    ]);
    const host = new HciHost(client as any);
    const skipped: Array<{sap: number; msg: number}> = [];

    const rsp = await host.exchange(
      Sap.DevMgmt,
      DevMgmt.PingReq,
      [],
      DevMgmt.PingRsp,
      undefined,
      m => skipped.push(m),
    );

    expect(rsp).toEqual({
      sap: Sap.DevMgmt,
      msg: DevMgmt.PingRsp,
      payload: [0x00],
    });
    expect(skipped).toEqual([
      expect.objectContaining({sap: Sap.WMBus, msg: WMBus.RxMessageInd}),
    ]);
  });

  it('skips undecodable frames before returning the next recv message', async () => {
    const client = makeClient([
      Uint8Array.from(slipEncode([0x7f, 0x00, 0x01, 0x02])),
      Uint8Array.from(
        slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp, [0x00])),
      ),
    ]);
    const host = new HciHost(client as any);

    await expect(host.recv()).resolves.toEqual({
      sap: Sap.DevMgmt,
      msg: DevMgmt.PingRsp,
      payload: [0x00],
    });
  });

  it('rejects recv when the underlying stream has already ended', async () => {
    const client = makeClient();
    client.ended = true;
    const host = new HciHost(client as any);

    await expect(host.recv()).rejects.toThrow('serial stream closed');
  });

  it('returns the first matching pending message in waitFor', async () => {
    const client = makeClient([
      Uint8Array.from(
        slipEncode(encodeHci(Sap.WMBus, WMBus.RxMessageInd, [1])),
      ),
      Uint8Array.from(
        slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp, [0x00])),
      ),
    ]);
    const host = new HciHost(client as any);
    const msg = await host.waitFor(Sap.DevMgmt, DevMgmt.PingRsp);

    expect(msg).toEqual({
      sap: Sap.DevMgmt,
      msg: DevMgmt.PingRsp,
      payload: [0x00],
    });
  });

  it('rejects waitFor when the underlying stream has ended', async () => {
    const client = makeClient();
    client.ended = true;
    const host = new HciHost(client as any);

    await expect(
      host.waitFor(Sap.DevMgmt, DevMgmt.PingRsp, 100),
    ).rejects.toThrow('serial stream closed');
  });

  it('times out when a response never arrives', async () => {
    const host = new HciHost(makeClient() as any);
    await expect(
      host.exchange(Sap.DevMgmt, DevMgmt.PingReq, [], DevMgmt.PingRsp, 0),
    ).rejects.toThrow('timed out waiting for response');
  });

  it('rejects exchange when the stream has already ended', async () => {
    const client = makeClient();
    client.ended = true;
    const host = new HciHost(client as any);

    await expect(
      host.exchange(Sap.DevMgmt, DevMgmt.PingReq, [], DevMgmt.PingRsp, 100),
    ).rejects.toThrow('serial stream closed');
  });

  it('times out when a waited-for message never arrives', async () => {
    const host = new HciHost(makeClient() as any);
    await expect(
      host.waitFor(Sap.WMBus, WMBus.RxMessageInd, 0),
    ).rejects.toThrow('timed out waiting for message');
  });

  it('skips undecodable frames while waiting for a matching response', async () => {
    const client = makeClient([
      Uint8Array.from(slipEncode([0x7f, 0x00, 0x01, 0x02])),
      Uint8Array.from(
        slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp, [0x00])),
      ),
    ]);
    const host = new HciHost(client as any);

    await expect(
      host.exchange(Sap.DevMgmt, DevMgmt.PingReq, [], DevMgmt.PingRsp),
    ).resolves.toEqual({
      sap: Sap.DevMgmt,
      msg: DevMgmt.PingRsp,
      payload: [0x00],
    });
  });

  it('ignores pending messages that do not satisfy the waitFor predicate', async () => {
    const client = makeClient([
      Uint8Array.from(
        slipEncode(encodeHci(Sap.WMBus, WMBus.RxMessageInd, [0x01])),
      ),
      Uint8Array.from(
        slipEncode(encodeHci(Sap.WMBus, WMBus.RxMessageInd, [0x02])),
      ),
    ]);
    const host = new HciHost(client as any);

    await expect(
      host.waitFor(
        Sap.WMBus,
        WMBus.RxMessageInd,
        undefined,
        m => m.payload[0] === 0x02,
      ),
    ).resolves.toEqual({
      sap: Sap.WMBus,
      msg: WMBus.RxMessageInd,
      payload: [0x02],
    });
  });

  it('treats a quiet timeout as non-fatal in expectNoMessage', async () => {
    const client = makeClient();
    client.readAvailable.mockRejectedValue(new Error('timed out'));
    const host = new HciHost(client as any);
    const nowSpy = jest.spyOn(Date, 'now');
    let now = 0;
    nowSpy.mockImplementation(() => {
      now += 1000;
      return now;
    });

    await expect(
      host.expectNoMessage(Sap.WMBus, WMBus.RxMessageInd),
    ).resolves.toBeUndefined();
  });

  it('rejects expectNoMessage when the unexpected message appears', async () => {
    const client = makeClient([
      Uint8Array.from(
        slipEncode(encodeHci(Sap.WMBus, WMBus.RxMessageInd, [0x01])),
      ),
      Uint8Array.from(slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp))),
    ]);
    const host = new HciHost(client as any);
    await expect(
      host.expectNoMessage(Sap.WMBus, WMBus.RxMessageInd, 1200),
    ).rejects.toThrow('unexpected message 0x9/0x20 received');
  });

  it('ignores pending messages that do not match the expectNoMessage predicate', async () => {
    const client = makeClient([
      Uint8Array.from(
        slipEncode(encodeHci(Sap.WMBus, WMBus.RxMessageInd, [0x01])),
      ),
      Uint8Array.from(
        slipEncode(encodeHci(Sap.DevMgmt, DevMgmt.PingRsp, [0x00])),
      ),
    ]);
    const host = new HciHost(client as any);

    await expect(
      host.expectNoMessage(
        Sap.WMBus,
        WMBus.RxMessageInd,
        undefined,
        m => m.payload[0] === 0x02,
      ),
    ).resolves.toBeUndefined();
  });
});
