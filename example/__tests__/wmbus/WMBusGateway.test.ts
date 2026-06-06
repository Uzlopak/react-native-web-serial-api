/**
 * @format
 *
 * Drives the WM-Bus gateway simulator through the real Web Serial polyfill:
 * frames are written to port.writable and responses read from port.readable,
 * exactly as a host app would.
 */
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {createDeviceFixture} from 'react-native-web-serial-api/testing';
import {ByteReader} from '../../src/devices/wmbus/bytes';
import {HciHost} from '../../src/devices/wmbus/HciHost';
import {
  ApprovalTest,
  DevMgmt,
  GwStatus,
  type HciMessage,
  Sap,
  WMBus,
} from '../../src/devices/wmbus/hci';
import type {ModuleVariant} from '../../src/devices/wmbus/modules';
import {
  decodeDeviceItem,
  encodeDeviceItem,
  MAX_DEVICE_LIST_ITEMS,
} from '../../src/devices/wmbus/nvm';
import {slipEncode} from '../../src/devices/wmbus/slip';
import {WMBusGateway} from '../../src/devices/wmbus/WMBusGateway';

const ascii = (b: number[]): string => String.fromCharCode(...b);

/** Mount a gateway simulator and an {@link HciHost} talking to it (host = app). */
async function mount(variant: ModuleVariant = 'iU891A-XL') {
  const {port} = await createDeviceFixture(new WMBusGateway(variant));
  const host = await HciHost.open(port);
  return {host};
}

describe('WMBusGateway — Device Management', () => {
  let host: HciHost;

  beforeEach(async () => {
    ({host} = await mount());
  });

  afterEach(async () => {
    await host.close();
  });

  it('answers Ping with an ok status', async () => {
    const rsp = await host.request(Sap.DevMgmt, DevMgmt.PingReq);
    expect(rsp).toEqual({
      sap: Sap.DevMgmt,
      msg: DevMgmt.PingRsp,
      payload: [0x00],
    });
  });

  it('reports module identity in Get Device Information', async () => {
    // iM881A-XL is an integrated radio module — only its module type is spec-known.
    await host.close();
    ({host} = await mount('iM881A-XL'));
    const r = new ByteReader(
      (await host.request(Sap.DevMgmt, DevMgmt.GetDeviceInfoReq)).payload,
    );
    expect(r.u8()).toBe(0x00); // status ok
    expect(r.u8()).toBe(0xa3); // iM881A-XL module type (spec p21)
  });

  it('reports the real iU-stick identity (Cypress 04b4:0003)', async () => {
    // Values read off the hardware via Get Device Information (LSB-first).
    const sticks = [
      {
        variant: 'iU891A-XL',
        moduleType: 0x6e,
        moduleId: 0x00001b0d,
        productType: 0x00062dbe,
      },
      {
        variant: 'iU893A-XL',
        moduleType: 0x71,
        moduleId: 0x00001164,
        productType: 0x00062dc8,
      },
    ] as const;
    for (const stick of sticks) {
      await host.close();
      ({host} = await mount(stick.variant));
      const r = new ByteReader(
        (await host.request(Sap.DevMgmt, DevMgmt.GetDeviceInfoReq)).payload,
      );
      expect(r.u8()).toBe(0x00); // status ok
      expect(r.u8()).toBe(stick.moduleType);
      expect(r.u32le()).toBe(stick.moduleId);
      expect(r.u32le()).toBe(stick.productType); // little-endian on the wire
    }
  });

  it('reports firmware version, build and name', async () => {
    const {payload} = await host.request(Sap.DevMgmt, DevMgmt.GetFwInfoReq);
    const r = new ByteReader(payload);
    expect(r.u8()).toBe(0x00); // status
    expect(r.u8()).toBe(9); // minor
    expect(r.u8()).toBe(0); // major
    expect(r.u16le()).toBe(55); // build count
    expect(ascii(r.bytes(10))).toBe('09.04.2020');
    expect(ascii(r.rest())).toBe('VIRT_WMBus_Gateway');
  });

  it('stores and returns date/time (UTC seconds, LSB first)', async () => {
    const epoch = 0x5f649e19;
    const set = await host.request(Sap.DevMgmt, DevMgmt.SetDateTimeReq, [
      epoch & 0xff,
      (epoch >>> 8) & 0xff,
      (epoch >>> 16) & 0xff,
      (epoch >>> 24) & 0xff,
    ]);
    expect(set.payload).toEqual([0x00]);
    const {payload} = await host.request(Sap.DevMgmt, DevMgmt.GetDateTimeReq);
    const r = new ByteReader(payload);
    expect(r.u8()).toBe(0x00);
    expect(r.u32le()).toBe(epoch);
  });

  it('gets/sets the operation mode', async () => {
    let rsp = await host.request(Sap.DevMgmt, DevMgmt.GetOpModeReq);
    expect(rsp.payload).toEqual([0x00, 0x00]); // ok, Application mode
    rsp = await host.request(Sap.DevMgmt, DevMgmt.SetOpModeReq, [0x06]);
    expect(rsp.payload).toEqual([0x00]);
    rsp = await host.request(Sap.DevMgmt, DevMgmt.GetOpModeReq);
    expect(rsp.payload).toEqual([0x00, 0x06]);
  });

  it('masks system options on Set and reflects them on Get', async () => {
    let rsp = await host.request(Sap.DevMgmt, DevMgmt.GetSystemOptionsReq);
    expect(new ByteReader(rsp.payload.slice(1)).u32le()).toBe(0x0c); // RTC+WDog

    // Set bit 4 (startup event) via mask=0x10, value=0x10.
    rsp = await host.request(
      Sap.DevMgmt,
      DevMgmt.SetSystemOptionsReq,
      [0x10, 0, 0, 0, 0x10, 0, 0, 0],
    );
    expect(rsp.payload).toEqual([0x00]);
    rsp = await host.request(Sap.DevMgmt, DevMgmt.GetSystemOptionsReq);
    expect(new ByteReader(rsp.payload.slice(1)).u32le()).toBe(0x1c);
  });

  it('ignores a frame with a bad CRC but keeps serving', async () => {
    await host.raw(slipEncode([Sap.DevMgmt, DevMgmt.PingReq, 0xff, 0xff]));
    // A following valid Ping still gets answered.
    const rsp = await host.request(Sap.DevMgmt, DevMgmt.PingReq);
    expect(rsp.msg).toBe(DevMgmt.PingRsp);
  });
});

