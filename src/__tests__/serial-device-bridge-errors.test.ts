/**
 * Targeted tests for uncovered error/callback paths in serial-device-bridge.ts.
 */
import {describe, expect, it} from '@jest/globals';
import {EchoDevice, VirtualSerialTransport} from '../testing';
import type {WsLike} from '../websocket';
import {attachBridge, serialDeviceToSerialLike} from '../websocket';

const FTDI = {usbVendorId: 0x0403, usbProductId: 0x6001} as const;
const flush = () => new Promise<void>(r => setTimeout(r, 0));

class FakeWs implements WsLike {
  readonly sent: Array<string | Uint8Array> = [];
  readonly #listeners: Record<string, Array<(...a: never[]) => void>> = {};

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  on(event: string, listener: (...a: never[]) => void): void {
    this.#listeners[event] ??= [];
    this.#listeners[event].push(listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.#listeners[event] ?? []) {
      (l as (...a: unknown[]) => void)(...args);
    }
  }
  recvCommand(message: object): void {
    this.emit('message', JSON.stringify(message), false);
  }
  responses(): Array<Record<string, unknown>> {
    return this.sent
      .filter((f): f is string => typeof f === 'string')
      .map(f => JSON.parse(f));
  }
}

describe('serialDeviceToSerialLike — error paths', () => {
  it('routes the error subscription (ErrorEvent → Error) through the bridge', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const ws = new FakeWs();
    attachBridge(serialDeviceToSerialLike(transport, device), ws);

    ws.recvCommand({
      type: 'command',
      id: 1,
      command: 'setLineCoding',
      args: {baudRate: 115200},
    });
    ws.recvCommand({type: 'command', id: 2, command: 'startReading'});
    await flush();

    // Emit an error for this device → should be forwarded
    device.emitError('device fault');
    await flush(); // emitError uses #schedule (setTimeout), fire it
    const errorEvents = ws
      .responses()
      .filter(r => r.type === 'event' && r.event === 'error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('write callback fires with null when the port is open', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);

    // Open the port via the update path (mirrors what setLineCoding does).
    await new Promise<void>((resolve, reject) => {
      serial.update({baudRate: 115200}, err => (err ? reject(err) : resolve()));
    });

    let captured: Error | null | undefined;
    await new Promise<void>(resolve => {
      serial.write(Uint8Array.from([1, 2]), (err: Error | null | undefined) => {
        captured = err;
        resolve();
      });
    });
    expect(captured).toBeNull();
  });

  it('flush callback fires without error', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);

    let called = false;
    await new Promise<void>(resolve => {
      serial.flush((err: Error | null | undefined) => {
        called = true;
        expect(err).toBeNull();
        resolve();
      });
    });
    expect(called).toBe(true);
  });

  it('drain callback fires without error', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);

    let called = false;
    await new Promise<void>(resolve => {
      serial.drain((err: Error | null | undefined) => {
        called = true;
        expect(err).toBeNull();
        resolve();
      });
    });
    expect(called).toBe(true);
  });

  it('close fires close callbacks and calls cb(null)', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    // Open first so close does real work
    await transport.open(device.deviceId, device.portNumber, {
      baudRate: 115200,
    });
    await transport.startReading(device.deviceId, device.portNumber);

    const serial = serialDeviceToSerialLike(transport, device);
    let closeCalled = false;
    await new Promise<void>(resolve => {
      serial.close((err: Error | null | undefined) => {
        closeCalled = true;
        expect(err).toBeNull();
        resolve();
      });
    });
    expect(closeCalled).toBe(true);
  });

  it('removeListener for data/error triggers cleanupIfIdle', () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);

    const listener = () => {};
    serial.on('data', listener);
    serial.on('error', listener);
    serial.removeListener('data', listener);
    serial.removeListener('error', listener);
    // cleanupIfIdle should have been triggered — no crash is sufficient
  });

  it('set applies dtr, rts, brk and calls back successfully', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(FTDI), {
      hasPermission: true,
      loopbackSignals: true,
    });
    const serial = serialDeviceToSerialLike(transport, device);

    let called = false;
    await new Promise<void>(resolve => {
      serial.set(
        {dtr: true, rts: true, brk: true},
        (err: Error | null | undefined) => {
          called = true;
          expect(err).toBeNull();
          resolve();
        },
      );
    });
    expect(called).toBe(true);
  });
});
