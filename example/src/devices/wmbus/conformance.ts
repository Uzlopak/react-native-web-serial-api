/**
 * WM-Bus gateway HCI conformance suite.
 *
 * A runtime-agnostic set of request/response checks that drive any IMST-style
 * WM-Bus gateway over a {@link SerialPort}. The *same* cases run against:
 *   - the built-in {@link WMBusGateway} simulator (the reference), and
 *   - a real connected gateway,
 * so you can confirm a real device behaves identically to the simulator. The
 * checks are behavioural (status codes, field shapes, round-trips) rather than
 * identity-specific, and non-destructive: RAM-only state is restored and no NVM
 * write / restart commands are issued.
 */

import type {SerialPort} from 'react-native-web-serial-api';
import {Serial} from 'react-native-web-serial-api';
import {
  assert,
  assertEqual,
  compareResults,
  runSerialTests,
  type SerialTest,
  type SerialTestProgress,
  type SerialTestResult,
  VirtualSerialTransport,
} from 'react-native-web-serial-api/testing';
import {ByteReader} from './bytes';
import {HciHost} from './HciHost';
import {DevMgmt, DevStatus, GwStatus, Sap, WMBus} from './hci';
import {WMBusGateway} from './WMBusGateway';
import {WMBusMeter} from './WMBusMeter';

export type WMBusTestResult = SerialTestResult;

function isPrintableAscii(bytes: number[]): boolean {
  return bytes.every(b => b >= 0x20 && b <= 0x7e);
}

// ── the suite ────────────────────────────────────────────────────────────────

/** A conformance case driving the gateway through an {@link HciHost}. */
export type WMBusConformanceTest = SerialTest<HciHost>;

function readDeviceListRaw(payload: number[]): number[] {
  // ReadDeviceListRsp = status(1) + N×item(24); return the raw item bytes.
  return payload.slice(1);
}

