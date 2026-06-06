/**
 * A runtime-agnostic suite runner for serial device tests. Write a set of
 * `SerialTest`s once and run them anywhere a {@link SerialPort} exists:
 *
 *   - in Jest against a {@link VirtualSerialDevice} simulator (in-memory),
 *   - on a device / emulator over a real or WebSocket-backed port, and
 *   - against BOTH, then {@link compareResults} to prove the device matches
 *     the simulator case-for-case.
 *
 * Each test receives an opened, host-side {@link SerialClient}; by default one
 * client is shared across the whole suite (open once, close at the end), which
 * matches how a request/response protocol session behaves. Pass `shared: false`
 * to open and close a fresh client per test. The runner never throws — it
 * collects a {@link SerialTestResult} per case — so it is safe to drive an
 * on-device Self-Test screen.
 *
 * @example One suite, two transports, compared
 * const sim = await runSerialTests(myTests, await virtualPort());
 * const dev = await runSerialTests(myTests, realPort);
 * const rows = compareResults(sim, dev); // a row passes when both agree
 */

import type {SerialOptions, SerialPort} from '../WebSerial';
import {errorMessage} from './harness';
import {SerialClient} from './serial-client';

export type SerialTestResult = {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
};

/** One test case. `run` receives an already-opened client (typically per the
 * suite's {@link SerialTestClient}; `SerialClient` by default). */
export type SerialTest<C = SerialClient> = {
  name: string;
  run(client: C): Promise<void>;
};

/** Progress hooks so a UI can render results live as each test completes. */
export type SerialTestProgress = {
  /** Called just before a test starts running. */
  onStart?: (name: string, index: number, total: number) => void;
  /** Called after each test completes (pass or fail). */
  onResult?: (result: SerialTestResult) => void;
};

/**
 * How to build (and tear down) the per-suite client from a port. Provide this to
 * run a higher-level protocol client (e.g. an HCI / NMEA framer built on a
 * {@link SerialClient}) instead of the raw client. `connect` must also open the
 * port; `disconnect` must release it (a `SerialClient.close()` does both).
 */
export type SerialTestClient<C> = {
  connect(port: SerialPort): Promise<C>;
  disconnect(client: C): Promise<void>;
};

export type RunSerialTestsOptions<C = SerialClient> = {
  /** `SerialOptions` for the default client's `open()`. Default {baudRate: 115200}. */
  open?: SerialOptions;
  /** Open/close a fresh client per test instead of sharing one. Default false. */
  shared?: boolean;
  /** Build a protocol client over the port (defaults to an opened SerialClient). */
  client?: SerialTestClient<C>;
  progress?: SerialTestProgress;
};

function defaultClientFactory(
  open?: SerialOptions,
): SerialTestClient<SerialClient> {
  return {
    async connect(port) {
      const client = new SerialClient(port);
      await client.open(open);
      return client;
    },
    disconnect: client => client.close(),
  };
}

/**
 * Run `tests` against an already-acquired `port`, collecting one result per
 * case. With the default (shared) client the port is opened once and closed at
 * the end; with `shared: false` each test gets a fresh open/close. Never throws.
 */
export async function runSerialTests<C = SerialClient>(
  tests: SerialTest<C>[],
  port: SerialPort,
  options: RunSerialTestsOptions<C> = {},
): Promise<SerialTestResult[]> {
  const factory = (options.client ??
    defaultClientFactory(options.open)) as SerialTestClient<C>;
  const shared = options.shared ?? true;
  const progress = options.progress;
  const results: SerialTestResult[] = [];

  let sharedClient: C | null = null;
  if (shared) {
    try {
      sharedClient = await factory.connect(port);
    } catch (e) {
      const result: SerialTestResult = {
        name: 'open serial port',
        passed: false,
        error: errorMessage(e),
        durationMs: 0,
      };
      progress?.onResult?.(result);
      return [result];
    }
  }

  const total = tests.length;
  try {
    for (let i = 0; i < total; i++) {
      const test = tests[i];
      progress?.onStart?.(test.name, i, total);
      const start = Date.now();
      let perTest: C | null = null;
      let result: SerialTestResult;
      try {
        if (!shared) perTest = await factory.connect(port);
        const client = shared ? (sharedClient as C) : (perTest as C);
        await test.run(client);
        result = {
          name: test.name,
          passed: true,
          durationMs: Date.now() - start,
        };
      } catch (e) {
        result = {
          name: test.name,
          passed: false,
          error: errorMessage(e),
          durationMs: Date.now() - start,
        };
      } finally {
        if (perTest) await factory.disconnect(perTest).catch(() => {});
      }
      results.push(result);
      progress?.onResult?.(result);
    }
  } finally {
    if (sharedClient) await factory.disconnect(sharedClient).catch(() => {});
  }
  return results;
}

/**
 * Compare two runs of the same suite case-by-case. A row passes when both runs
 * agree (both passed or both failed), so the `candidate` is judged equivalent to
 * the `reference` rather than judged on its own. Cases the candidate produced
 * that the reference never ran are surfaced as failing `candidate: …` rows.
 */
export function compareResults(
  reference: SerialTestResult[],
  candidate: SerialTestResult[],
): SerialTestResult[] {
  const candidateByName = new Map(candidate.map(r => [r.name, r]));

  const candidateOnly = candidate
    .filter(r => !reference.some(s => s.name === r.name))
    .map(r => ({
      name: `candidate: ${r.name}`,
      passed: false,
      error: r.error ?? 'candidate produced an unexpected result',
      durationMs: r.durationMs,
    }));

  const compared = reference.map(s => {
    const r = candidateByName.get(s.name);
    const identical = !!r && r.passed === s.passed;
    return {
      name: s.name,
      passed: identical,
      error: identical
        ? undefined
        : `reference ${s.passed ? 'passed' : 'failed'}, candidate ${
            r ? (r.passed ? 'passed' : 'failed') : 'did not respond'
          }${r?.error ? `: ${r.error}` : ''}`,
      durationMs: r?.durationMs ?? 0,
    };
  });

  return [...candidateOnly, ...compared];
}
