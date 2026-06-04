/**
 * Simulated IMST Wireless M-Bus gateway, authored as a {@link SerialDevice}.
 *
 * It speaks the IMST HCI protocol (SLIP + CRC-16/IBM-SDLC) over the virtual
 * serial link: the host writes framed requests, the gateway parses them in
 * `onData`, and replies/streams events via `this.send`. It also hosts virtual
 * {@link WMBusMeter}s whose telegrams are forwarded as WM-Bus Packet Received
 * (0x20) events. See WM_Bus_Gateway_HCI_Protocol_Specification.pdf.
 */
import {SerialDevice} from 'react-native-web-serial-api/testing';
import {ByteReader, ByteWriter} from './bytes';
import {addressFromPacket, readAddress, writeAddress, type WMBusAddress} from './frame';
import {
  ApprovalStatus,
  ApprovalTest,
  DevMgmt,
  DevStatus,
  GwStatus,
  type HciMessage,
  Sap,
  WMBus,
  decodeHci,
  encodeHci,
} from './hci';
import {FIRMWARE, MODULES, type ModuleVariant} from './modules';
import {
  CONFIG_OPT_ADDRESS_FILTER,
  CONFIG_OPT_RX_NOTIFY,
  CONFIG_OPT_TX_NOTIFY,
  DEFAULT_CONFIG,
  DEVICE_ITEM_BYTES,
  type DeviceListItem,
  type GatewayConfig,
  MAX_DEVICE_LIST_ITEMS,
  cloneItems,
  decodeConfig,
  decodeDeviceItem,
  encodeConfig,
  encodeDeviceItem,
  sameAddress,
} from './nvm';
import {SlipDecoder, slipEncode} from './slip';
import type {InjectOptions, WMBusMeter} from './WMBusMeter';

const RESTART_DELAY_MS = 200;

const OPT_RTC = 1 << 2;
const OPT_WATCHDOG = 1 << 3;
const OPT_STARTUP_EVENT = 1 << 4;

/**
 * Map a WM-Bus Link Mode (LM_*) to the Packet Info (PI_*) code carried in the
 * Rx/Scan events (spec; C++ `OnWMBusRxPacketEvent`/`OnScanModeResultEvent` decode
 * this byte as PI_*, a *different* enum from LM_*). The two coincide for the real
 * transmit modes; CT is a receiver-only mode, so a frame received in CT is
 * reported as its actual link mode (default T-Mode).
 */
const PACKET_INFO_BY_LINK_MODE: Record<number, number> = {
  0x01: 0x01, // S-Mode
  0x02: 0x02, // T-Mode
  0x03: 0x02, // CT-Mode receiver → report received frame as T-Mode
  0x04: 0x04, // C-Mode 50 kbps (Format A)
  0x05: 0x05, // C-Mode 100 kbps (Format A)
  0x06: 0x06, // Enhanced T-Mode
};

/** PI_* packet-info code for a given LM_* link mode (unknown → passthrough). */
function packetInfoForLinkMode(linkMode: number): number {
  return PACKET_INFO_BY_LINK_MODE[linkMode] ?? linkMode;
}

type Counters = {
  reset: number;
  rxPkt: number;
  rxReject: number;
  rxError: number;
  txPkt: number;
  txError: number;
};

type RadioConfig = {options: number; txDelay: number};

type Nvm = {
  defaultConfig: GatewayConfig;
  deviceList: DeviceListItem[];
  radioConfig: RadioConfig;
  wmbusAddress: WMBusAddress;
};

const ZERO_ADDRESS: WMBusAddress = {
  manufacturerId: 0,
  deviceId: 0,
  version: 0,
  type: 0,
};

export class WMBusGateway extends SerialDevice {
  readonly usbVendorId: number;
  readonly usbProductId: number;
  readonly serialNumber: string;
  readonly variant: ModuleVariant;

  readonly #slip = new SlipDecoder();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #meters = new Set<WMBusMeter>();
  #open = false;

