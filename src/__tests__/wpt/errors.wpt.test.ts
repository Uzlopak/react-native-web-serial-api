/**
 * Ported from WPT:
 *   tmp/serial/serialPort_loopback_BreakError-manual.https.html
 *   tmp/serial/serialPort_loopback_BufferOverrunError-manual.https.html
 *
 * The W3C spec delivers typed read errors on the readable stream (`BreakError`,
 * `BufferOverrunError`, also `FramingError`, `ParityError`). The polyfill maps
 * the transport's error name onto the DOMException, so these pass.
 */
import {describe, expect, it} from '@jest/globals';
import {
  compareArrays,
  expectDOMException,
  loopbackHarness,
} from './wpt-helpers';

describe('WPT: serialPort_loopback typed read errors', () => {
  it('Break is detected.', async () => {
    const {port, device} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 1024});

    const reader = port.readable!.getReader();
    const readPromise = (async () => {
      // A single zero byte is read before the break is detected.
      const first = await reader.read();
      compareArrays(first.value, new Uint8Array([0]));
      expect(first.done).toBe(false);

      // The next read should reject with a BreakError.
      await reader.read();
    })();

    await port.setSignals({break: true});
    // Model the loopback's break condition: a zero byte, then a BreakError.
    device.push([0]);
    device.emitError('Break received', 'BreakError');

    try {
      await readPromise;
      throw new Error('expected the read to reject with a break');
    } catch (e) {
      expectDOMException(e, 'BreakError'); // impl gives NetworkError -> throws
    }
  });

  it('Overflowing the receive buffer triggers an error.', async () => {
    // Model a 1024-byte receive buffer (matching bufferSize) that overflows.
    const {port, device} = await loopbackHarness();
    device.overrunAfter(1024);
    await port.open({baudRate: 115200, bufferSize: 1024});

    // Much larger than the receive buffer above.
    const data = new Uint8Array(16 * 1024);
    for (let i = 0; i < data.byteLength; ++i) data[i] = (i / 1024) & 0xff;

    // Read concurrently so the first 1024 bytes arrive before the overrun error.
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();

    let actualLength = 0;
    let caught: unknown;
    try {
      writer.write(data);
      while (true) {
        const {value, done} = await reader.read();
        if (value) actualLength += value.byteLength;
        if (done) throw new Error('Unexpected end of stream.');
      }
    } catch (e) {
      caught = e;
    }

    expect(actualLength).toBeGreaterThan(0); // partial data is received...
    expectDOMException(caught, 'BufferOverrunError'); // ...then impl: NetworkError
  });
});
