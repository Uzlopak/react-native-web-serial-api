/**
 * Tests for the shipped suite runner: `runSerialTests` (shared vs per-test
 * client, progress hooks, connect-failure handling) and `compareResults`.
 */
import {describe, expect, it} from '@jest/globals';
import {
  compareResults,
  EchoDevice,
  LineDevice,
  mountSerialDevice,
  runSerialTests,
  type SerialTest,
  SerialTestHarness,
  type SerialTestResult,
} from '../testing';

/** Answers PING→PONG so a test can do a real request/response round-trip. */
class PingDevice extends LineDevice {
  readonly usbVendorId = 0x0403;
  readonly usbProductId = 0x6001;
  onLine(line: string): void {
    this.send(line === 'PING' ? 'PONG\r\n' : `ERR\r\n`);
  }
}

describe('runSerialTests', () => {
  const tests: SerialTest[] = [
    {
      name: 'ping round-trips',
      async run(c: SerialTestHarness) {
        await c.write('PING\n');
        if ((await c.readLine()) !== 'PONG') throw new Error('no pong');
      },
    },
    {
      name: 'deliberately fails',
      async run() {
        throw new Error('boom');
      },
    },
  ];

  it('runs every case and reports pass/fail without throwing', async () => {
    const {port} = await mountSerialDevice(new PingDevice());
    const results = await runSerialTests(tests, port);
    expect(results.map(r => [r.name, r.passed])).toEqual([
      ['ping round-trips', true],
      ['deliberately fails', false],
    ]);
    expect(results[1].error).toContain('boom');
  });

  it('streams progress and shares one open client by default', async () => {
    const {port} = await mountSerialDevice(new PingDevice());
    const started: string[] = [];
    const finished: SerialTestResult[] = [];
    await runSerialTests(tests, port, {
      progress: {
        onStart: name => started.push(name),
        onResult: r => finished.push(r),
      },
    });
    expect(started).toEqual(['ping round-trips', 'deliberately fails']);
    expect(finished).toHaveLength(2);
    // The shared client closed the port at the end, so it can be reopened.
    await port.open({baudRate: 9600});
    expect(port.connected).toBe(true);
    await port.close();
  });

  it('opens and closes a fresh client per test when shared is false', async () => {
    const {port} = await mountSerialDevice(new EchoDevice());
    let opens = 0;
    const counting: SerialTest[] = [
      {
        name: 'a',
        async run(c) {
          opens++;
          await c.write([1]);
          expect(Array.from(await c.readBytes(1))).toEqual([1]);
        },
      },
      {
        name: 'b',
        async run(c) {
          opens++;
          await c.write([2]);
          expect(Array.from(await c.readBytes(1))).toEqual([2]);
        },
      },
    ];
    const results = await runSerialTests(counting, port, {shared: false});
    expect(results.every(r => r.passed)).toBe(true);
    expect(opens).toBe(2);
    // Each test closed its own client, leaving the port closed and reopenable.
    await port.open({baudRate: 9600});
    await port.close();
  });

  it('reports a single failure when the client cannot connect', async () => {
    const {port} = await mountSerialDevice(new EchoDevice());
    const results = await runSerialTests(tests, port, {
      client: {
        connect: async () => {
          throw new Error('cannot open');
        },
        disconnect: async () => {},
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('open serial port');
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('cannot open');
  });

  it('drives a custom protocol client built on the SerialTestHarness', async () => {
    const {port} = await mountSerialDevice(new PingDevice());
    // A trivial "protocol client" that wraps a SerialTestHarness.
    type Pinger = {ping(): Promise<string>; close(): Promise<void>};
    const pingerTests: SerialTest<Pinger>[] = [
      {
        name: 'protocol ping',
        async run(p) {
          if ((await p.ping()) !== 'PONG') throw new Error('bad pong');
        },
      },
    ];
    const results = await runSerialTests(pingerTests, port, {
      client: {
        async connect(p) {
          const inner = new SerialTestHarness(p);
          await inner.open();
          return {
            async ping() {
              await inner.write('PING\n');
              return inner.readLine();
            },
            close: () => inner.close(),
          };
        },
        disconnect: pinger => pinger.close(),
      },
    });
    expect(results[0].passed).toBe(true);
  });
});

describe('compareResults', () => {
  const ref: SerialTestResult[] = [
    {name: 'a', passed: true, durationMs: 1},
    {name: 'b', passed: false, durationMs: 1},
    {name: 'c', passed: true, durationMs: 1},
  ];

  it('passes a row only when both runs agree', () => {
    const candidate: SerialTestResult[] = [
      {name: 'a', passed: true, durationMs: 1}, // agree (both pass)
      {name: 'b', passed: false, durationMs: 1}, // agree (both fail)
      {name: 'c', passed: false, durationMs: 1, error: 'oops'}, // disagree
    ];
    const rows = compareResults(ref, candidate);
    const byName = new Map(rows.map(r => [r.name, r]));
    expect(byName.get('a')?.passed).toBe(true);
    expect(byName.get('b')?.passed).toBe(true);
    expect(byName.get('c')?.passed).toBe(false);
    expect(byName.get('c')?.error).toContain(
      'reference passed, candidate failed',
    );
  });

  it('fails a reference row the candidate never ran', () => {
    const rows = compareResults(ref, [
      {name: 'a', passed: true, durationMs: 1},
    ]);
    const byName = new Map(rows.map(r => [r.name, r]));
    expect(byName.get('b')?.passed).toBe(false);
    expect(byName.get('b')?.error).toContain('did not respond');
  });

  it('surfaces candidate-only cases as failures', () => {
    const rows = compareResults(ref, [
      {name: 'a', passed: true, durationMs: 1},
      {name: 'extra', passed: true, durationMs: 1},
    ]);
    const extra = rows.find(r => r.name === 'candidate: extra');
    expect(extra).toBeDefined();
    expect(extra?.passed).toBe(false);
  });
});
