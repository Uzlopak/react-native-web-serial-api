/**
 * Ported from WPT tmp/serial/serialPort_readable-manual.https.html.
 *
 * The original drives an Arduino that streams a PRNG sequence; here a
 * VirtualSerialTransport responder generates the identical sequence, delivered
 * in 1 KB chunks. Scaled from 10 MB to 1 MB so it runs quickly under Jest while
 * still exercising chunked reads + byte-exact integrity over a large stream.
 */
import {describe, expect, it} from '@jest/globals';
import {SerialDevice} from '../../testing/serial-device';
import {loopbackHarness} from './wpt-helpers';

// Matches the WPT next_byte() (and the Arduino sketch) exactly.
function makePrng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(1103515245, state) + 12345) % (1 << 31);
    return (state >> 16) & 0xff;
  };
}

// The "device": reads the 8-byte config, then emits |length| PRNG bytes.
class PrngDevice extends SerialDevice {
  readonly usbVendorId = 0x0403;
  readonly usbProductId = 0x6001;
  onData(data: Uint8Array): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const s = view.getUint32(0, /*littleEndian=*/ true);
    const n = view.getUint32(4, /*littleEndian=*/ true);
    const next = makePrng(s);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; ++i) out[i] = next();
    this.send(out);
  }
}

describe('WPT: serialPort_readable', () => {
  it('Reading 1MB from the device succeeds.', async () => {
    const seed = 10;
    const length = 1024 * 1024;

    const {port} = await loopbackHarness(
      new PrngDevice(),
      {},
      {chunkSize: 1024},
    );

    await port.open({baudRate: 115200, bufferSize: 1024});

    const config = new DataView(new ArrayBuffer(8));
    config.setUint32(0, seed, /*littleEndian=*/ true);
    config.setUint32(4, length, /*littleEndian=*/ true);

    const writer = port.writable!.getWriter();
    writer.write(new Uint8Array(config.buffer));

    const reader = port.readable!.getReader();
    const next = makePrng(seed);
    let bytesRead = 0;
    while (bytesRead < length) {
      const {value, done} = await reader.read();
      expect(done).toBe(false);
      const chunk = value!;
      for (let i = 0; i < chunk.byteLength; ++i) {
        const expected = next();
        if (chunk[i] !== expected) {
          throw new Error(
            `mismatch at byte ${bytesRead + i}: ${chunk[i]} !== ${expected}`,
          );
        }
      }
      bytesRead += chunk.byteLength;
    }

    expect(bytesRead).toBe(length);
    writer.releaseLock();
    reader.releaseLock();
    await port.close();
  });
});
