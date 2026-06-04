/** Little binary read/write helpers for building & parsing HCI payloads. */

export class ByteWriter {
  readonly bytes: number[] = [];

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16le(v: number): this {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }

  u32le(v: number): this {
    this.bytes.push(
      v & 0xff,
      (v >>> 8) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 24) & 0xff,
    );
    return this;
  }

  u16be(v: number): this {
    this.bytes.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  u32be(v: number): this {
    this.bytes.push(
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    );
    return this;
  }

  raw(arr: ArrayLike<number>): this {
    for (let i = 0; i < arr.length; i++) this.bytes.push(arr[i] & 0xff);
    return this;
  }

  /** ASCII string; if `len` is given the field is zero-padded/truncated to it. */
  ascii(s: string, len?: number): this {
    const codes = Array.from(s, c => c.charCodeAt(0) & 0xff);
    if (len === undefined) return this.raw(codes);
    for (let i = 0; i < len; i++) this.bytes.push(codes[i] ?? 0);
    return this;
  }
}

export class ByteReader {
  #i = 0;
  readonly #data: ArrayLike<number>;

  constructor(data: ArrayLike<number>) {
    this.#data = data;
  }

  get remaining(): number {
    return this.#data.length - this.#i;
  }

  u8(): number {
    return this.#data[this.#i++] & 0xff;
  }

  u16le(): number {
    return (this.u8() | (this.u8() << 8)) >>> 0;
  }

  u32le(): number {
    return (
      (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>>
      0
    );
  }

  u16be(): number {
    return ((this.u8() << 8) | this.u8()) >>> 0;
  }

  u32be(): number {
    return (
      ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>>
      0
    );
  }

  bytes(n: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(this.u8());
    return out;
  }

  rest(): number[] {
    return this.bytes(this.remaining);
  }
}