describe('WMBusGateway — WM-Bus Gateway SAP', () => {
  let host: HciHost;

  beforeEach(async () => {
    ({host} = await mount());
  });

  afterEach(async () => {
    await host.close();
  });

  it('returns the default active configuration', async () => {
    const {payload} = await host.request(Sap.WMBus, WMBus.GetActiveConfigReq);
    const r = new ByteReader(payload);
    expect(r.u8()).toBe(GwStatus.Ok);
    expect(r.u8()).toBe(0x00); // link mode = Off
    expect(r.u16le()).toBe(0x0e); // options: Rx+Tx notify + recal
  });

  it('round-trips an active configuration set', async () => {
    // linkMode=2, options=0x000a, ui=0, led=50, recal=5000
    const cfg = [
      0x02, 0x0a, 0x00, 0x00, 0x00, 0x32, 0x00, 0x88, 0x13, 0x00, 0x00,
    ];
    const set = await host.request(Sap.WMBus, WMBus.SetActiveConfigReq, cfg);
    expect(set.payload).toEqual([GwStatus.Ok]);
    const {payload} = await host.request(Sap.WMBus, WMBus.GetActiveConfigReq);
    expect(payload.slice(1)).toEqual(cfg);
  });

  it('clears, appends and reads back the device list', async () => {
    await host.request(Sap.WMBus, WMBus.ClearDeviceListReq);
    const item = encodeDeviceItem({
      address: {
        manufacturerId: 0x1234,
        deviceId: 0x56789abc,
        version: 1,
        type: 7,
      },
      key: new Array(16).fill(0xaa),
    });
    const append = await host.request(
      Sap.WMBus,
      WMBus.AppendDeviceListReq,
      item,
    );
    const ar = new ByteReader(append.payload);
    expect(ar.u8()).toBe(GwStatus.Ok);
    expect(ar.u16le()).toBe(1); // appended
    expect(ar.u16le()).toBe(MAX_DEVICE_LIST_ITEMS - 1); // free slots

    const read = await host.request(
      Sap.WMBus,
      WMBus.ReadDeviceListReq,
      [0, 10],
    );
    const rr = new ByteReader(read.payload);
    expect(rr.u8()).toBe(GwStatus.Ok);
    const got = decodeDeviceItem(rr);
    expect(got.address).toEqual({
      manufacturerId: 0x1234,
      deviceId: 0x56789abc,
      version: 1,
      type: 7,
    });
    expect(got.key).toEqual(new Array(16).fill(0xaa));
  });

  it('caps the device list and reports DataTruncated on overflow', async () => {
    await host.request(Sap.WMBus, WMBus.ClearDeviceListReq);
    const over = MAX_DEVICE_LIST_ITEMS + 3; // request more than the list holds
    const items = Array.from({length: over}, (_, i) =>
      encodeDeviceItem({
        address: {
          manufacturerId: 0x1234,
          deviceId: 0x1000 + i,
          version: 1,
          type: 7,
        },
        key: new Array(16).fill(i & 0xff),
      }),
    );
    const append = await host.request(
      Sap.WMBus,
      WMBus.AppendDeviceListReq,
      items.flat(),
    );
    const ar = new ByteReader(append.payload);
    expect(ar.u8()).toBe(GwStatus.DataTruncated); // overflowed
    expect(ar.u16le()).toBe(MAX_DEVICE_LIST_ITEMS); // only capacity stored
    expect(ar.u16le()).toBe(0); // no free slots left

    const read = await host.request(Sap.WMBus, WMBus.ReadDeviceListReq, [
      0,
      over,
    ]);
    const rr = new ByteReader(read.payload);
    expect(rr.u8()).toBe(GwStatus.Ok);
    let count = 0;
    while (rr.remaining >= 24) {
      decodeDeviceItem(rr);
      count++;
    }
    expect(count).toBe(MAX_DEVICE_LIST_ITEMS);
  });

  it('saves to NVM, clears RAM, then reloads from NVM', async () => {
    await host.request(Sap.WMBus, WMBus.ClearDeviceListReq);
    const item = encodeDeviceItem({
      address: {manufacturerId: 1, deviceId: 2, version: 3, type: 4},
      key: new Array(16).fill(0),
    });
    await host.request(Sap.WMBus, WMBus.AppendDeviceListReq, item);
    await host.request(Sap.WMBus, WMBus.SaveDeviceListReq);
    await host.request(Sap.WMBus, WMBus.ClearDeviceListReq);
    const load = await host.request(Sap.WMBus, WMBus.LoadDeviceListReq);
    const r = new ByteReader(load.payload);
    expect(r.u8()).toBe(GwStatus.Ok);
    expect(r.u16le()).toBe(1); // one item restored
  });

  it('reports a status report matching the IMST host layout', async () => {
    const {payload} = await host.request(Sap.WMBus, WMBus.GetStatusReportReq);
    // status(1) dateTime(4) lastSync(4) linkMode(1) statusBits(2) reset(4)
    //   rxPkt(4) rxReject(4) rxError(4) txPkt(4) txError(4) reserved(4) = 40.
    expect(payload.length).toBe(40);
    const r = new ByteReader(payload);
    expect(r.u8()).toBe(GwStatus.Ok);
    r.u32le(); // time
    r.u32le(); // last sync
    r.u8(); // link mode
    const statusBits = r.u16le(); // 2-byte field
    expect(statusBits & (1 << 1)).toBeTruthy(); // default config valid
    expect(statusBits & (1 << 2)).toBeTruthy(); // device list valid
    expect(r.u32le()).toBe(0); // reset counter (4-byte, no restart yet)
    r.u32le(); // rxPkt
    r.u32le(); // rxReject
    r.u32le(); // rxError
    r.u32le(); // txPkt
    r.u32le(); // txError
    expect(r.remaining).toBe(4); // reserved info
  });

  it('accepts Send WM-Bus Message and emits a Tx notification', async () => {
    const content = [0x44, 0x34, 0x12, 0xbc, 0x9a, 0x78, 0x56, 0x01, 0x07];
    const rsp = await host.request(Sap.WMBus, WMBus.SendMessageReq, [
      0x02, // packet mode T-A
      0x00, // power
      ...content,
    ]);
    expect(rsp).toEqual({
      sap: Sap.WMBus,
      msg: WMBus.SendMessageRsp,
      payload: [GwStatus.Ok],
    });
    const evt = await host.recv(); // Tx notify (options bit 2 set by default)
    expect(evt.msg).toBe(WMBus.MessageTransmittedInd);
    expect(evt.payload[evt.payload.length - 1]).toBe(0x00); // status = success
  });

  it('rejects Radio Control on an iU891A-XL (USB stick)', async () => {
    await host.close();
    ({host} = await mount('iU891A-XL'));
    const rsp = await host.request(Sap.WMBus, WMBus.GetRadioConfigReq);
    expect(rsp.payload).toEqual([GwStatus.Unsupported]);
  });

  it('accepts Encrypt Send Packet on iU891A-XL when key exists for stored address', async () => {
    await host.close();
    ({host} = await mount('iU891A-XL'));

    await host.request(Sap.WMBus, WMBus.ClearDeviceListReq);
    const storedAddressItem = encodeDeviceItem({
      address: {manufacturerId: 0, deviceId: 0, version: 0, type: 0},
      key: new Array(16).fill(0xaa),
    });
    await host.request(Sap.WMBus, WMBus.AppendDeviceListReq, storedAddressItem);

    const rsp = await host.request(Sap.WMBus, WMBus.EncryptSendPacketReq, [
      0x05, // mode 5
      0x02, // T-mode packet
      0x00, // tx power
      0x44, // C-field
      0x2f, // CI-field
      0x01,
      0x02,
      0x03, // payload bytes
    ]);
    expect(rsp).toEqual({
      sap: Sap.WMBus,
      msg: WMBus.EncryptSendPacketRsp,
      payload: [GwStatus.Ok],
    });
  });

  it('returns the default configuration (0x05)', async () => {
    const {payload} = await host.request(Sap.WMBus, WMBus.GetDefaultConfigReq);
    expect(payload[0]).toBe(GwStatus.Ok);
    expect(payload.length).toBe(12); // status + 11-byte config
  });

  it('clears the packet counters on Reset Status Report (0x43)', async () => {
    const txCount = (p: number[]): number => {
      const r = new ByteReader(p);
      r.u8(); // status
      r.u32le(); // dateTime
      r.u32le(); // lastSync
      r.u8(); // linkMode
      r.u16le(); // statusBits
      r.u32le(); // reset
      r.u32le(); // rxPkt
      r.u32le(); // rxReject
      r.u32le(); // rxError
      return r.u32le(); // txPkt
    };
    // A send bumps the Tx counter.
    await host.request(
      Sap.WMBus,
      WMBus.SendMessageReq,
      [0x02, 0x00, 0x44, 0, 0, 0, 0, 0, 0],
    );
    await host.recv(); // Tx notification
    expect(
      txCount(
        (await host.request(Sap.WMBus, WMBus.GetStatusReportReq)).payload,
      ),
    ).toBe(1);

    const reset = await host.request(Sap.WMBus, WMBus.ResetStatusReportReq);
    expect(reset.payload).toEqual([GwStatus.Ok]);
    expect(
      txCount(
        (await host.request(Sap.WMBus, WMBus.GetStatusReportReq)).payload,
      ),
    ).toBe(0);
  });

  it('encrypts and sends with a key, else reports NoKey (0x35/0x38)', async () => {
    await host.request(Sap.WMBus, WMBus.ClearDeviceListReq);
    // content: C, ManID(0), DevID(0), Ver(0), Type(0), CI, data -> address all-zero
    const content = [0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x7a, 0x01];

    let rsp = await host.request(Sap.WMBus, WMBus.EncryptSendReq, [
      0x05,
      0x02,
      0x00,
      ...content,
    ]);
    expect(rsp.payload).toEqual([GwStatus.NoKey]); // no key for the address yet

    await host.request(
      Sap.WMBus,
      WMBus.AppendDeviceListReq,
      encodeDeviceItem({
        address: {manufacturerId: 0, deviceId: 0, version: 0, type: 0},
        key: new Array(16).fill(0xaa),
      }),
    );
    rsp = await host.request(Sap.WMBus, WMBus.EncryptSendReq, [
      0x05,
      0x02,
      0x00,
      ...content,
    ]);
    expect(rsp).toEqual({
      sap: Sap.WMBus,
      msg: WMBus.EncryptSendRsp,
      payload: [GwStatus.Ok],
    });
    const evt = await host.recv();
    expect(evt.msg).toBe(WMBus.EncryptedMessageTransmittedInd);
    expect(evt.payload[evt.payload.length - 1]).toBe(0x00); // tx success
  });

  it('sends a packet (II) on iU sticks and notifies (0x39/0x34)', async () => {
    const rsp = await host.request(
      Sap.WMBus,
      WMBus.SendPacketReq,
      [0x02, 0x00, 0x44, 0x7a, 0x01],
    );
    expect(rsp).toEqual({
      sap: Sap.WMBus,
      msg: WMBus.SendPacketRsp,
      payload: [GwStatus.Ok],
    });
    expect((await host.recv()).msg).toBe(WMBus.MessageTransmittedInd);
  });

  it('returns the stored WM-Bus address on iU sticks (0x81)', async () => {
    const {payload} = await host.request(Sap.WMBus, WMBus.GetWMBusAddressReq);
    expect(payload[0]).toBe(GwStatus.Ok);
    expect(payload.length).toBe(9); // status + 8-byte address
  });

  it('rejects Set Radio Control on iU sticks (0x53)', async () => {
    const rsp = await host.request(
      Sap.WMBus,
      WMBus.SetRadioConfigReq,
      [0, 0, 0, 0, 0, 0],
    );
    expect(rsp.payload).toEqual([GwStatus.Unsupported]);
  });

  it('rejects Send-Packet-II and WM-Bus address on iM modules', async () => {
    await host.close();
    ({host} = await mount('iM881A-XL'));
    const sp = await host.request(
      Sap.WMBus,
      WMBus.SendPacketReq,
      [0x02, 0x00, 0x44],
    );
    expect(sp).toEqual({
      sap: Sap.WMBus,
      msg: WMBus.SendPacketRsp,
      payload: [GwStatus.Unsupported],
    });
    const addr = await host.request(Sap.WMBus, WMBus.GetWMBusAddressReq);
    expect(addr).toEqual({
      sap: Sap.WMBus,
      msg: WMBus.GetWMBusAddressRsp,
      payload: [GwStatus.Unsupported],
    });
  });

  it('round-trips the radio control configuration on iM modules (0x51/0x53)', async () => {
    await host.close();
    ({host} = await mount('iM881A-XL'));
    const cfg = [0x03, 0x00, 0x00, 0x00, 0xc8, 0x00]; // options=3, txDelay=200
    const set = await host.request(Sap.WMBus, WMBus.SetRadioConfigReq, cfg);
    expect(set.payload).toEqual([GwStatus.Ok]);
    const get = await host.request(Sap.WMBus, WMBus.GetRadioConfigReq);
    expect(get.payload[0]).toBe(GwStatus.Ok);
    expect(get.payload.slice(1)).toEqual(cfg);
  });
});

