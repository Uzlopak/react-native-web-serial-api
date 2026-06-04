/**
 * SLIP framing (RFC 1055) as used by the IMST HCI endpoint.
 *
 * Each HCI message is wrapped END … END; 0xC0/0xDB bytes inside are escaped.
 */
export const SLIP = {
  END: 0xc0,
  ESC: 0xdb,
  ESC_END: 0xdc,
  ESC_ESC: 0xdd,
} as const;

/** Wrap a message in `END … END`, escaping any END/ESC bytes in the payload. */
export function slipEncode(payload: ArrayLike<number>): number[] {
  const out: number[] = [SLIP.END];
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i] & 0xff;
    if (b === SLIP.END) out.push(SLIP.ESC, SLIP.ESC_END);
    else if (b === SLIP.ESC) out.push(SLIP.ESC, SLIP.ESC_ESC);
    else out.push(b);
  }
  out.push(SLIP.END);
  return out;
}

/**
 * Streaming SLIP decoder. Feed raw bytes from successive serial reads; each
 * call returns the (unescaped, END-stripped) payloads of every frame completed
 * by that chunk. Partial frames are buffered across calls, empty frames
 * (back-to-back END bytes) are ignored, and bytes before the first END are
 * discarded.
 */
export class SlipDecoder {
  #frame: number[] = [];
  #escaped = false;
  #started = false;

  push(chunk: ArrayLike<number>): number[][] {
    const frames: number[][] = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i] & 0xff;
      if (b === SLIP.END) {
        if (this.#started && this.#frame.length > 0) frames.push(this.#frame);
        this.#frame = [];
        this.#escaped = false;
        this.#started = true;
        continue;
      }
      if (!this.#started) continue;
      if (this.#escaped) {
        this.#frame.push(b === SLIP.ESC_END ? SLIP.END : b === SLIP.ESC_ESC ? SLIP.ESC : b);
        this.#escaped = false;
      } else if (b === SLIP.ESC) {
        this.#escaped = true;
      } else {
        this.#frame.push(b);
      }
    }
    return frames;
  }

  /** Drop any partially-buffered frame (e.g. on close/restart). */
  reset(): void {
    this.#frame = [];
    this.#escaped = false;
    this.#started = false;
  }
}
