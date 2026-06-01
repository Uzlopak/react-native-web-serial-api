/**
 * Ported from WPT tmp/serial/serialPort_disconnect-manual.https.html.
 *
 * On disconnect the pending read/write rejects with `NetworkError`,
 * `port.readable`/`port.writable` become null, and a `disconnect` event fires
 * whose `target` is the SerialPort (it bubbles from the port to `serial`).
 */
import {describe, expect, it} from '@jest/globals';
import type {Event} from '../../lib/event-target';
import {expectDOMException, loopbackHarness} from './wpt-helpers';

describe('WPT: serialPort_disconnect', () => {
  it('a device read error surfaces as NetworkError and clears readable', async () => {
    const {port, device} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 1024});
    const reader = port.readable!.getReader();

    device.emitError('Device disconnected');

    let caught: unknown;
    try {
      await reader.read();
    } catch (e) {
      caught = e;
    }
    expectDOMException(caught, 'NetworkError');
    reader.releaseLock();
    expect(port.readable).toBeNull();
  });

  it('Disconnect during read is detected.', async () => {
    const {serial, port, device} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 1024});

    let disconnectEvent: Event | undefined;
    serial.addEventListener('disconnect', e => {
      disconnectEvent = e;
    });

    const reader = port.readable!.getReader();
    // "Unplug" once the first read is pending (a microtask, not a timer: the
    // RN jest preset runs with fake timers).
    void Promise.resolve().then(() => device.loseDevice());

    let caught: unknown;
    try {
      for (let i = 0; i < 100000; ++i) {
        const {done} = await reader.read();
        expect(done).toBe(false);
      }
    } catch (e) {
      caught = e;
    }
    reader.releaseLock();
    expectDOMException(caught, 'NetworkError');
    expect(port.readable).toBeNull();
    expect(disconnectEvent?.target).toBe(port);
  });

  it('Disconnect during write is detected.', async () => {
    const {serial, port, device} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 1024});

    let disconnectEvent: Event | undefined;
    serial.addEventListener('disconnect', e => {
      disconnectEvent = e;
    });

    const writer = port.writable!.getWriter();

    // The host keeps writing; the device is "unplugged" a few writes in. (A
    // counter, not a timer: immediately-resolved writes would starve a timer.)
    const data = new Uint8Array(64);
    let caught: unknown;
    try {
      for (let i = 0; i < 1000; ++i) {
        if (i === 3) device.loseDevice();
        await writer.write(data);
      }
    } catch (e) {
      caught = e;
    }
    writer.releaseLock();
    expectDOMException(caught, 'NetworkError');
    expect(port.writable).toBeNull();
    expect(disconnectEvent?.target).toBe(port);
  });
});