describe('WMBusGateway — restart & startup indication', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits a Startup Indication ~200ms after restart when enabled', async () => {
    const {host} = await mount('iM881A-XL');
    // Enable system-option bit 4 (startup event).
    await host.request(
      Sap.DevMgmt,
      DevMgmt.SetSystemOptionsReq,
      [0x10, 0, 0, 0, 0x10, 0, 0, 0],
    );
    const restart = await host.request(Sap.DevMgmt, DevMgmt.RestartReq);
    expect(restart.msg).toBe(DevMgmt.RestartRsp);

    const evt = await host.recv(); // arrives after the ~200ms restart delay
    expect(evt.sap).toBe(Sap.DevMgmt);
    expect(evt.msg).toBe(DevMgmt.StartupInd);
    const r = new ByteReader(evt.payload);
    expect(r.u32le()).toBe(0); // reserved
    expect(r.u8()).toBe(0xa3); // module type

    await host.close();
  }, 10000);

  it('clears scan mode after a restart', async () => {
    const {host} = await mount();
    // Enable the startup event so we can await restart completion deterministically.
    await host.request(
      Sap.DevMgmt,
      DevMgmt.SetSystemOptionsReq,
      [0x10, 0, 0, 0, 0x10, 0, 0, 0],
    );

    const scanBitSet = async (): Promise<boolean> => {
      const r = new ByteReader(
        (await host.request(Sap.WMBus, WMBus.GetStatusReportReq)).payload,
      );
      r.u8(); // status
      r.u32le(); // time
      r.u32le(); // last sync
      r.u8(); // link mode
      return Boolean(r.u16le() & (1 << 5)); // SB_ScanMode_Active
    };

    // Enable scan mode (S-Mode, 30s) and confirm the status bit is set.
    await host.request(Sap.WMBus, WMBus.SetScanModeReq, [0x01, 0x1e, 0x00]);
    expect(await scanBitSet()).toBe(true);

    // Restart, then wait for the post-restart Startup Indication.
    await host.request(Sap.DevMgmt, DevMgmt.RestartReq);
    let evt = await host.recv();
    while (!(evt.sap === Sap.DevMgmt && evt.msg === DevMgmt.StartupInd)) {
      evt = await host.recv();
    }

    expect(await scanBitSet()).toBe(false); // scan mode cleared by the reboot

    await host.close();
  }, 10000);
});

