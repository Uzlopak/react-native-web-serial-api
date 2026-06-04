/**
 * CRC-16/IBM-SDLC (a.k.a. CRC-16/X-25) — the HCI frame check sequence.
 *
 * Parameters: poly 0x1021, init 0xFFFF, reflected in/out, xorout 0xFFFF.
 * Reflected form uses the bit-reversed polynomial 0x8408.
 */
export function crc16(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

/** The CRC as the two trailing frame bytes, LSB first (as sent over the wire). */
export function crc16Bytes(bytes: ArrayLike<number>): [number, number] {
  const crc = crc16(bytes);
  return [crc & 0xff, (crc >> 8) & 0xff];
}
