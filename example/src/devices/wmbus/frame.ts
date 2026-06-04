/**
 * WM-Bus address + packet helpers.
 *
 * On the wire the multi-byte address fields (Manufacturer ID, Device ID) are
 * little-endian (LSB first), as transmitted over the air (spec p28/p33/p36).
 * The serial "WM-Bus Packet Field" is `L C ManID(2) DevID(4) Ver Type Data…`
 * with the radio CRCs stripped; the L-field counts the bytes after itself.
 */
import {ByteReader, ByteWriter} from './bytes';

export type WMBusAddress = {
  manufacturerId: number;
  deviceId: number;
  version: number;
  type: number;
};

/** C-field SND-NR (send, no reply) — the usual meter→gateway frame. */
export const C_FIELD_SND_NR = 0x44;

export function writeAddress(w: ByteWriter, a: WMBusAddress): void {
  w.u16le(a.manufacturerId).u32le(a.deviceId).u8(a.version).u8(a.type);
}

export function readAddress(r: ByteReader): WMBusAddress {
  return {
    manufacturerId: r.u16le(),
    deviceId: r.u32le(),
    version: r.u8(),
    type: r.u8(),
  };
}

/**
 * Build a serial-format WM-Bus packet (`L C addr data`). `data` is everything
 * after the address (CI-field, transport layer, application data). The
 * length-field is computed; radio CRCs are not included (the gateway strips
 * them on receive).
 */
export function buildWMBusPacket(
  address: WMBusAddress,
  data: ArrayLike<number> = [],
  cField: number = C_FIELD_SND_NR,
): number[] {
  const body = new ByteWriter().u8(cField);
  writeAddress(body, address);
  body.raw(data);
  return new ByteWriter().u8(body.bytes.length).raw(body.bytes).bytes;
}

/** Read the address out of a serial-format packet (skips L- and C-fields). */
export function addressFromPacket(packet: ArrayLike<number>): WMBusAddress {
  const r = new ByteReader(packet);
  r.u8(); // L-field
  r.u8(); // C-field
  return readAddress(r);
}