const waitForStartup = async (host: HciHost): Promise<void> => {
  let evt = await host.recv();
  while (!(evt.sap === Sap.DevMgmt && evt.msg === DevMgmt.StartupInd)) {
    evt = await host.recv();
  }
};

const enableStartupEvent = (host: HciHost): Promise<HciMessage> =>
  host.request(
    Sap.DevMgmt,
    DevMgmt.SetSystemOptionsReq,
    [0x10, 0, 0, 0, 0x10, 0, 0, 0],
  );

describe('WMBusGateway — default configuration (0x07/0x09)', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('persists a Set Default Config across restart and resets to factory', async () => {
    const {host} = await mount('iU891A-XL');
    await enableStartupEvent(host);

    // Set a new default (link mode T); the device restarts and loads it.
    const newDefault = [
      0x02, 0x0e, 0x00, 0x00, 0x00, 0x32, 0x00, 0x88, 0x13, 0x00, 0x00,
    ];
    const set = await host.request(
      Sap.WMBus,
      WMBus.SetDefaultConfigReq,
      newDefault,
    );
    expect(set.payload).toEqual([GwStatus.Ok]);
    await waitForStartup(host);
    let active = (
      await host.request(Sap.WMBus, WMBus.GetActiveConfigReq)
    ).payload.slice(1);
    expect(active[0]).toBe(0x02); // active config reflects the new default link mode

    // Reset to factory; after the restart the link mode is Off again.
    const reset = await host.request(Sap.WMBus, WMBus.ResetDefaultConfigReq);
    expect(reset.payload).toEqual([GwStatus.Ok]);
    await waitForStartup(host);
    active = (
      await host.request(Sap.WMBus, WMBus.GetActiveConfigReq)
    ).payload.slice(1);
    expect(active[0]).toBe(0x00); // factory link mode Off
    expect(new ByteReader(active.slice(1)).u16le()).toBe(0x0e); // factory options

    await host.close();
  }, 15000);
});

