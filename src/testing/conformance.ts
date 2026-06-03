/**
 * Runtime-agnostic Web Serial conformance suite.
 *
 * Each test builds a fresh `Serial` wired to a {@link VirtualSerialTransport}
 * and asserts a slice of the W3C Web Serial behaviour. The suite depends on
 * nothing from `jest` (it ships its own tiny assertions), so the *exact same*
 * cases run:
 *
 *   - under Jest — see `src/__tests__/conformance.test.ts`, and
 *   - on a real device / browser — see the example app's Self-Test screen,
 *     via {@link runSerialConformance}.
 *
 * The `WPT …` cases at the end are ports of the official Web Platform Tests
 * (vendored in tmp/serial: serialPort_loopback*, serialPort_readable,
 * serialPort_disconnect, idlharness) — so the spec's own behavioural tests run
 * both under Jest and on-device, not just in a browser.
 *
 * {@link runRealDeviceSmokeTest} runs a small, hardware-safe subset against a
 * *real* connected device (the live `serial`).
 */

import {EventTarget} from '../lib/event-target';
import type {SerialOptions} from '../WebSerial';
import {Serial, SerialPort} from '../WebSerial';
import {EchoDevice, SerialDevice, SilentDevice} from './serial-device';
import type {
  VirtualDeviceOptions,
  VirtualSerialOptions,
} from './virtual-serial';
import {VirtualSerialTransport} from './virtual-serial';

export type ConformanceTest = {
  name: string;
  run(): Promise<void>;
};

export type ConformanceResult = {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
};

// ── Tiny assertion helpers (no test-runner dependency) ───────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${String(expected)}, got ${String(actual)})`,
    );
  }
}

