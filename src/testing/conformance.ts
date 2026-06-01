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
 * {@link runRealDeviceSmokeTest} runs a small, hardware-safe subset against a
 * *real* connected device (the live `serial`).
 */

import type {SerialOptions} from '../WebSerial';
import {Serial} from '../WebSerial';
import type {VirtualDeviceInit} from './virtual-serial';
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
async function onePort(init: Partial<VirtualDeviceInit> = {}) {
  const transport = new VirtualSerialTransport();
  const device = transport.addDevice({
    ...FTDI,
    hasPermission: true,
    ...init,
  });
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  assert(port !== undefined, 'fixture failed: expected one port');
  return {transport, serial, device, port};
}

// ── The suite ────────────────────────────────────────────────────────────────

export const serialConformanceTests: ConformanceTest[] = [
  {
    name: 'getPorts() lists only devices the app has permission for',
    async run() {
      const transport = new VirtualSerialTransport();
      transport.addDevice({...FTDI, hasPermission: true});
      transport.addDevice({
        usbVendorId: 0x10c4,
        usbProductId: 0xea60,
        hasPermission: false,
      });
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
      const device = transport.addDevice({
        usbVendorId: 0x2341,
        usbProductId: 0x0043,
      });
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
      transport.addDevice({...FTDI});
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
      const {port, device} = await onePort({behavior: 'silent'});
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
      const {port} = await onePort({
        behavior: data => [Array.from(data).reduce((a, b) => a + b, 0) & 0xff],
      });
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
      assert(connects >= 1, 'the port should receive a "connect" on re-attach');
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
      assert(disconnects >= 1, 'the port should receive a "disconnect"');
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
    name: 'forget() makes the port un-openable',
    async run() {
      const {port} = await onePort();
      await port.forget();
      await assertRejects(
        () => port.open({baudRate: 9600}),
        'open after forget',
        {
          name: 'InvalidStateError',
        },
      );
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