describe('WMBusGateway — Approval Test SAP (0x20)', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers Reset Test / CW / PN9 on an iM module in Approval Test mode', async () => {
    const {host} = await mount('iM881A-XL');
    await enableStartupEvent(host);
    await host.request(Sap.DevMgmt, DevMgmt.SetOpModeReq, [0x06]); // Approval Test -> restart
    await waitForStartup(host);

    const cw = await host.request(
      Sap.ApprovalTest,
      ApprovalTest.EnableCwReq,
      [0x00, 0x02, 0x00],
    );
    expect(cw).toEqual({
      sap: Sap.ApprovalTest,
      msg: ApprovalTest.EnableCwRsp,
      payload: [0x00],
    });

    const pn9 = await host.request(
      Sap.ApprovalTest,
      ApprovalTest.EnablePn9Req,
      [0x00, 0x02, 0x00],
    );
    expect(pn9).toEqual({
      sap: Sap.ApprovalTest,
      msg: ApprovalTest.EnablePn9Rsp,
      payload: [0x00],
    });

    const badIndex = await host.request(
      Sap.ApprovalTest,
      ApprovalTest.EnableCwReq,
      [0x09, 0x02, 0x00],
    );
    expect(badIndex.payload).toEqual([0x0e]); // wrong radio index

    const reset = await host.request(
      Sap.ApprovalTest,
      ApprovalTest.ResetTestReq,
    );
    expect(reset).toEqual({
      sap: Sap.ApprovalTest,
      msg: ApprovalTest.ResetTestRsp,
      payload: [0x00],
    });

    await host.close();
  }, 15000);

  it('does not respond outside Approval mode, nor on iU sticks', async () => {
    for (const variant of ['iM881A-XL', 'iU891A-XL'] as const) {
      const {host} = await mount(variant);
      await host.send(Sap.ApprovalTest, ApprovalTest.ResetTestReq); // dropped (no handler)
      // The first frame the host reads is therefore the Ping response.
      const ping = await host.request(Sap.DevMgmt, DevMgmt.PingReq);
      expect(ping.msg).toBe(DevMgmt.PingRsp);
      await host.close();
    }
  }, 10000);
});
