/**
 * Gateway configuration, device-list item (de)serialisation, and the in-memory
 * NVM snapshot. Config is 11 bytes; a device-list item is 24 bytes (8-byte
 * address + 16-byte key, the key stored MSB-first). See spec p25, p31-33.
 */
import {ByteReader, ByteWriter} from './bytes';
import {readAddress, type WMBusAddress, writeAddress} from './frame';

export type GatewayConfig = {
  linkMode: number;
  options: number;
  uiOptions: number;
  ledFlashTiming: number;
  recalTimeout: number;
};

/**
 * Factory default. Options 0x0E = Rx-notify (bit1) + Tx-notify (bit2) +
 * re-calibration (bit3), so received meter telegrams are forwarded to the host
 * out of the box (the demo relies on this).
 */
export const DEFAULT_CONFIG: GatewayConfig = {
  linkMode: 0,
  options: 0x0e,
  uiOptions: 0x0000,
  ledFlashTiming: 50,
  recalTimeout: 5000,
};

export const CONFIG_OPT_ADDRESS_FILTER = 1 << 0;
export const CONFIG_OPT_RX_NOTIFY = 1 << 1;
export const CONFIG_OPT_TX_NOTIFY = 1 << 2;

export function encodeConfig(c: GatewayConfig): number[] {
  return new ByteWriter()
    .u8(c.linkMode)
    .u16le(c.options)
    .u16le(c.uiOptions)
    .u16le(c.ledFlashTiming)
    .u32le(c.recalTimeout).bytes;
}

export function decodeConfig(bytes: ArrayLike<number>): GatewayConfig {
  const r = new ByteReader(bytes);
  return {
    linkMode: r.u8(),
    options: r.u16le(),
    uiOptions: r.u16le(),
    ledFlashTiming: r.u16le(),
    recalTimeout: r.u32le(),
  };
}

/**
 * Device-list capacity, matching real hardware (IMST `MaxWMBusListItems = 10`).
 * Appending past it stores only what fits and reports `DataTruncated`; the
 * 16-bit "free / remaining items" field in AppendDeviceListRsp is `free =
 * MAX_DEVICE_LIST_ITEMS - length`.
 */
export const MAX_DEVICE_LIST_ITEMS = 10;
export const DEVICE_ITEM_BYTES = 24;
const KEY_BYTES = 16;

export type DeviceListItem = {
  address: WMBusAddress;
  key: number[]; // 16 bytes, MSB first
};

export function encodeDeviceItem(item: DeviceListItem): number[] {
  const w = new ByteWriter();
  writeAddress(w, item.address);
  const key = item.key.slice(0, KEY_BYTES);
  while (key.length < KEY_BYTES) key.push(0);
  return w.raw(key).bytes;
}

export function decodeDeviceItem(r: ByteReader): DeviceListItem {
  const address = readAddress(r);
  const key = r.bytes(KEY_BYTES);
  return {address, key};
}

export function sameAddress(a: WMBusAddress, b: WMBusAddress): boolean {
  return (
    a.manufacturerId === b.manufacturerId &&
    a.deviceId === b.deviceId &&
    a.version === b.version &&
    a.type === b.type
  );
}

export function cloneItems(items: DeviceListItem[]): DeviceListItem[] {
  return items.map(it => ({address: {...it.address}, key: [...it.key]}));
}
