/**
 * Ported from WPT tmp/serial/serialPort_loopback_flowControl-manual.https.html.
 *
 * The original needs a loopback device with RTS↔CTS (and TX↔RX) wired. The
 * VirtualSerialTransport models both: RTS→CTS via signal loopback, and a
 * receive-buffer "CTS drops when full" model under hardware flow control.
 */
import {describe, expect, it} from '@jest/globals';
import {EchoDevice} from '../../testing/serial-device';
import {loopbackHarness} from './wpt-helpers';

describe('WPT: serialPort_loopback flow control', () => {
  it('Manual RTS control works with no flow control enabled', async () => {
    const {port} = await loopbackHarness();
    await port.open({baudRate: 115200, bufferSize: 255, flowControl: 'none'});

    await port.setSignals({requestToSend: true});
    let signals = await port.getSignals();
    expect(signals.clearToSend).toBe(true);

    await port.setSignals({requestToSend: false});
    signals = await port.getSignals();
    expect(signals.clearToSend).toBe(false);

    await port.close();
  });

  it('Hardware flow control automatically sets RTS pin', async () => {
    // The device de-asserts CTS once its receive buffer fills; a small threshold
    // keeps the test fast and deterministic.
    const {port} = await loopbackHarness(new EchoDevice(), {
      flowControlThreshold: 16,
    });
    await port.open({
      baudRate: 115200,
      bufferSize: 255,
      flowControl: 'hardware',
    });

    const writer = port.writable!.getWriter();
    expect((await port.getSignals()).clearToSend).toBe(true);

    const buffer = new Uint8Array(1);
    let writes = 0;
    while ((await port.getSignals()).clearToSend) {
      await writer.write(buffer);
      if (++writes > 10000) throw new Error('CTS never dropped');
    }
    expect(writes).toBeGreaterThan(0);

    writer.releaseLock();
    await port.close();
  });
});
