/**
 * Tiny, dependency-free test helpers for driving serial devices — shared by the
 * library's own conformance suite, the {@link SerialClient}, and consumers' app
 * tests. Free of `jest` and `react-native`, so they run under any test runner
 * and on a real device (e.g. an on-device Self-Test screen).
 */

/** Throw `message` if `condition` is falsy. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Throw if `actual !== expected`, including both values in the message. */
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${String(expected)}, got ${String(actual)})`,
    );
  }
}

/** Byte-for-byte equality of two sequences. */
export function bytesEqual(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** What {@link assertRejects} may additionally check about the thrown error. */
export type RejectionExpectation = {
  name?: string;
  type?: new (...args: never[]) => Error;
  message?: string | RegExp;
};

/** Assert `fn()` rejects (optionally matching the error name/type/message). */
export async function assertRejects(
  fn: () => Promise<unknown>,
  message: string,
  expected?: RejectionExpectation,
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
    if (expected?.message !== undefined) {
      const ok =
        expected.message instanceof RegExp
          ? expected.message.test(err.message)
          : err.message.includes(expected.message);
      if (!ok) {
        throw new Error(
          `${message}: expected the error message to match ${String(expected.message)}`,
        );
      }
    }
    return;
  }
  throw new Error(`${message}: expected a rejection but none occurred`);
}

/** Normalise any thrown value into a `"Name: message"` string. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Reject if `promise` doesn't settle within `ms`; `label` names it on timeout. */
export function withTimeout<T>(
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

/** The slice of `ReadableStreamDefaultReader` the helpers need. */
export type ByteReader = {
  read(): Promise<{done: boolean; value?: Uint8Array}>;
};

/** Read exactly `count` bytes from a reader (accumulating chunks), with a timeout. */
export async function readBytes(
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