export const wmbusConformanceTests: WMBusConformanceTest[] = [
  {
    name: 'Ping answers with status ok',
    async run(c) {
      const rsp = await c.exchange(
        Sap.DevMgmt,
        DevMgmt.PingReq,
        [],
        DevMgmt.PingRsp,
      );
      assertEqual(rsp.payload[0], DevStatus.Ok, 'ping status');
    },
  },
  {
    name: 'Get Device Information returns a module type + id',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.DevMgmt,
        DevMgmt.GetDeviceInfoReq,
        [],
        DevMgmt.GetDeviceInfoRsp,
      );
      assertEqual(payload[0], DevStatus.Ok, 'status');
      assert(
        payload.length >= 6,
        'expected status + module type + 4-byte module id',
      );
      assert(payload[1] !== 0, 'module type should be non-zero');
    },
  },
  {
    name: 'Get Firmware Information returns version, build date and name',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.DevMgmt,
        DevMgmt.GetFwInfoReq,
        [],
        DevMgmt.GetFwInfoRsp,
      );
      const r = new ByteReader(payload);
      assertEqual(r.u8(), DevStatus.Ok, 'status');
      r.u8(); // minor
      r.u8(); // major
      r.u16le(); // build count
      assert(r.remaining >= 10, 'expected a 10-byte build date');
      assert(
        isPrintableAscii(r.bytes(10)),
        'build date should be printable ASCII',
      );
      const name = r.rest();
      assert(
        name.length > 0 && isPrintableAscii(name),
        'firmware name should be printable ASCII',
      );
    },
  },
  {
    name: 'Date & Time round-trips (set then get)',
    async run(c) {
      const original = new ByteReader(
        (
          await c.exchange(
            Sap.DevMgmt,
            DevMgmt.GetDateTimeReq,
            [],
            DevMgmt.GetDateTimeRsp,
          )
        ).payload,
      );
      original.u8();
      const prev = original.u32le();

      const probe = 0x5f649e19;
      const set = await c.exchange(
        Sap.DevMgmt,
        DevMgmt.SetDateTimeReq,
        [
          probe & 0xff,
          (probe >>> 8) & 0xff,
          (probe >>> 16) & 0xff,
          (probe >>> 24) & 0xff,
        ],
        DevMgmt.SetDateTimeRsp,
      );
      assertEqual(set.payload[0], DevStatus.Ok, 'set status');

      const got = new ByteReader(
        (
          await c.exchange(
            Sap.DevMgmt,
            DevMgmt.GetDateTimeReq,
            [],
            DevMgmt.GetDateTimeRsp,
          )
        ).payload,
      );
      got.u8();
      assertEqual(
        got.u32le(),
        probe,
        'date/time should read back what was set',
      );

      // restore
      await c.exchange(
        Sap.DevMgmt,
        DevMgmt.SetDateTimeReq,
        [
          prev & 0xff,
          (prev >>> 8) & 0xff,
          (prev >>> 16) & 0xff,
          (prev >>> 24) & 0xff,
        ],
        DevMgmt.SetDateTimeRsp,
      );
    },
  },
  {
    name: 'Get System Options returns a 32-bit field',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.DevMgmt,
        DevMgmt.GetSystemOptionsReq,
        [],
        DevMgmt.GetSystemOptionsRsp,
      );
      assertEqual(payload[0], DevStatus.Ok, 'status');
      assertEqual(payload.length, 5, 'expected status + 4 option bytes');
    },
  },
  {
    name: 'Active configuration round-trips (link mode change, then restored)',
    async run(c) {
      const get = async () =>
        (
          await c.exchange(
            Sap.WMBus,
            WMBus.GetActiveConfigReq,
            [],
            WMBus.GetActiveConfigRsp,
          )
        ).payload;
      const original = await get();
      assertEqual(original[0], GwStatus.Ok, 'status');
      assertEqual(original.length, 12, 'expected status + 11-byte config');
      const config = original.slice(1);

      const modified = [...config];
      modified[0] = modified[0] === 0x02 ? 0x01 : 0x02; // flip link mode
      const set = await c.exchange(
        Sap.WMBus,
        WMBus.SetActiveConfigReq,
        modified,
        WMBus.SetActiveConfigRsp,
      );
      assertEqual(set.payload[0], GwStatus.Ok, 'set status');

      const after = (await get()).slice(1);
      assertEqual(after[0], modified[0], 'link mode should reflect the change');

      // restore the original active configuration
      await c.exchange(
        Sap.WMBus,
        WMBus.SetActiveConfigReq,
        config,
        WMBus.SetActiveConfigRsp,
      );
    },
  },
  {
    name: 'Get Default Configuration returns an 11-byte config',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.WMBus,
        WMBus.GetDefaultConfigReq,
        [],
        WMBus.GetDefaultConfigRsp,
      );
      assertEqual(payload[0], GwStatus.Ok, 'status');
      assertEqual(payload.length, 12, 'expected status + 11-byte config');
    },
  },
  {
    name: 'Device list clear/append/read round-trips (RAM restored)',
    async run(c) {
      // snapshot the current RAM list
      const before = readDeviceListRaw(
        (
          await c.exchange(
            Sap.WMBus,
            WMBus.ReadDeviceListReq,
            [0, 10],
            WMBus.ReadDeviceListRsp,
          )
        ).payload,
      );

      await c.exchange(
        Sap.WMBus,
        WMBus.ClearDeviceListReq,
        [],
        WMBus.ClearDeviceListRsp,
      );

      const item = [
        0x34,
        0x12, // manufacturer id (LSB)
        0xbc,
        0x9a,
        0x78,
        0x56, // device id (LSB)
        0x01,
        0x07, // version, type
        ...new Array(16).fill(0xaa), // key
      ];
      const append = await c.exchange(
        Sap.WMBus,
        WMBus.AppendDeviceListReq,
        item,
        WMBus.AppendDeviceListRsp,
      );
      const ar = new ByteReader(append.payload);
      assertEqual(ar.u8(), GwStatus.Ok, 'append status');
      assertEqual(ar.u16le(), 1, 'one item appended');

      const read = readDeviceListRaw(
        (
          await c.exchange(
            Sap.WMBus,
            WMBus.ReadDeviceListReq,
            [0, 10],
            WMBus.ReadDeviceListRsp,
          )
        ).payload,
      );
      assert(read.length >= 24, 'expected one 24-byte item back');
      assertEqual(
        JSON.stringify(read.slice(0, 24)),
        JSON.stringify(item),
        'read item should match the appended item',
      );

      // restore the original RAM list
      await c.exchange(
        Sap.WMBus,
        WMBus.ClearDeviceListReq,
        [],
        WMBus.ClearDeviceListRsp,
      );
      if (before.length >= 24) {
        await c.exchange(
          Sap.WMBus,
          WMBus.AppendDeviceListReq,
          before,
          WMBus.AppendDeviceListRsp,
        );
      }
    },
  },
  {
    name: 'Device list reports DataTruncated when it overflows',
    async run(c) {
      // Page-read the whole list so the snapshot/restore is complete.
      const readAll = async (): Promise<number[]> => {
        const out: number[] = [];
        for (let index = 0; index < 0x100; index += 8) {
          const page = readDeviceListRaw(
            (
              await c.exchange(
                Sap.WMBus,
                WMBus.ReadDeviceListReq,
                [index, 8],
                WMBus.ReadDeviceListRsp,
              )
            ).payload,
          );
          if (page.length === 0) break;
          out.push(...page);
          if (page.length < 8 * 24) break;
        }
        return out;
      };

      let nextId = 0;
      const makeItem = (): number[] => {
        const id = nextId++;
        return [
          0x34,
          0x12, // manufacturer id
          id & 0xff,
          (id >> 8) & 0xff,
          0x00,
          0x00, // device id (unique)
          0x01,
          0x07, // version, type
          ...new Array(16).fill(id & 0xff), // key
        ];
      };

      const before = await readAll();
      await c.exchange(
        Sap.WMBus,
        WMBus.ClearDeviceListReq,
        [],
        WMBus.ClearDeviceListRsp,
      );
      try {
        // Append a few at a time until the device reports it is full. This is
        // capacity-agnostic (works for any finite list size) and bounded so a
        // very large list can't loop forever.
        const BATCH = 4;
        const MAX_BATCHES = 64; // up to 256 items
        let acceptedTotal = 0;
        let sawTruncation = false;
        for (let b = 0; b < MAX_BATCHES; b++) {
          const items: number[] = [];
          for (let i = 0; i < BATCH; i++) items.push(...makeItem());
          const rsp = await c.exchange(
            Sap.WMBus,
            WMBus.AppendDeviceListReq,
            items,
            WMBus.AppendDeviceListRsp,
          );
          const r = new ByteReader(rsp.payload);
          const status = r.u8();
          const appended = r.u16le();
          const free = r.u16le();
          assert(appended <= BATCH, 'cannot append more items than were sent');
          acceptedTotal += appended;
          if (status === GwStatus.DataTruncated) {
            assertEqual(free, 0, 'a full device list reports zero free slots');
            sawTruncation = true;
            break;
          }
          assertEqual(status, GwStatus.Ok, 'append status');
          assertEqual(
            appended,
            BATCH,
            'a non-truncated append stores every item',
          );
        }
        assert(
          sawTruncation,
          'expected the device list to overflow within 256 items',
        );

        // Everything accepted before the overflow must read back intact.
        const stored = await readAll();
        assertEqual(
          stored.length,
          acceptedTotal * 24,
          'stored item count matches the accepted appends',
        );
      } finally {
        // restore the original RAM list
        await c.exchange(
          Sap.WMBus,
          WMBus.ClearDeviceListReq,
          [],
          WMBus.ClearDeviceListRsp,
        );
        if (before.length >= 24) {
          await c.exchange(
            Sap.WMBus,
            WMBus.AppendDeviceListReq,
            before,
            WMBus.AppendDeviceListRsp,
          );
        }
      }
    },
  },
  {
    name: 'Gateway Status Report matches the IMST host layout',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.WMBus,
        WMBus.GetStatusReportReq,
        [],
        WMBus.GetStatusReportRsp,
      );
      assertEqual(payload[0], GwStatus.Ok, 'status');
      // Decode at the exact C++ OnGetStatusReportResponse offsets: after the
      // status byte come dateTime(4) lastSync(4) linkMode(1) statusBits(2)
      // reset(4) then five u32 counters, plus an optional 4-byte reserved tail.
      const r = new ByteReader(payload);
      r.u8(); // status
      r.u32le(); // date time
      r.u32le(); // last sync
      const linkMode = r.u8();
      assert(linkMode <= 0x06, `link mode out of range (${linkMode})`);
      r.u16le(); // status bits (2-byte field — C++ GetU16)
      r.u32le(); // reset counter (4-byte field — C++ GetU32)
      r.u32le(); // rx packet
      r.u32le(); // rx reject
      r.u32le(); // rx error
      r.u32le(); // tx packet
      r.u32le(); // tx error
      // 1+4+4+1+2+4+5*4 = 36 bytes consumed; only the optional reserved remains,
      // so a device using the wrong field widths fails here.
      assert(
        r.remaining === 0 || r.remaining === 4,
        `unexpected status-report length/layout (trailing ${r.remaining} bytes)`,
      );
    },
  },
  {
    name: 'Receives WM-Bus telegram notification (0x20) when receiver is enabled',
    async run(c) {
      const getConfig = async () =>
        (
          await c.exchange(
            Sap.WMBus,
            WMBus.GetActiveConfigReq,
            [],
            WMBus.GetActiveConfigRsp,
          )
        ).payload;

      const original = await getConfig();
      assertEqual(original[0], GwStatus.Ok, 'get active config status');
      assertEqual(original.length, 12, 'active config layout');
      const config = original.slice(1);

      const modified = [...config];
      modified[0] = 0x02; // T-Mode
      await c.exchange(
        Sap.WMBus,
        WMBus.SetActiveConfigReq,
        modified,
        WMBus.SetActiveConfigRsp,
      );

      try {
        // Real gateways may need a few seconds until a telegram arrives.
        const evt = await c.waitFor(
          Sap.WMBus,
          WMBus.RxMessageInd,
          15000,
          m => m.payload.length >= 9,
        );
        const r = new ByteReader(evt.payload);
        r.u32le(); // timestamp UTC
        r.u8(); // decryption status
        r.u8(); // encryption mode
        const packetInfo = r.u8();
        const rssiRaw = r.u8();
        // Offset 6 is the Packet Info (PI_*) code (C++ OnWMBusRxPacketEvent),
        // not the raw link mode — assert it's a real PI_* value.
        const VALID_PACKET_INFO = [0x01, 0x02, 0x04, 0x05, 0x06, 0x14, 0x15];
        assert(
          VALID_PACKET_INFO.includes(packetInfo),
          `packet info should be a valid PI_* code (got 0x${packetInfo.toString(16)})`,
        );

        const signedRssi = rssiRaw > 127 ? rssiRaw - 256 : rssiRaw;
        assert(
          signedRssi >= -140 && signedRssi <= 40,
          `RSSI should be in a realistic range (got ${signedRssi} dBm)`,
        );

        const packet = r.rest();
        assert(
          packet.length >= 10,
          'WM-Bus packet should include at least L/C/address header',
        );
        assertEqual(
          packet.length,
          (packet[0] ?? 0) + 1,
          'L-field should match packet length',
        );
      } finally {
        await c.exchange(
          Sap.WMBus,
          WMBus.SetActiveConfigReq,
          config,
          WMBus.SetActiveConfigRsp,
        );
      }
    },
  },
  {
    name: 'Get Operation Mode returns Application or Approval mode',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.DevMgmt,
        DevMgmt.GetOpModeReq,
        [],
        DevMgmt.GetOpModeRsp,
      );
      assertEqual(payload[0], DevStatus.Ok, 'status');
      assert(
        payload[1] === 0x00 || payload[1] === 0x06,
        `unexpected operation mode 0x${(payload[1] ?? 0).toString(16)}`,
      );
    },
  },
  {
    name: 'Get WM-Bus Address returns the stored 8-byte sender address',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.WMBus,
        WMBus.GetWMBusAddressReq,
        [],
        WMBus.GetWMBusAddressRsp,
      );
      assertEqual(payload[0], GwStatus.Ok, 'status');
      assertEqual(payload.length, 9, 'expected status + 8-byte WM-Bus address');
    },
  },
  {
    name: 'Reset Gateway Status Report succeeds',
    async run(c) {
      const {payload} = await c.exchange(
        Sap.WMBus,
        WMBus.ResetStatusReportReq,
        [],
        WMBus.ResetStatusReportRsp,
      );
      assertEqual(payload[0], GwStatus.Ok, 'reset status');
    },
  },
  {
    name: 'Radio Control Config is not supported on iU sticks (module-gated)',
    async run(c) {
      try {
        const {payload} = await c.exchange(
          Sap.WMBus,
          WMBus.GetRadioConfigReq,
          [],
          WMBus.GetRadioConfigRsp,
          1500,
        );
        assertEqual(
          payload[0],
          GwStatus.Unsupported,
          'iU sticks should report radio control as unsupported',
        );
      } catch (e) {
        // No response at all is also a valid "not supported" outcome.
        if (e instanceof Error && e.message.startsWith('timed out')) return;
        throw e;
      }
    },
  },
  {
    name: 'Receives a Scan Mode notification (0x24) across all link modes',
    async run(c) {
      // Scan S+T+CT+C (bitmask 0x0F), 5s per mode.
      const set = await c.exchange(
        Sap.WMBus,
        WMBus.SetScanModeReq,
        [0x0f, 0x05, 0x00],
        WMBus.SetScanModeRsp,
      );
      assertEqual(set.payload[0], GwStatus.Ok, 'set scan mode status');
      try {
        const evt = await c.waitFor(
          Sap.WMBus,
          WMBus.ScanModeInd,
          20000,
          m => m.payload.length >= 6,
        );
        const r = new ByteReader(evt.payload);
        r.u32le(); // timestamp
        const packetInfo = r.u8();
        const VALID_PACKET_INFO = [0x01, 0x02, 0x04, 0x05, 0x06, 0x14, 0x15];
        assert(
          VALID_PACKET_INFO.includes(packetInfo),
          `scan packet info should be a PI_* code (got 0x${packetInfo.toString(16)})`,
        );
        r.u8(); // rssi
        assert(
          r.remaining >= 10,
          'scan notification should carry a 10-byte link-layer header',
        );
      } finally {
        await c.exchange(
          Sap.WMBus,
          WMBus.SetScanModeReq,
          [0x00, 0x00, 0x00],
          WMBus.SetScanModeRsp,
        );
      }
    },
  },
  {
    name: 'Transmits a WM-Bus test telegram (Send Message, all-zero address)',
    async run(c) {
      // Obvious test frame: Manufacturer ID = 0 and Device ID = 0.
      const content = [
        0x44, // C-field (SND-NR)
        0x00,
        0x00, // manufacturer id = 0
        0x00,
        0x00,
        0x00,
        0x00, // device id = 0
        0x00,
        0x00, // version, type
        0x7a, // CI-field
        0x01,
        0x02,
        0x03, // a little application data
      ];
      const rsp = await c.exchange(
        Sap.WMBus,
        WMBus.SendMessageReq,
        [0x02 /* T-Mode, Format A */, 0x00 /* power 0 dBm */, ...content],
        WMBus.SendMessageRsp,
      );
      assertEqual(rsp.payload[0], GwStatus.Ok, 'send message status');
      try {
        // A Tx notification follows when WM-Bus Tx Notification is enabled.
        const tx = await c.waitFor(
          Sap.WMBus,
          WMBus.MessageTransmittedInd,
          5000,
        );
        assertEqual(
          tx.payload[tx.payload.length - 1],
          0x00,
          'transmission status should be success',
        );
      } catch (e) {
        // Tx-notify may be disabled on the device — the ok response is enough.
        if (e instanceof Error && e.message.startsWith('timed out')) return;
        throw e;
      }
    },
  },
  {
    name: 'After disabling receiver, no WM-Bus telegram notification arrives for 10s',
    async run(c) {
      const getConfig = async () =>
        (
          await c.exchange(
            Sap.WMBus,
            WMBus.GetActiveConfigReq,
            [],
            WMBus.GetActiveConfigRsp,
          )
        ).payload;

      const original = await getConfig();
      assertEqual(original[0], GwStatus.Ok, 'get active config status');
      assertEqual(original.length, 12, 'active config layout');
      const config = original.slice(1);

      const enabled = [...config];
      enabled[0] = 0x02; // T-Mode ON
      await c.exchange(
        Sap.WMBus,
        WMBus.SetActiveConfigReq,
        enabled,
        WMBus.SetActiveConfigRsp,
      );

      try {
        // Prove the device is actively receiving first.
        await c.waitFor(
          Sap.WMBus,
          WMBus.RxMessageInd,
          15000,
          m => m.payload.length >= 9,
        );

        const disabled = [...enabled];
        disabled[0] = 0x00; // Link Mode Off => receiver off
        await c.exchange(
          Sap.WMBus,
          WMBus.SetActiveConfigReq,
          disabled,
          WMBus.SetActiveConfigRsp,
        );

        // Once listening is disabled there should be no new Rx telegram events.
        await c.expectNoMessage(Sap.WMBus, WMBus.RxMessageInd, 10000);
      } finally {
        await c.exchange(
          Sap.WMBus,
          WMBus.SetActiveConfigReq,
          config,
          WMBus.SetActiveConfigRsp,
        );
      }
    },
  },
];

