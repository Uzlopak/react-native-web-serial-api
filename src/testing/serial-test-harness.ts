/**
 * A fluent request/response harness over a {@link SerialPort} — the host-side
 * driver every serial test otherwise hand-rolls (reader + writer, a pending
 * byte buffer, framed reads with timeouts). Works on ANY SerialPort: the
 * in-memory {@link VirtualSerialTransport}, a real USB device, or a
 * WebSocket-backed one — so the same test runs in Jest and on a device.
 *
 * @example
 * const {client} = await mountSerialDevice(new MyDevice());
 * await client.open({baudRate: 115200});
 * await client.write('PING\n');
 * expect(await client.readLine()).toBe('PONG');
 * await client.close();
 */
import type {SerialOptions, SerialPort} from '../WebSerial';
import {toBytes} from './serial-device';

export type ReadOptions = {
  /** Per-call timeout in ms (overrides the client default). */
  timeout?: number;
};

export type SerialTestHarnessOptions = {
  /** Default per-read timeout in ms. Default 2000. */
  defaultTimeoutMs?: number;
};

function indexOfSubsequence(haystack: number[], needle: number[]): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export class SerialTestHarness {
  readonly #port: SerialPort;
  readonly #defaultTimeout: number;

  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #open = false;
  #done = false;
  #closed = false;
  /** Inbound bytes read by the pump but not yet consumed. */
  readonly #pending: number[] = [];
  /** Resolvers woken whenever #pending grows or the stream ends. */
  #waiters: Array<() => void> = [];

  constructor(port: SerialPort, options: SerialTestHarnessOptions = {}) {
    this.#port = port;
    this.#defaultTimeout = options.defaultTimeoutMs ?? 2000;
  }

  get port(): SerialPort {
    return this.#port;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  /** True once the underlying stream has ended (device closed or lost). */
  get ended(): boolean {
    return this.#done;
  }

  /** Open the port (idempotent) and acquire reader + writer; start reading. */
  async open(options: SerialOptions = {baudRate: 115200}): Promise<this> {
    if (this.#open) return this;
    await this.#port.open(options);
    this.#reader = this.#port.readable!.getReader();
    this.#writer = this.#port.writable!.getWriter();
    this.#open = true;
    this.#done = false;
    this.#closed = false;
    void this.#pump();
    return this;
  }

  /** Background reader: drains the stream into #pending and wakes waiters. */
  async #pump(): Promise<void> {
    const reader = this.#reader;
    if (!reader) return;
    try {
      while (!this.#closed) {
        const {done, value} = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          for (let i = 0; i < value.length; i++) this.#pending.push(value[i]);
          this.#wake();
        }
      }
    } catch {
      // read errored (e.g. device lost) — surface as end-of-stream to waiters
    } finally {
      this.#done = true;
      this.#wake();
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /** Resolve on the next #pending change / stream end, or reject after `ms`. */
  #waitForChange(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(w => w !== waiter);
        reject(new Error('read timeout'));
      }, ms);
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#waiters.push(waiter);
    });
  }

  /**
   * Block until `ready(buffer)` returns a non-negative count of bytes to
   * consume, then splice and return them. Rejects with `label` on timeout.
   */
  async #consume(
    ready: (buffer: number[]) => number | false,
    timeoutMs: number,
    label: () => string,
  ): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const take = ready(this.#pending);
      if (take !== false) {
        return Uint8Array.from(this.#pending.splice(0, take));
      }
      if (this.#done) {
        // Return whatever is buffered rather than hang on a closed stream.
        return Uint8Array.from(this.#pending.splice(0, this.#pending.length));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(label());
      try {
        await this.#waitForChange(remaining);
      } catch {
        throw new Error(label());
      }
    }
  }

  /** Write bytes (string → char codes & 0xff). */
  async write(data: number[] | Uint8Array | string): Promise<void> {
    if (!this.#writer) throw new Error('SerialTestHarness is not open.');
    await this.#writer.write(Uint8Array.from(toBytes(data)));
  }

  /** Read exactly `n` bytes (fewer only if the stream ends first). */
  readBytes(n: number, options: ReadOptions = {}): Promise<Uint8Array> {
    const timeout = options.timeout ?? this.#defaultTimeout;
    return this.#consume(
      buf => (buf.length >= n ? n : false),
      timeout,
      () => `timed out reading ${n} bytes (got ${this.#pending.length})`,
    );
  }

  /** Read up to and including `delimiter`; returns the slice (incl. delimiter). */
  readUntil(
    delimiter: number[] | Uint8Array | string,
    options: ReadOptions = {},
  ): Promise<Uint8Array> {
    const needle = toBytes(delimiter);
    const timeout = options.timeout ?? this.#defaultTimeout;
    return this.#consume(
      buf => {
        const idx = indexOfSubsequence(buf, needle);
        return idx < 0 ? false : idx + needle.length;
      },
      timeout,
      () => `timed out reading until delimiter`,
    );
  }

  /** Read one `\n`-terminated line as text (trailing CR/LF stripped). */
  async readLine(options: ReadOptions = {}): Promise<string> {
    const bytes = await this.readUntil('\n', options);
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0a) end--;
    if (end > 0 && bytes[end - 1] === 0x0d) end--;
    return String.fromCharCode(...bytes.subarray(0, end));
  }

  /**
   * Frame a message: `predicate(buffer)` returns the number of leading bytes the
   * next frame occupies (consumed and returned), or `false` to wait for more.
   */
  readMatching(
    predicate: (buffer: Uint8Array) => number | false,
    options: ReadOptions = {},
  ): Promise<Uint8Array> {
    const timeout = options.timeout ?? this.#defaultTimeout;
    return this.#consume(
      buf => predicate(Uint8Array.from(buf)),
      timeout,
      () => `timed out waiting for a frame`,
    );
  }

  /**
   * Resolve with the next chunk of buffered inbound bytes (one or more), or an
   * empty array once the stream has ended. Rejects on timeout. Use this to layer
   * your own framing/decoder (SLIP, COBS, length-prefix, …) on the byte stream;
   * pair it with {@link ended} to stop when the device goes away.
   */
  readAvailable(options: ReadOptions = {}): Promise<Uint8Array> {
    const timeout = options.timeout ?? this.#defaultTimeout;
    return this.#consume(
      buf => (buf.length > 0 ? buf.length : false),
      timeout,
      () => `timed out waiting for data`,
    );
  }

  /** Assert no inbound bytes arrive for `ms`. Rejects if any do. */
  async expectIdle(ms: number): Promise<void> {
    if (this.#pending.length > 0) {
      throw new Error(
        `expected no inbound data but ${this.#pending.length} byte(s) were already buffered`,
      );
    }
    try {
      await this.#waitForChange(ms);
    } catch {
      return; // no change within the window — idle, as expected
    }
    if (this.#pending.length > 0) {
      throw new Error(
        `expected no inbound data for ${ms}ms but received ${this.#pending.length} byte(s)`,
      );
    }
    // stream ended with no data — also idle
  }

  /** Drop any buffered-but-unread inbound bytes. */
  drain(): void {
    this.#pending.length = 0;
  }

  /** Release reader + writer locks and close the port. Safe to call twice. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
    if (this.#reader) {
      try {
        await this.#reader.cancel();
      } catch {
        // ignore
      }
      try {
        this.#reader.releaseLock();
      } catch {
        // already released
      }
      this.#reader = null;
    }
    if (this.#writer) {
      try {
        await this.#writer.close();
      } catch {
        // ignore
      }
      try {
        this.#writer.releaseLock();
      } catch {
        // already released
      }
      this.#writer = null;
    }
    this.#open = false;
    try {
      await this.#port.close();
    } catch {
      // already closed
    }
  }
}

/** Create a {@link SerialTestHarness} for any SerialPort (virtual, real, or WS). */
export function createSerialTestHarness(
  port: SerialPort,
  options?: SerialTestHarnessOptions,
): SerialTestHarness {
  return new SerialTestHarness(port, options);
}
