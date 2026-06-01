/**
 * Ported from WPT tmp/serial/serialPort_loopback-manual.https.html.
 *
 * The original needs a hardware loopback device (TX↔RX wired); here an echo
 * VirtualSerialTransport plays that role, so the exact read/write assertions run
 * under Jest.
 */
import {describe, it} from '@jest/globals';
import {compareArrays, loopbackHarness, readWithLength} from './wpt-helpers';

describe('WPT: serialPort_loopback', () => {
  it('Can perform a series of small writes.', async () => {
    const {port} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 1024});

    // Create something much smaller than bufferSize above.
    const data = new Uint8Array(64);
    for (let i = 0; i < data.byteLength; ++i) data[i] = i & 0xff;

    const reader = port.readable!.getReader();
    for (let i = 0; i < 10; ++i) {
      const writer = port.writable!.getWriter();
      writer.write(data);
      const writePromise = writer.close();

      const value = await readWithLength(reader, data.byteLength);
      await writePromise;

      compareArrays(value, data);
    }
    reader.releaseLock();
    await port.close();
  });

  it('Can perform a series of large writes.', async () => {
    const {port} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 1024});

    // Create something much larger than bufferSize above.
    const data = new Uint8Array(10 * 1024);
    for (let i = 0; i < data.byteLength; ++i) data[i] = (i / 1024) & 0xff;

    const reader = port.readable!.getReader();
    for (let i = 0; i < 10; ++i) {
      const writer = port.writable!.getWriter();
      writer.write(data);
      const writePromise = writer.close();

      const value = await readWithLength(reader, data.byteLength);
      await writePromise;

      compareArrays(value, data);
    }
    reader.releaseLock();
    await port.close();
  });

  it('Canceling the reader discards buffered data.', async () => {
    const {port} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 64});

    const writer = port.writable!.getWriter();
    let data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await writer.write(data);

    // Let the device process the incoming data (microtask, not a timer — the RN
    // jest preset runs with fake timers)...
    await Promise.resolve();
    // ...before discarding the receive buffers. Re-acquiring readable after
    // cancel() must keep working (the polyfill must not leak the old onData
    // subscription onto the new stream).
    await port.readable!.cancel();

    data = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
    const reader = port.readable!.getReader();
    const readPromise = readWithLength(reader, data.byteLength);

    await writer.write(data);
    writer.releaseLock();

    const value = await readPromise;
    reader.releaseLock();
    compareArrays(value, data);
    await port.close();
  });
});