  #dateTime = 0;
  #lastSync = 0;
  #timeSynced = false;
  #opMode = 0;
  #systemOptions = OPT_RTC | OPT_WATCHDOG;
  #scan = {linkModes: 0, period: 0, active: false};
  #counters: Counters = {
    reset: 0,
    rxPkt: 0,
    rxReject: 0,
    rxError: 0,
    txPkt: 0,
    txError: 0,
  };

  #config: GatewayConfig = {...DEFAULT_CONFIG};
  readonly #nvm: Nvm = {
    defaultConfig: {...DEFAULT_CONFIG},
    deviceList: [],
    radioConfig: {options: 0, txDelay: 120},
    wmbusAddress: {...ZERO_ADDRESS},
  };
  #deviceList: DeviceListItem[] = [];

  constructor(
    variant: ModuleVariant = 'iU891A-XL',
    usb: {usbVendorId?: number; usbProductId?: number; serialNumber?: string} = {},
  ) {
    super();
    const info = MODULES[variant];
    this.variant = variant;
    // The WM-Bus module type is independent of the USB-serial bridge chip, so
    // the enumerated VID/PID can be overridden (e.g. to disambiguate in a demo).
    this.usbVendorId = usb.usbVendorId ?? info.usbVendorId;
    this.usbProductId = usb.usbProductId ?? info.usbProductId;
    this.serialNumber = usb.serialNumber ?? `VIRT-${variant}`;
  }

  // ── SerialDevice lifecycle ────────────────────────────────────────────────

  onOpen(): void {
    this.#open = true;
    this.#syncMeters();
  }

  onData(data: Uint8Array): void {
    for (const frame of this.#slip.push(data)) {
      const message = decodeHci(frame);
      if (!message) {
        this.#counters.rxError++;
        continue;
      }
      this.#dispatch(message);
    }
  }

  onClose(): void {
    this.#open = false;
    this.#slip.reset();
    this.#clearTimers();
    this.#syncMeters();
  }

  // ── Virtual meter management ──────────────────────────────────────────────

  addMeter(meter: WMBusMeter): this {
    meter._attach(this);
    this.#meters.add(meter);
    const key = meter.encryptionKey ?? new Array(16).fill(0);
    if (!this.#deviceList.some(it => sameAddress(it.address, meter.address))) {
      if (this.#deviceList.length < MAX_DEVICE_LIST_ITEMS) {
        this.#deviceList.push({address: {...meter.address}, key: [...key]});
      }
    }
    this.#syncMeters();
    return this;
  }

  removeMeter(meter: WMBusMeter): void {
    meter._detach();
    this.#meters.delete(meter);
    this.#deviceList = this.#deviceList.filter(
      it => !sameAddress(it.address, meter.address),
    );
  }

  getMeters(): WMBusMeter[] {
    return [...this.#meters];
  }

  /**
   * Forward a received WM-Bus packet to the host as a 0x20 (or, in scan mode,
   * 0x24) event — honouring the address filter, Rx-notify option, and looking
   * up the device-list key to report the decryption status.
   */
  injectRxPacket(packet: number[], options: InjectOptions = {}): void {
    // The receiver is only on once the host selects a link mode (Set Active
    // Configuration) or enables scan mode; with Link Mode = Off nothing is
    // received, so the packet is dropped before it is even counted.
    if (!this.#radioOn()) return;
    this.#counters.rxPkt++;
    const address = addressFromPacket(packet);
    const filter = this.#config.options & CONFIG_OPT_ADDRESS_FILTER;
    const known = this.#deviceList.some(it => sameAddress(it.address, address));
    if (filter && !known) {
      this.#counters.rxReject++;
      return;
    }
    if (!(this.#config.options & CONFIG_OPT_RX_NOTIFY)) return;

    const encMode = options.encryptionMode ?? 0;
    const decStatus = encMode === 0 ? 0 : this.#hasKey(address) ? 1 : 2;
    const linkMode = options.linkMode ?? this.#config.linkMode;
    const rssi = options.rssi ?? -50;
    const time = options.timestamp ?? this.#dateTime;

    const packetInfo = packetInfoForLinkMode(linkMode);

    if (this.#scan.active) {
      const payload = new ByteWriter()
        .u32le(time)
        .u8(packetInfo)
        .u8(rssi & 0xff)
        .raw(packet.slice(0, 10)).bytes; // link-layer header (10 bytes)
      this.sendMessage(Sap.WMBus, WMBus.ScanModeInd, payload);
      return;
    }
    const payload = new ByteWriter()
      .u32le(time)
      .u8(decStatus)
      .u8(encMode)
      .u8(packetInfo)
      .u8(rssi & 0xff)
      .raw(packet).bytes;
    this.sendMessage(Sap.WMBus, WMBus.RxMessageInd, payload);
  }

  // ── HCI plumbing ──────────────────────────────────────────────────────────

  protected sendMessage(
    sap: number,
    msg: number,
    payload: ArrayLike<number> = [],
  ): void {
    this.send(slipEncode(encodeHci(sap, msg, payload)));
  }

  #dispatch(message: HciMessage): void {
    switch (message.sap) {
      case Sap.DevMgmt:
        this.#handleDevMgmt(message);
        return;
      case Sap.WMBus:
        this.#handleWMBus(message);
        return;
      case Sap.ApprovalTest:
        this.#handleApprovalTest(message);
        return;
      default:
        return;
    }
  }

  #after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** The radio receives only when a link mode is selected or scan mode is on. */
  #radioOn(): boolean {
    return this.#config.linkMode !== 0 || this.#scan.active;
  }

  /** Start/stop hosted meters so they only stream while open and receiving. */
  #syncMeters(): void {
    const on = this.#open && this.#radioOn();
    for (const meter of this.#meters) {
      if (on && meter.autoStream && meter.intervalMs > 0) meter.startPeriodic();
      else meter.stopPeriodic();
    }
  }

  #restart(): void {
    this.#counters.reset++;
    this.#slip.reset();
    this.#config = {...this.#nvm.defaultConfig};
    this.#deviceList = cloneItems(this.#nvm.deviceList);
    // Scan mode is volatile RAM state — a reboot clears it (and SB_ScanMode_Active).
    this.#scan = {linkModes: 0, period: 0, active: false};
    this.#syncMeters();
    if (this.#systemOptions & OPT_STARTUP_EVENT) this.#sendStartupInd();
  }

  #hasKey(address: WMBusAddress): boolean {
    const item = this.#deviceList.find(it => sameAddress(it.address, address));
    return !!item && item.key.some(b => b !== 0);
  }

  // ── Device Management SAP (0x01) ──────────────────────────────────────────

  #handleDevMgmt(m: HciMessage): void {
    switch (m.msg) {
      case DevMgmt.PingReq:
        this.sendMessage(Sap.DevMgmt, DevMgmt.PingRsp, [DevStatus.Ok]);
        return;
      case DevMgmt.GetDeviceInfoReq:
        this.sendMessage(Sap.DevMgmt, DevMgmt.GetDeviceInfoRsp, this.#deviceInfo());
        return;
      case DevMgmt.GetFwInfoReq:
        this.sendMessage(Sap.DevMgmt, DevMgmt.GetFwInfoRsp, this.#firmwareInfo());
        return;
      case DevMgmt.RestartReq:
        this.sendMessage(Sap.DevMgmt, DevMgmt.RestartRsp, [DevStatus.Ok]);
        this.#after(RESTART_DELAY_MS, () => this.#restart());
        return;
      case DevMgmt.SetOpModeReq:
        this.#opMode = m.payload[0] ?? 0;
        this.sendMessage(Sap.DevMgmt, DevMgmt.SetOpModeRsp, [DevStatus.Ok]);
        this.#after(RESTART_DELAY_MS, () => this.#restart());
        return;
      case DevMgmt.GetOpModeReq:
        this.sendMessage(Sap.DevMgmt, DevMgmt.GetOpModeRsp, [
          DevStatus.Ok,
          this.#opMode,
        ]);
        return;
      case DevMgmt.SetDateTimeReq:
        this.#dateTime = new ByteReader(m.payload).u32le();
        this.#lastSync = this.#dateTime;
        this.#timeSynced = true;
        this.sendMessage(Sap.DevMgmt, DevMgmt.SetDateTimeRsp, [DevStatus.Ok]);
        return;
      case DevMgmt.GetDateTimeReq:
        this.sendMessage(
          Sap.DevMgmt,
          DevMgmt.GetDateTimeRsp,
          new ByteWriter().u8(DevStatus.Ok).u32le(this.#dateTime).bytes,
        );
        return;
      case DevMgmt.SetSystemOptionsReq: {
        const r = new ByteReader(m.payload);
        const mask = r.u32le();
        const values = r.u32le();
        this.#systemOptions =
          ((this.#systemOptions & ~mask) | (values & mask)) >>> 0;
        this.sendMessage(Sap.DevMgmt, DevMgmt.SetSystemOptionsRsp, [DevStatus.Ok]);
        return;
      }
      case DevMgmt.GetSystemOptionsReq:
        this.sendMessage(
          Sap.DevMgmt,
          DevMgmt.GetSystemOptionsRsp,
          new ByteWriter().u8(DevStatus.Ok).u32le(this.#systemOptions).bytes,
        );
        return;
      default:
        return;
    }
  }

  #deviceInfo(): number[] {
    const info = MODULES[this.variant];
    return new ByteWriter()
      .u8(DevStatus.Ok)
      .u8(info.moduleType)
      .u32le(info.moduleId)
      .u32le(info.productType)
      .u32le(info.productId).bytes;
  }

  #firmwareInfo(): number[] {
    return new ByteWriter()
      .u8(DevStatus.Ok)
      .u8(FIRMWARE.versionMinor)
      .u8(FIRMWARE.versionMajor)
      .u16le(FIRMWARE.buildCount)
      .ascii(FIRMWARE.buildDate, 10)
      .ascii(FIRMWARE.name).bytes;
  }

  #sendStartupInd(): void {
    const info = MODULES[this.variant];
    const payload = new ByteWriter()
      .u32le(0)
      .u8(info.moduleType)
      .u32le(info.moduleId)
      .u32le(info.productType)
      .u32le(info.productId)
      .u8(FIRMWARE.versionMinor)
      .u8(FIRMWARE.versionMajor)
      .u16le(FIRMWARE.buildCount)
      .ascii(FIRMWARE.buildDate, 10)
      .ascii(FIRMWARE.name).bytes;
    this.sendMessage(Sap.DevMgmt, DevMgmt.StartupInd, payload);
  }

  // ── WM-Bus Gateway SAP (0x09) ─────────────────────────────────────────────

  #handleWMBus(m: HciMessage): void {
    switch (m.msg) {
      case WMBus.GetActiveConfigReq:
        this.#sendConfig(WMBus.GetActiveConfigRsp, this.#config);
        return;
      case WMBus.SetActiveConfigReq:
        this.#config = decodeConfig(m.payload);
        this.#syncMeters();
        this.#ack(WMBus.SetActiveConfigRsp);
        return;
      case WMBus.GetDefaultConfigReq:
        this.#sendConfig(WMBus.GetDefaultConfigRsp, this.#nvm.defaultConfig);
        return;
      case WMBus.SetDefaultConfigReq:
        this.#nvm.defaultConfig = decodeConfig(m.payload);
        this.#ack(WMBus.SetDefaultConfigRsp);
        this.#after(RESTART_DELAY_MS, () => this.#restart());
        return;
      case WMBus.ResetDefaultConfigReq:
        this.#nvm.defaultConfig = {...DEFAULT_CONFIG};
        this.#ack(WMBus.ResetDefaultConfigRsp);
        this.#after(RESTART_DELAY_MS, () => this.#restart());
        return;
      case WMBus.ClearDeviceListReq:
        this.#deviceList = [];
        this.#ack(WMBus.ClearDeviceListRsp);
        return;
      case WMBus.AppendDeviceListReq:
        this.#appendDeviceList(m.payload);
        return;
      case WMBus.ReadDeviceListReq:
        this.#readDeviceList(m.payload);
        return;
      case WMBus.SaveDeviceListReq:
        this.#nvm.deviceList = cloneItems(this.#deviceList);
        this.#ack(WMBus.SaveDeviceListRsp);
        return;
      case WMBus.LoadDeviceListReq:
        this.#deviceList = cloneItems(this.#nvm.deviceList);
        this.sendMessage(
          Sap.WMBus,
          WMBus.LoadDeviceListRsp,
          new ByteWriter().u8(GwStatus.Ok).u16le(this.#deviceList.length).bytes,
        );
        return;
      case WMBus.SetScanModeReq: {
        const r = new ByteReader(m.payload);
        this.#scan.linkModes = r.u8();
        this.#scan.period = r.remaining >= 2 ? r.u16le() : 0;
        this.#scan.active = this.#scan.linkModes !== 0;
        this.#syncMeters();
        this.#ack(WMBus.SetScanModeRsp);
        return;
      }
      case WMBus.SendMessageReq:
        this.#handleSend(m.payload, WMBus.SendMessageRsp, WMBus.MessageTransmittedInd);
        return;
      case WMBus.EncryptSendReq:
        this.#handleEncryptSend(
          m.payload,
          WMBus.EncryptSendRsp,
          WMBus.EncryptedMessageTransmittedInd,
        );
        return;
      case WMBus.SendPacketReq: // Send-II (iU891A-XL only)
        if (!MODULES[this.variant].hasStoredAddress) {
          this.#fail(WMBus.SendPacketRsp, GwStatus.Unsupported);
          return;
        }
        this.#handleSend(m.payload, WMBus.SendPacketRsp, WMBus.MessageTransmittedInd);
        return;
      case WMBus.EncryptSendPacketReq: // Encrypt-and-Send-II (iU891A-XL only)
        if (!MODULES[this.variant].hasStoredAddress) {
          this.#fail(WMBus.EncryptSendPacketRsp, GwStatus.Unsupported);
          return;
        }
        this.#handleEncryptSend(
          m.payload,
          WMBus.EncryptSendPacketRsp,
          WMBus.EncryptedMessageTransmittedInd,
          this.#nvm.wmbusAddress,
        );
        return;
      case WMBus.GetStatusReportReq:
        this.sendMessage(Sap.WMBus, WMBus.GetStatusReportRsp, this.#statusReport());
        return;
      case WMBus.ResetStatusReportReq:
        this.#counters.rxPkt = 0;
        this.#counters.rxReject = 0;
        this.#counters.rxError = 0;
        this.#counters.txPkt = 0;
        this.#counters.txError = 0;
        this.#ack(WMBus.ResetStatusReportRsp);
        return;
      case WMBus.GetRadioConfigReq:
        if (!MODULES[this.variant].hasRadioControl) {
          this.#fail(WMBus.GetRadioConfigRsp, GwStatus.Unsupported);
          return;
        }
        this.sendMessage(
          Sap.WMBus,
          WMBus.GetRadioConfigRsp,
          new ByteWriter()
            .u8(GwStatus.Ok)
            .u32le(this.#nvm.radioConfig.options)
            .u16le(this.#nvm.radioConfig.txDelay).bytes,
        );
        return;
      case WMBus.SetRadioConfigReq: {
        if (!MODULES[this.variant].hasRadioControl) {
          this.#fail(WMBus.SetRadioConfigRsp, GwStatus.Unsupported);
          return;
        }
        const r = new ByteReader(m.payload);
        this.#nvm.radioConfig = {options: r.u32le(), txDelay: r.u16le()};
        this.#ack(WMBus.SetRadioConfigRsp);
        return;
      }
      case WMBus.GetWMBusAddressReq: {
        if (!MODULES[this.variant].hasStoredAddress) {
          this.#fail(WMBus.GetWMBusAddressRsp, GwStatus.Unsupported);
          return;
        }
        const w = new ByteWriter().u8(GwStatus.Ok);
        writeAddress(w, this.#nvm.wmbusAddress);
        this.sendMessage(Sap.WMBus, WMBus.GetWMBusAddressRsp, w.bytes);
        return;
      }
      default:
        return;
    }
  }

  #ack(rsp: number, status: number = GwStatus.Ok): void {
    this.sendMessage(Sap.WMBus, rsp, [status]);
  }

  #fail(rsp: number, status: number): void {
    this.sendMessage(Sap.WMBus, rsp, [status]);
  }

  #sendConfig(rsp: number, config: GatewayConfig): void {
    this.sendMessage(
      Sap.WMBus,
      rsp,
      new ByteWriter().u8(GwStatus.Ok).raw(encodeConfig(config)).bytes,
    );
  }

  #appendDeviceList(payload: number[]): void {
    const count = Math.floor(payload.length / DEVICE_ITEM_BYTES);
    const r = new ByteReader(payload);
    let appended = 0;
    for (let i = 0; i < count; i++) {
      const item = decodeDeviceItem(r);
      if (this.#deviceList.length >= MAX_DEVICE_LIST_ITEMS) break;
      this.#deviceList.push(item);
      appended++;
    }
    const free = MAX_DEVICE_LIST_ITEMS - this.#deviceList.length;
    // The real gateway reports DataTruncated when the list can't hold every item.
    const status = appended < count ? GwStatus.DataTruncated : GwStatus.Ok;
    this.sendMessage(
      Sap.WMBus,
      WMBus.AppendDeviceListRsp,
      new ByteWriter().u8(status).u16le(appended).u16le(free).bytes,
    );
  }

  #readDeviceList(payload: number[]): void {
    const index = payload[0] ?? 0;
    const max = Math.min(payload[1] ?? 0, MAX_DEVICE_LIST_ITEMS);
    const slice = this.#deviceList.slice(index, index + max);
    const w = new ByteWriter().u8(GwStatus.Ok);
    for (const item of slice) w.raw(encodeDeviceItem(item));
    this.sendMessage(Sap.WMBus, WMBus.ReadDeviceListRsp, w.bytes);
  }

  #handleSend(_payload: number[], rsp: number, txInd: number): void {
    // payload: packetMode(1) power(1) content(n) — accepted as-is by the sim
    this.#counters.txPkt++;
    this.#ack(rsp);
    if (this.#config.options & CONFIG_OPT_TX_NOTIFY) {
      this.sendMessage(
        Sap.WMBus,
        txInd,
        new ByteWriter().u32le(this.#dateTime).u8(0).bytes, // status 0 = success
      );
    }
  }

  #handleEncryptSend(
    payload: number[],
    rsp: number,
    txInd: number,
    fixedAddress?: WMBusAddress,
  ): void {
    // payload: encMode(1) packetMode(1) power(1) content(n)
    const content = payload.slice(3);
    const address = fixedAddress ?? this.#addressFromContent(content);
    if (!address || !this.#hasKey(address)) {
      this.#fail(rsp, GwStatus.NoKey);
      this.#counters.txError++;
      return;
    }
    this.#counters.txPkt++;
    this.#ack(rsp);
    if (this.#config.options & CONFIG_OPT_TX_NOTIFY) {
      this.sendMessage(
        Sap.WMBus,
        txInd,
        new ByteWriter().u32le(this.#dateTime).u8(0).bytes,
      );
    }
  }

  /** Content-I layout: C(1) ManID(2) DevID(4) Ver(1) Type(1) CI(1) … */
  #addressFromContent(content: number[]): WMBusAddress | null {
    if (content.length < 9) return null;
    const r = new ByteReader(content);
    r.u8(); // C-field
    return readAddress(r);
  }

  #statusReport(): number[] {
    let statusBits = 0;
    if (this.#timeSynced) statusBits |= 1 << 0;
    statusBits |= 1 << 1; // default config valid
    statusBits |= 1 << 2; // device list valid
    statusBits |= 1 << 3; // radio config valid
    statusBits |= 1 << 4; // radio access
    if (this.#scan.active) statusBits |= 1 << 5;
    if (MODULES[this.variant].hasStoredAddress) statusBits |= 1 << 6;

    return new ByteWriter()
      .u8(GwStatus.Ok)
      .u32le(this.#dateTime)
      .u32le(this.#lastSync)
      .u8(this.#config.linkMode)
      .u16le(statusBits)
      .u32le(this.#counters.reset)
      .u32le(this.#counters.rxPkt)
      .u32le(this.#counters.rxReject)
      .u32le(this.#counters.rxError)
      .u32le(this.#counters.txPkt)
      .u32le(this.#counters.txError)
      .u32le(0).bytes; // reserved info
  }

  // ── Approval Test SAP (0x20, iM881A-XL / iM891A-XL only) ──────────────────

  #handleApprovalTest(m: HciMessage): void {
    // These handlers only exist on iM modules running in Approval Test mode
    // (operation mode 6); otherwise the real firmware does not respond at all.
    if (!MODULES[this.variant].hasApprovalTest || this.#opMode !== 6) return;
    switch (m.msg) {
      case ApprovalTest.ResetTestReq:
        // Stops any running test, then performs a software reset (~200 ms).
        this.sendMessage(Sap.ApprovalTest, ApprovalTest.ResetTestRsp, [
          ApprovalStatus.Ok,
        ]);
        this.#after(RESTART_DELAY_MS, () => this.#restart());
        return;
      case ApprovalTest.EnableCwReq:
        this.sendMessage(Sap.ApprovalTest, ApprovalTest.EnableCwRsp, [
          this.#approvalTxStatus(m.payload),
        ]);
        return;
      case ApprovalTest.EnablePn9Req:
        this.sendMessage(Sap.ApprovalTest, ApprovalTest.EnablePn9Rsp, [
          this.#approvalTxStatus(m.payload),
        ]);
        return;
      default:
        return;
    }
  }

  /** Validate a CW/PN9 request: RadioIndex 0..3, LinkMode S/T/CT/C50/C100 (1..5). */
  #approvalTxStatus(payload: number[]): number {
    const radioIndex = payload[0] ?? 0;
    const linkMode = payload[1] ?? 0;
    if (radioIndex > 3) return ApprovalStatus.WrongRadioIndex;
    if (linkMode < 1 || linkMode > 5) return ApprovalStatus.WrongRadioMode;
    return ApprovalStatus.Ok;
  }
}
