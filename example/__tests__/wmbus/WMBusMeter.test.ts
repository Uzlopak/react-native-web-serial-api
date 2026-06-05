/**
 * @format
 *
 * Virtual meters inject telegrams into the gateway, which forwards them to the
 * serial host as WM-Bus Packet Received (0x20) events — but only once the host
 * has switched the receiver on (Set Active Configuration with a link mode).
 */
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {SerialPort} from 'react-native-web-serial-api';
import {Serial} from 'react-native-web-serial-api';
import {VirtualSerialTransport} from 'react-native-web-serial-api/testing';
import {ByteReader} from '../../src/devices/wmbus/bytes';
import {readAddress} from '../../src/devices/wmbus/frame';
import {
  DevMgmt,
  decodeHci,
  encodeHci,
  type HciMessage,
  Sap,
  WMBus,
} from '../../src/devices/wmbus/hci';
import {SlipDecoder, slipEncode} from '../../src/devices/wmbus/slip';
import {WMBusGateway} from '../../src/devices/wmbus/WMBusGateway';
import {WMBusMeter} from '../../src/devices/wmbus/WMBusMeter';

/** Set Active Configuration payload: link mode T (2), options 0x0E, defaults. */
const ENABLE_T_MODE = [
  0x02, 0x0e, 0x00, 0x00, 0x00, 0x32, 0x00, 0x88, 0x13, 0x00, 0x00,
];

class Host {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #dec = new SlipDecoder();
  readonly #pending: HciMessage[] = [];

  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.#reader = reader;
    this.#writer = writer;
  }

  async send(sap: number, msg: number, payload: number[] = []): Promise<void> {
    await this.#writer.write(
      Uint8Array.from(slipEncode(encodeHci(sap, msg, payload))),
    );
  }

  async recv(): Promise<HciMessage> {
    while (this.#pending.length === 0) {
      const {value, done} = await this.#reader.read();
      if (done) throw new Error('stream closed');
      if (value) {
        for (const frame of this.#dec.push(value)) {
          const m = decodeHci(frame);
          if (m) this.#pending.push(m);
        }
      }
    }
    return this.#pending.shift() as HciMessage;
  }

  async request(
    sap: number,
    msg: number,
    payload: number[] = [],
  ): Promise<HciMessage> {
    await this.send(sap, msg, payload);
    return this.recv();
  }

  async enableReceiver(): Promise<void> {
    await this.request(Sap.WMBus, WMBus.SetActiveConfigReq, ENABLE_T_MODE);
  }

  release(): void {
    this.#reader.releaseLock();
    this.#writer.releaseLock();
  }
}

const ADDRESS = {
  manufacturerId: 0x1234,
  deviceId: 0x56789abc,
  version: 0x01,
  type: 0x07,
};

async function mount() {
  const transport = new VirtualSerialTransport();
  const gateway = new WMBusGateway('iU891A-XL');
  transport.addDevice(gateway, {hasPermission: true});
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) throw new Error('expected one port');
  await port.open({baudRate: 115200});
  const host = new Host(port.readable!.getReader(), port.writable!.getWriter());
  return {gateway, port, host};
}

describe('WMBusMeter → WMBusGateway 0x20 events', () => {
  let port: SerialPort;
  let host: Host;
  let gateway: WMBusGateway;

  beforeEach(async () => {
    ({gateway, port, host} = await mount());
  });

  afterEach(async () => {
    host.release();
    await port.close();
  });

  it('does not forward telegrams until the receiver is switched on', async () => {
    const meter = new WMBusMeter({address: ADDRESS, payloadTemplate: [0x01]});
    gateway.addMeter(meter);

    // Receiver is Off (default link mode) — this telegram must be dropped.
    meter.sendTelegram();

    // The next frame the host reads is therefore the Ping response, not a 0x20.
    const rsp = await host.request(Sap.DevMgmt, DevMgmt.PingReq);
    expect(rsp.msg).toBe(DevMgmt.PingRsp);
  });

  it('forwards an encrypted telegram (decryption ok) once enabled', async () => {
    await host.enableReceiver();
    const meter = new WMBusMeter({
      address: ADDRESS,
      encryptionKey: new Array(16).fill(0xaa),
      linkMode: 2,
      rssi: -55,
      payloadTemplate: [0x2f, 0x2f, 0x01, 0x02, 0x03],
    });
    gateway.addMeter(meter);
    meter.sendTelegram();

    const evt = await host.recv();
    expect(evt.sap).toBe(Sap.WMBus);
    expect(evt.msg).toBe(WMBus.RxMessageInd);
    const r = new ByteReader(evt.payload);
    r.u32le(); // time
    expect(r.u8()).toBe(1); // decryption ok (key in device list)
    expect(r.u8()).toBe(5); // encryption mode 5
    expect(r.u8()).toBe(2); // packet info: T-Mode
    expect(r.u8()).toBe(0xc9); // rssi -55
    r.u8(); // L
    r.u8(); // C
    expect(readAddress(r)).toEqual(ADDRESS);
  });

  it('reports a Scan Mode notification (0x24) while scanning', async () => {
    // Scan mode (all link modes) switches the receiver on; meter telegrams are
    // reported as 0x24 Scan Notifications (10-byte header only), not 0x20.
    await host.request(Sap.WMBus, WMBus.SetScanModeReq, [0x0f, 0x05, 0x00]);
    const meter = new WMBusMeter({
      address: ADDRESS,
      linkMode: 2,
      rssi: -60,
      payloadTemplate: [0x01, 0x02, 0x03],
    });
    gateway.addMeter(meter);
    meter.sendTelegram();

    const evt = await host.recv();
    expect(evt.sap).toBe(Sap.WMBus);
    expect(evt.msg).toBe(WMBus.ScanModeInd);
    const r = new ByteReader(evt.payload);
    r.u32le(); // time
    expect(r.u8()).toBe(2); // packet info: T-Mode
    expect(r.u8()).toBe(0xc4); // rssi -60
    expect(r.rest().length).toBe(10); // L/C/address link-layer header only
  });

  it('reports decryption status "not encrypted" for a key-less meter', async () => {
    await host.enableReceiver();
    const meter = new WMBusMeter({address: ADDRESS, payloadTemplate: [0x01]});
    gateway.addMeter(meter);
    meter.sendTelegram();

    const r = new ByteReader((await host.recv()).payload);
    r.u32le();
    expect(r.u8()).toBe(0); // not encrypted
    expect(r.u8()).toBe(0); // encryption mode none
  });

  it('streams periodically only while enabled, and stops when reset', async () => {
    // Fake the interval timer, but keep queueMicrotask real so the transport's
    // microtask-based delivery still flushes on `await`.
    jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    try {
      await host.enableReceiver();
      const meter = new WMBusMeter({
        address: ADDRESS,
        intervalMs: 1000,
        payloadTemplate: [0xaa],
      });
      gateway.addMeter(meter); // starts streaming (enabled + open)

      jest.advanceTimersByTime(1000);
      expect((await host.recv()).msg).toBe(WMBus.RxMessageInd);

      meter.stopPeriodic();
    } finally {
      jest.useRealTimers();
    }
  });
});