function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function assertRejects(
  fn: () => Promise<unknown>,
  message: string,
  expected?: {name?: string; type?: new (...args: never[]) => Error},
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error;
    if (expected?.name && err.name !== expected.name) {
      throw new Error(
        `${message}: expected error "${expected.name}" but got "${err.name}"`,
      );
    }
    if (expected?.type && !(err instanceof expected.type)) {
      throw new Error(`${message}: expected a ${expected.type.name}`);
    }
    return;
  }
  throw new Error(`${message}: expected a rejection but none occurred`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

type ByteReader = {
  read(): Promise<{done: boolean; value?: Uint8Array}>;
  releaseLock(): void;
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out: ${label}`)),
      ms,
    );
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function readBytes(
  reader: ByteReader,
  count: number,
  timeoutMs = 2000,
): Promise<number[]> {
  const out: number[] = [];
  while (out.length < count) {
    const {done, value} = await withTimeout(
      reader.read(),
      timeoutMs,
      `reading ${count} bytes (got ${out.length})`,
    );
    if (done) break;
    if (value) out.push(...value);
  }
  return out;
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const FTDI = {usbVendorId: 0x0403, usbProductId: 0x6001} as const;

/** One permitted device + a Serial wired to it; the device echoes by default. */
async function onePort(
  device: SerialDevice = new EchoDevice(FTDI),
  options: VirtualDeviceOptions = {},
  transportOptions: VirtualSerialOptions = {},
) {
  const transport = new VirtualSerialTransport(transportOptions);
  const handle = transport.addDevice(device, {hasPermission: true, ...options});
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  assert(port !== undefined, 'fixture failed: expected one port');
  return {transport, serial, device: handle, port};
}

// ── Helpers for the WPT-derived cases (ported from tmp/serial) ────────────────

/** Build an n-byte buffer whose byte i is `fn(i) & 0xff`. */
function makeBytes(n: number, fn: (i: number) => number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i) & 0xff;
  return out;
}

/**
 * The PRNG used by the WPT serialPort_readable test (and its Arduino sketch):
 * an LCG whose stream both sides regenerate to verify large reads byte-exact.
 */
function makePrng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(1103515245, state) + 12345) % (1 << 31);
    return (state >> 16) & 0xff;
  };
}

/** Reads an 8-byte {seed,length} config, then streams `length` PRNG bytes. */
class PrngDevice extends SerialDevice {
  readonly usbVendorId = FTDI.usbVendorId;
  readonly usbProductId = FTDI.usbProductId;
  onData(data: Uint8Array): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const seed = view.getUint32(0, /* littleEndian */ true);
    const length = view.getUint32(4, /* littleEndian */ true);
    const next = makePrng(seed);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = next();
    this.send(out);
  }
}

// ── The suite ────────────────────────────────────────────────────────────────

export const serialConformanceTests: ConformanceTest[] = [
  {
    name: 'getPorts() lists only devices the app has permission for',
    async run() {
      const transport = new VirtualSerialTransport();
      transport.addDevice(new EchoDevice(FTDI), {hasPermission: true});
      transport.addDevice(
        new EchoDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
        {hasPermission: false},
      );
      const serial = new Serial(transport);
      const ports = await serial.getPorts();
      assertEqual(
        ports.length,
        1,
        'only the permitted device should be listed',
      );
      assertEqual(
        ports[0].getInfo().usbVendorId,
        FTDI.usbVendorId,
        'wrong device surfaced',
      );
    },
  },
  {
    name: 'requestPort() grants permission and returns the chosen port',
    async run() {
      const transport = new VirtualSerialTransport();
      const device = transport.addDevice(
        new EchoDevice({usbVendorId: 0x2341, usbProductId: 0x0043}),
      );
      const serial = new Serial(transport);
      assertEqual(
        (await serial.getPorts()).length,
        0,
        'an un-permitted device must be hidden from getPorts()',
      );
      transport.selectNextPort(device);
      const port = await serial.requestPort();
      assertEqual(port.getInfo().usbVendorId, 0x2341, 'wrong device returned');
      assertEqual(
        (await serial.getPorts()).length,
        1,
        'the granted device should now appear in getPorts()',
      );
    },
  },
  {
    name: 'requestPort() rejects with NotFoundError when cancelled',
    async run() {
      const transport = new VirtualSerialTransport();
      transport.addDevice(new EchoDevice(FTDI));
      const serial = new Serial(transport);
      transport.rejectNextPortPicker();
      await assertRejects(() => serial.requestPort(), 'cancelled picker', {
        name: 'NotFoundError',
      });
    },
  },
  {
    name: 'open() rejects invalid connection parameters',
    async run() {
      const {port} = await onePort();
      await assertRejects(() => port.open({baudRate: 0}), 'baudRate 0', {
        type: TypeError,
      });
      await assertRejects(() => port.open({baudRate: -1}), 'baudRate -1', {
        type: TypeError,
      });
      await assertRejects(
        () => port.open({baudRate: Number.NaN}),
        'baudRate NaN',
        {
          type: TypeError,
        },
      );
      await assertRejects(
        () => port.open({baudRate: Number.POSITIVE_INFINITY}),
        'baudRate +Inf',
        {
          type: TypeError,
        },
      );
      await assertRejects(
        () =>
          port.open({baudRate: 9600, dataBits: 5} as unknown as SerialOptions),
        'dataBits 5',
        {type: TypeError},
      );
      await assertRejects(
        () =>
          port.open({baudRate: 9600, stopBits: 3} as unknown as SerialOptions),
        'stopBits 3',
        {type: TypeError},
      );
      await assertRejects(
        () => port.open({baudRate: 9600, bufferSize: -1} as SerialOptions),
        'bufferSize -1',
        {type: TypeError},
      );
      await assertRejects(
        () =>
          port.open({
            baudRate: 9600,
            bufferSize: Number.NaN,
          } as SerialOptions),
        'bufferSize NaN',
        {type: TypeError},
      );
      await assertRejects(
        () =>
          port.open({
            baudRate: 9600,
            bufferSize: Number.POSITIVE_INFINITY,
          } as SerialOptions),
        'bufferSize +Inf',
        {type: TypeError},
      );
      await port.open({baudRate: 9600});
      assert(port.connected, 'a valid open() should still succeed afterwards');
    },
  },
  {
    name: 'open()/close() drive connected and reject double open/close',
    async run() {
      const {port} = await onePort();
      await port.open({baudRate: 115200});
      assert(port.connected, 'connected should be true after open()');
      assert(port.readable !== null, 'readable should exist while open');
      assert(port.writable !== null, 'writable should exist while open');
      await assertRejects(() => port.open({baudRate: 9600}), 'double open()', {
        name: 'InvalidStateError',
      });
      await port.close();
      assert(!port.connected, 'connected should be false after close()');
      assertEqual(port.readable, null, 'readable should be null after close()');
      await assertRejects(() => port.close(), 'double close()', {
        name: 'InvalidStateError',
      });
    },
  },
  {
    name: 'readable receives the bytes the device sends (echo)',
    async run() {
      const {port} = await onePort();
      await port.open({baudRate: 115200});
      const reader = port.readable!.getReader();
      const writer = port.writable!.getWriter();
      const payload = [1, 2, 3, 4, 5];
      await writer.write(Uint8Array.from(payload));
      const got = await readBytes(reader, payload.length);
      assert(bytesEqual(got, payload), `echo mismatch: got [${got}]`);
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    },
  },
  {
    name: 'writable forwards the host bytes to the device',
    async run() {
      const {port, device} = await onePort(new SilentDevice(FTDI));
      await port.open({baudRate: 9600});
      const writer = port.writable!.getWriter();
      await writer.write(Uint8Array.from([0x41, 0x42, 0x43]));
      await writer.write(Uint8Array.from([0x44]));
      writer.releaseLock();
      const written = device.written.flat();
      assert(
        bytesEqual(written, [0x41, 0x42, 0x43, 0x44]),
        `device received [${written}]`,
      );
      await port.close();
    },
  },
  {
    name: 'a scripted responder can answer host writes',
    async run() {
      class ChecksumDevice extends SerialDevice {
        readonly usbVendorId = FTDI.usbVendorId;
        readonly usbProductId = FTDI.usbProductId;
        onData(data: Uint8Array) {
          this.send([Array.from(data).reduce((a, b) => a + b, 0) & 0xff]);
        }
      }
      const {port} = await onePort(new ChecksumDevice());
      await port.open({baudRate: 9600});
      const reader = port.readable!.getReader();
      const writer = port.writable!.getWriter();
      await writer.write(Uint8Array.from([10, 20, 30]));
      const [sum] = await readBytes(reader, 1);
      assertEqual(sum, 60, 'responder should reply with the checksum');
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    },
  },
  {
    name: 'setSignals() is reflected by getSignals() (loopback)',
    async run() {
      const {port} = await onePort();
      await port.open({baudRate: 9600});
      await port.setSignals({dataTerminalReady: true, requestToSend: true});
      const signals = await port.getSignals();
      assert(signals.dataSetReady, 'DSR should follow DTR');
      assert(signals.dataCarrierDetect, 'DCD should follow DTR');
      assert(signals.clearToSend, 'CTS should follow RTS');
      assert(!signals.ringIndicator, 'RI should stay de-asserted');
      await port.close();
    },
  },
  {
    name: 'getSignals()/setSignals() reject before open()',
    async run() {
      const {port} = await onePort();
      await assertRejects(() => port.getSignals(), 'getSignals before open', {
        name: 'InvalidStateError',
      });
      await assertRejects(
        () => port.setSignals({dataTerminalReady: true}),
        'setSignals before open',
        {name: 'InvalidStateError'},
      );
    },
  },
  {
    name: 'a re-attached device reuses its SerialPort and fires "connect"',
    async run() {
      const {transport, serial, device, port} = await onePort();
      let connects = 0;
      port.addEventListener('connect', () => {
        connects++;
      });
      transport.detach(device);
      transport.attach(device); // fresh deviceId, fires "connect"
      assertEqual(
        connects,
        1,
        'the port should receive exactly one "connect" on re-attach',
      );
      const [again] = await serial.getPorts();
      assert(again === port, 'the same SerialPort instance must be reused');
      await again.open({baudRate: 9600});
      assert(
        again.connected,
        'the reused port should open on its new deviceId',
      );
      await again.close();
    },
  },
  {
    name: 'detaching an open device resets the port and fires "disconnect"',
    async run() {
      const {transport, device, port} = await onePort();
      await port.open({baudRate: 9600});
      let disconnects = 0;
      port.addEventListener('disconnect', () => {
        disconnects++;
      });
      transport.detach(device);
      assertEqual(
        disconnects,
        1,
        'the port should receive exactly one "disconnect" on detach',
      );
      assert(!port.connected, 'the port should no longer be connected');
      assertEqual(port.readable, null, 'readable should reset to null');
    },
  },
  {
    name: 'a device read error surfaces on the readable stream',
    async run() {
      const {device, port} = await onePort();
      await port.open({baudRate: 9600});
      const reader = port.readable!.getReader();
      device.emitError('boom');
      await assertRejects(() => reader.read(), 'read() after device error', {
        name: 'NetworkError',
      });
    },
  },
  {
    name: 'forget() invalidates one instance but allows reacquiring a usable port',
    async run() {
      const {serial, port} = await onePort();
      await port.forget();
      await assertRejects(
        () => port.open({baudRate: 9600}),
        'open after forget',
        {
          name: 'InvalidStateError',
        },
      );

      const [reacquired] = await serial.getPorts();
      assert(reacquired !== undefined, 'expected a port after forget()');
      assert(
        reacquired !== port,
        'forget() should not permanently poison the cached port entry',
      );
      await reacquired.open({baudRate: 9600});
      await reacquired.close();
    },
  },

  // ── WPT-derived behavioural + IDL tests (ports of tmp/serial) ───────────────

  {
    name: 'WPT loopback: a series of small writes round-trips byte-exact',
    async run() {
      const {port} = await onePort();
      await port.open({baudRate: 115200, bufferSize: 1024});
      const data = makeBytes(64, i => i);
      const reader = port.readable!.getReader();
      for (let i = 0; i < 10; i++) {
        const writer = port.writable!.getWriter();
        await writer.write(data);
        const writePromise = writer.close();
        const got = await readBytes(reader, data.length);
        await writePromise;
        assert(bytesEqual(got, data), `iteration ${i}: echo mismatch`);
      }
      reader.releaseLock();
      await port.close();
    },
  },
  {
    name: 'WPT loopback: a series of large writes round-trips byte-exact',
    async run() {
      const {port} = await onePort();
      await port.open({baudRate: 115200, bufferSize: 1024});
      const data = makeBytes(10 * 1024, i => i >> 10);
      const reader = port.readable!.getReader();
      for (let i = 0; i < 10; i++) {
        const writer = port.writable!.getWriter();
        await writer.write(data);
        const writePromise = writer.close();
        const got = await readBytes(reader, data.length, 5000);
        await writePromise;
        assert(bytesEqual(got, data), `iteration ${i}: large echo mismatch`);
      }
      reader.releaseLock();
      await port.close();
    },
  },
  {
    name: 'WPT loopback: cancelling the reader discards buffered data',
    async run() {
      const {port} = await onePort();
      await port.open({baudRate: 115200, bufferSize: 64});
      const writer = port.writable!.getWriter();
      // Echoed back but never read — cancelling must drop it, not deliver it.
      await writer.write(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
      await Promise.resolve();
      await port.readable!.cancel();

      const expected = [9, 10, 11, 12, 13, 14, 15, 16];
      const reader = port.readable!.getReader();
      const readPromise = readBytes(reader, expected.length);
      await writer.write(Uint8Array.from(expected));
      writer.releaseLock();
      const got = await readPromise;
      reader.releaseLock();
      assert(
        bytesEqual(got, expected),
        `cancel should discard the buffer; got [${got}]`,
      );
      await port.close();
    },
  },
  {
    name: 'WPT flow control: hardware back-pressure de-asserts CTS',
    async run() {
      // The device de-asserts CTS once its receive buffer fills; a small
      // threshold keeps the test fast and deterministic.
      const {port} = await onePort(new EchoDevice(FTDI), {
        flowControlThreshold: 16,
      });
      await port.open({
        baudRate: 115200,
        bufferSize: 255,
        flowControl: 'hardware',
      });
      const writer = port.writable!.getWriter();
      assert(
        (await port.getSignals()).clearToSend,
        'CTS should start asserted',
      );
      const buffer = new Uint8Array(1);
      let writes = 0;
      while ((await port.getSignals()).clearToSend) {
        await writer.write(buffer);
        if (++writes > 10000) throw new Error('CTS never dropped');
      }
      assert(writes > 0, 'should write at least once before CTS drops');
      writer.releaseLock();
      await port.close();
    },
  },
  {
    name: 'WPT: a break condition surfaces as BreakError on the readable',
    async run() {
      const {port, device} = await onePort();
      await port.open({baudRate: 115200, bufferSize: 1024});
      const reader = port.readable!.getReader();
      const readPromise = (async () => {
        const first = await reader.read();
        assert(!first.done, 'stream should not be done');
        assert(
          !!first.value && bytesEqual(first.value, [0]),
          'expected a leading zero byte before the break',
        );
        await reader.read(); // should reject with BreakError
      })();
      await port.setSignals({break: true});
      device.push([0]);
      device.emitError('Break received', 'BreakError');
      await assertRejects(() => readPromise, 'break condition', {
        name: 'BreakError',
      });
    },
  },
  {
    name: 'WPT: a receive-buffer overrun surfaces as BufferOverrunError',
    async run() {
      const {port, device} = await onePort();
      device.overrunAfter(1024);
      await port.open({baudRate: 115200, bufferSize: 1024});
      const data = makeBytes(16 * 1024, i => i >> 10);
      const reader = port.readable!.getReader();
      const writer = port.writable!.getWriter();
      const writePromise = writer.write(data);

      let actualLength = 0;
      let caught: unknown;
      try {
        while (true) {
          const {value, done} = await withTimeout(
            reader.read(),
            2000,
            'overrun read',
          );
          if (value) actualLength += value.byteLength;
          if (done) throw new Error('stream ended without overrun');
        }
      } catch (e) {
        caught = e;
      }
      reader.releaseLock();
      writer.releaseLock();
      await writePromise.catch(() => {});
      assert(actualLength > 0, 'partial data should arrive before the overrun');
      assertEqual(
        (caught as Error)?.name,
        'BufferOverrunError',
        'overrun should surface as BufferOverrunError',
      );
    },
  },
  {
    name: 'WPT readable: a large PRNG stream arrives intact (chunked)',
    async run() {
      const seed = 10;
      // Scaled down from the WPT 10 MB so the on-device Self-Test stays fast,
      // while still exercising chunked reads + byte-exact integrity at scale.
      const length = 256 * 1024;
      const {port} = await onePort(new PrngDevice(), {}, {chunkSize: 1024});
      await port.open({baudRate: 115200, bufferSize: 1024});

      const config = new DataView(new ArrayBuffer(8));
      config.setUint32(0, seed, /* littleEndian */ true);
      config.setUint32(4, length, /* littleEndian */ true);
      const writer = port.writable!.getWriter();
      const writePromise = writer.write(new Uint8Array(config.buffer));

      const reader = port.readable!.getReader();
      const next = makePrng(seed);
      let bytesRead = 0;
      while (bytesRead < length) {
        const {value, done} = await withTimeout(
          reader.read(),
          5000,
          'prng read',
        );
        assert(!done, 'stream ended before the full length');
        const chunk = value!;
        for (let i = 0; i < chunk.byteLength; i++) {
          const expected = next();
          if (chunk[i] !== expected) {
            throw new Error(
              `mismatch at byte ${bytesRead + i}: ${chunk[i]} !== ${expected}`,
            );
          }
        }
        bytesRead += chunk.byteLength;
      }
      assertEqual(bytesRead, length, 'should read the full PRNG stream');
      await writePromise;
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    },
  },
  {
    name: 'WPT disconnect: a pending read rejects with NetworkError and fires disconnect on the port',
    async run() {
      const {serial, port, device} = await onePort();
      await port.open({baudRate: 115200, bufferSize: 1024});
      let disconnectTarget: unknown;
      serial.addEventListener('disconnect', e => {
        disconnectTarget = (e as {target?: unknown}).target;
      });
      const reader = port.readable!.getReader();
      // Lose the device while a read is pending (next microtask).
      void Promise.resolve().then(() => device.loseDevice());
      let caught: unknown;
      try {
        for (let i = 0; i < 100000; i++) {
          const {done} = await reader.read();
          assert(!done, 'read should reject, not complete');
        }
      } catch (e) {
        caught = e;
      }
      reader.releaseLock();
      assertEqual(
        (caught as Error)?.name,
        'NetworkError',
        'a pending read should reject with NetworkError on disconnect',
      );
      assertEqual(port.readable, null, 'readable should be cleared');
      assert(disconnectTarget === port, 'disconnect target should be the port');
    },
  },
  {
    name: 'WPT disconnect: a pending write rejects with NetworkError',
    async run() {
      const {serial, port, device} = await onePort();
      await port.open({baudRate: 115200, bufferSize: 1024});
      let disconnectTarget: unknown;
      serial.addEventListener('disconnect', e => {
        disconnectTarget = (e as {target?: unknown}).target;
      });
      const writer = port.writable!.getWriter();
      const data = new Uint8Array(64);
      let caught: unknown;
      try {
        for (let i = 0; i < 1000; i++) {
          if (i === 3) device.loseDevice();
          await writer.write(data);
        }
      } catch (e) {
        caught = e;
      }
      writer.releaseLock();
      assertEqual(
        (caught as Error)?.name,
        'NetworkError',
        'a pending write should reject with NetworkError on disconnect',
      );
      assertEqual(port.writable, null, 'writable should be cleared');
      assert(disconnectTarget === port, 'disconnect target should be the port');
    },
  },
  {
    name: 'WPT IDL: Serial and SerialPort expose the spec interface',
    async run() {
      const serial = new Serial();
      assert(serial instanceof EventTarget, 'Serial should be an EventTarget');
      for (const method of [
        'getPorts',
        'requestPort',
        'addEventListener',
        'removeEventListener',
      ]) {
        assertEqual(
          typeof (serial as unknown as Record<string, unknown>)[method],
          'function',
          `Serial.${method} should be a function`,
        );
      }
      assert(
        'onconnect' in serial && 'ondisconnect' in serial,
        'Serial should expose onconnect/ondisconnect',
      );

      const {port} = await onePort();
      assert(port instanceof SerialPort, 'port should be a SerialPort');
      assert(
        port instanceof EventTarget,
        'SerialPort should be an EventTarget',
      );
      for (const method of [
        'open',
        'close',
        'forget',
        'getInfo',
        'getSignals',
        'setSignals',
      ]) {
        assertEqual(
          typeof (port as unknown as Record<string, unknown>)[method],
          'function',
          `SerialPort.${method} should be a function`,
        );
      }
      for (const attr of [
        'connected',
        'readable',
        'writable',
        'onconnect',
        'ondisconnect',
      ]) {
        assert(attr in port, `SerialPort should expose ${attr}`);
      }
      assertEqual(
        typeof port.connected,
        'boolean',
        'connected should be boolean',
      );
      assertEqual(port.readable, null, 'readable should be null before open()');
      assertEqual(port.writable, null, 'writable should be null before open()');

      const info = port.getInfo();
      assertEqual(typeof info.usbVendorId, 'number', 'getInfo().usbVendorId');
      assertEqual(typeof info.usbProductId, 'number', 'getInfo().usbProductId');

      await port.open({baudRate: 9600});
      const signals = await port.getSignals();
      for (const key of [
        'dataCarrierDetect',
        'clearToSend',
        'ringIndicator',
        'dataSetReady',
      ] as const) {
        assertEqual(
          typeof signals[key],
          'boolean',
          `getSignals().${key} should be a boolean`,
        );
      }
      await port.close();
    },
  },
];

/**
 * Run the full virtual conformance suite, collecting a result per test. Never
 * throws — intended for the on-device Self-Test screen.
 */
export async function runSerialConformance(): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const test of serialConformanceTests) {
    const start = Date.now();
    try {
      await test.run();
      results.push({
        name: test.name,
        passed: true,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      results.push({
        name: test.name,
        passed: false,
        error: errorMessage(e),
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

/**
 * A small, hardware-safe smoke test against a *real* connected device. Pass the
 * live platform `serial`. If no device/permission is present it reports that
 * rather than failing hard.
 */
export async function runRealDeviceSmokeTest(
  serial: Serial,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const record = async (name: string, fn: () => Promise<void>) => {
    const start = Date.now();
    try {
      await fn();
      results.push({name, passed: true, durationMs: Date.now() - start});
    } catch (e) {
      results.push({
        name,
        passed: false,
        error: errorMessage(e),
        durationMs: Date.now() - start,
      });
    }
  };

  const ports = await serial.getPorts();
  results.push({
    name: 'getPorts() returns a list',
    passed: Array.isArray(ports),
    durationMs: 0,
  });

  if (ports.length === 0) {
    results.push({
      name: 'a device is connected and permitted',
      passed: false,
      error: 'No ports. Connect a device, grant USB permission, then retry.',
      durationMs: 0,
    });
    return results;
  }

  const port = ports[0];
  await record('getInfo() exposes USB identifiers', async () => {
    const info = port.getInfo();
    assert(info.usbVendorId !== undefined, 'getInfo() returned no usbVendorId');
  });
  await record('open() then close() round-trips', async () => {
    await port.open({baudRate: 9600});
    assert(port.connected, 'connected should be true after open()');
    await port.close();
    assert(!port.connected, 'connected should be false after close()');
  });

  return results;
}
