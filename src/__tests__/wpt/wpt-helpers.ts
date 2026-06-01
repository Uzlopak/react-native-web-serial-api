/**
 * Helpers for the WPT-derived spec-compliance tests.
 *
 * `compareArrays` and `readWithLength` are ports of the official Web Platform
 * Tests utilities in tmp/serial/resources/common.js, re-expressed with Jest's
 * `expect`. `loopbackHarness` stands in for the WPT "loopback device + manual
 * device picker": it builds a `Serial` backed by a VirtualSerialTransport echo
 * device, so the same test logic runs with no browser and no hardware.
 */
import {expect} from '@jest/globals';
import {EchoDevice, type SerialDevice} from '../../testing/serial-device';
import type {
  VirtualDevice,
  VirtualDeviceOptions,
  VirtualSerialOptions,
} from '../../testing/virtual-serial';
import {VirtualSerialTransport} from '../../testing/virtual-serial';
import {Serial} from '../../WebSerial';

/** Byte-by-byte comparison of two Uint8Arrays (port of WPT compareArrays). */
export function compareArrays(actual: unknown, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  const a = actual as Uint8Array;
  expect(a.byteLength).toBe(expected.byteLength);
  // Manual loop (not 64k expect() calls) for speed on large buffers.
  for (let i = 0; i < expected.byteLength; ++i) {
    if (a[i] !== expected[i]) {
      throw new Error(`Mismatch at position ${i}: ${a[i]} !== ${expected[i]}`);
    }
  }
}

export type ByteReader = {
  read(): Promise<{done: boolean; value?: Uint8Array}>;
  releaseLock(): void;
  cancel(reason?: unknown): Promise<void>;
};

/**
 * Read from `reader` until at least `targetLength` bytes are read or the stream
 * closes; returns the combined Uint8Array (port of WPT readWithLength).
 */
export async function readWithLength(
  reader: ByteReader,
  targetLength: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let actualLength = 0;

  while (true) {
    const {value, done} = await reader.read();
    if (value) {
      chunks.push(value);
      actualLength += value.byteLength;
    }
    if (actualLength >= targetLength || done) {
      const buffer = new Uint8Array(actualLength);
      chunks.reduce((offset, chunk) => {
        buffer.set(chunk, offset);
        return offset + chunk.byteLength;
      }, 0);
      return buffer;
    }
  }
}

/** Assert that `err` is a DOMException with the given `name`. */
export function expectDOMException(err: unknown, name: string): void {
  const e = err as {name?: string; constructor?: {name?: string}};
  expect(e?.constructor?.name).toBe('DOMException');
  expect(e?.name).toBe(name);
}

export type Harness = {
  serial: Serial;
  transport: VirtualSerialTransport;
  device: VirtualDevice;
  port: import('../../WebSerial').SerialPort;
};

/**
 * Build a Serial backed by a single permitted device (an FTDI {@link EchoDevice}
 * "loopback" by default) and return its already-resolved SerialPort — the WPT
 * manual-test fixture, minus the browser and the hardware.
 */
export async function loopbackHarness(
  device: SerialDevice = new EchoDevice({
    usbVendorId: 0x0403,
    usbProductId: 0x6001,
  }),
  options: VirtualDeviceOptions = {},
  transportOptions: VirtualSerialOptions = {},
): Promise<Harness> {
  const transport = new VirtualSerialTransport(transportOptions);
  const handle = transport.addDevice(device, {hasPermission: true, ...options});
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) throw new Error('loopbackHarness: expected one port');
  return {serial, transport, device: handle, port};
}