// ── runners ──────────────────────────────────────────────────────────────────

/** Progress hooks so a UI can render results live as each test completes. */
export type ConformanceProgress = SerialTestProgress;

/**
 * Run the full suite against an already-acquired port (opens & closes it). The
 * shipped {@link runSerialTests} drives one shared {@link HciHost} across every
 * case and collects a result per test without throwing.
 */
export function runWMBusConformance(
  port: SerialPort,
  progress?: SerialTestProgress,
): Promise<WMBusTestResult[]> {
  return runSerialTests(wmbusConformanceTests, port, {
    client: {
      connect: p => HciHost.open(p),
      disconnect: host => host.close(),
    },
    progress,
  });
}

/** A fresh virtual gateway port — the reference the real device is compared to. */
export async function makeVirtualGatewayPort(): Promise<SerialPort> {
  const transport = new VirtualSerialTransport();
  const gateway = new WMBusGateway('iU891A-XL');
  gateway.addMeter(
    new WMBusMeter({
      address: {
        manufacturerId: 0x1234,
        deviceId: 0x56789abc,
        version: 0x01,
        type: 0x07,
      },
      encryptionKey: new Array(16).fill(0xaa),
      linkMode: 2,
      rssi: -55,
      payloadTemplate: [0x2f, 0x2f, 0x01, 0x02, 0x03],
      intervalMs: 1200,
    }),
  );
  transport.addDevice(gateway, {hasPermission: true});
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) throw new Error('failed to create a virtual gateway port');
  return port;
}

/**
 * Run the suite against `realPort` and against the simulator, returning one
 * result per case: `passed` means the real device behaved identically to the
 * simulator (both pass / both fail the same case). The real device's progress
 * streams via `progress.onStart`; the comparison rows are emitted once it ends.
 */
export async function compareWithSimulator(
  realPort: SerialPort,
  progress?: SerialTestProgress,
): Promise<WMBusTestResult[]> {
  // Phase 1: the simulator reference (fast).
  progress?.onStart?.(
    'preparing simulator reference…',
    0,
    wmbusConformanceTests.length,
  );
  const reference = await runWMBusConformance(await makeVirtualGatewayPort());

  // Phase 2: the (slow) real device — surface its progress as each test runs,
  // then compare with the shipped helper.
  const candidate = await runWMBusConformance(realPort, {
    onStart: progress?.onStart,
  });
  const rows = compareResults(reference, candidate);
  for (const row of rows) progress?.onResult?.(row);
  return rows;
}
