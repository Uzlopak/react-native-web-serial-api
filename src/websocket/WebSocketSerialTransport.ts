/**
 * A {@link SerialTransport} that talks to a remote serial port over a WebSocket
 * bridge (run `expose-serial-websocket` on the host — see `bin/expose-serial.js`).
 *
 * Because it implements the same seam as the native `UsbSerialModule` and the
 * in-memory `VirtualSerialTransport`, it's a drop-in: the whole `Serial` /
 * `SerialPort` polyfill (streams, signals, reconnect, the conformance suite)
 * works on top of it unchanged.
 *
 * **Resilience.** The socket is supervised: an unexpected drop (server restart,
 * network blip) is handled transparently — the transport reconnects with
 * exponential backoff and *restores the session* (line coding, control signals,
 * and read state) so the app's open `SerialPort` keeps working. A transient
 * drop is therefore invisible to the polyfill (reads pause and resume; writes
 * issued during the gap wait for the reconnection). Only a real remote
 * disconnect (the host's serial port going away) or giving up after
 * `maxReconnectAttempts` surfaces as a serial disconnect.
 *
 * @example
 * import {Serial} from 'react-native-web-serial-api';
 * import {WebSocketSerialTransport} from 'react-native-web-serial-api/websocket';
 *
 * const serial = new Serial(new WebSocketSerialTransport('ws://localhost:8080'));
 * const [port] = await serial.getPorts();
 * await port.open({baudRate: 115200});
 */

import type {
  ConnectEvent,
  ControlLine,
  DataEvent,
  ErrorEvent,
  FlowControl,
  OpenOptions,
  PortFilter,
  PortId,
  PortPickerLabels,
  SerialTransport,
  Subscription,
} from '../transport';
import {type LineCoding, type Parity, parseControlMessage} from './protocol';

/** Minimal structural WebSocket shape (browser & React Native both provide it). */
export interface WebSocketLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: {data?: unknown}) => void,
  ): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export type WebSocketConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  // The consumer closed the port: the socket is dropped (releasing the remote
  // serial session) but the transport will reconnect on demand when reopened.
  | 'suspended'
  | 'closed';

export type WebSocketSerialOptions = {
  /** USB identity to report from getInfo() (cosmetic; default 0/0). */
  usbVendorId?: number;
  usbProductId?: number;
  /** Serial number returned by getSerial(). */
  serialNumber?: string;
  /** WebSocket implementation (defaults to the global). Injectable for tests. */
  WebSocket?: WebSocketCtor;
  /** Auto-reconnect when the socket drops unexpectedly. Default `true`. */
  reconnect?: boolean;
  /** Initial reconnect backoff in ms; doubles each attempt. Default 250. */
  reconnectInitialDelayMs?: number;
  /** Cap on the reconnect backoff in ms. Default 10000. */
  reconnectMaxDelayMs?: number;
  /** Give up (surface a disconnect) after this many consecutive failures. Default Infinity. */
  maxReconnectAttempts?: number;
  /** How long write()/commands wait for a (re)connection before failing. Default 10000. */
  connectTimeoutMs?: number;
  /** How long a control command waits for its response before failing. Default 10000. */
  commandTimeoutMs?: number;
  /** Notified before each reconnect attempt (1-based attempt + the chosen delay). */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Notified once (re)connected; `reconnected` is false only for the first connect. */
  onConnected?: (info: {reconnected: boolean}) => void;
  /** Notified when the transport is permanently closed (gave up, or `disconnect()`). */
  onClosed?: (reason: string) => void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};
type Waiter = {resolve: () => void; reject: (reason: Error) => void};
type Listener<E> = (event: E) => void;

const PARITY: Record<number, Parity> = {
  0: 'none',
  1: 'odd',
  2: 'even',
};

export class WebSocketSerialTransport implements SerialTransport {
  readonly #deviceId = 1;
  readonly #portNumber = 0;
  #usbVendorId: number;
  #usbProductId: number;
  #serialNumber: string;

  readonly #url: string;
  readonly #Ctor: WebSocketCtor;
  readonly #reconnectEnabled: boolean;
  readonly #initialDelay: number;
  readonly #maxDelay: number;
  readonly #maxAttempts: number;
  readonly #connectTimeout: number;
  readonly #commandTimeout: number;
  readonly #options: WebSocketSerialOptions;

  #ws: WebSocketLike | null = null;
  #state: WebSocketConnectionState = 'connecting';
  #everConnected = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #metadataLoaded = false;

  // Session state to restore on reconnect.
  #portOpen = false;
  #reading = false;
  #lastLineCoding: LineCoding | null = null;
  #nextId = 1;
  #dtr = false;
  #rts = false;

  readonly #pending = new Map<number, Pending>();
  readonly #connectWaiters = new Set<Waiter>();
  readonly #dataListeners = new Set<Listener<DataEvent>>();
  readonly #errorListeners = new Set<Listener<ErrorEvent>>();
  readonly #connectListeners = new Set<Listener<ConnectEvent>>();
  readonly #disconnectListeners = new Set<Listener<ConnectEvent>>();

  constructor(url: string, options: WebSocketSerialOptions = {}) {
    this.#options = options;
    this.#usbVendorId = options.usbVendorId ?? 0;
    this.#usbProductId = options.usbProductId ?? 0;
    this.#serialNumber = options.serialNumber ?? '';

    const Ctor =
      options.WebSocket ??
      (globalThis as {WebSocket?: WebSocketCtor}).WebSocket;
    if (!Ctor) {
      throw new Error('No WebSocket implementation is available.');
    }
    this.#url = url;
    this.#Ctor = Ctor;
    this.#reconnectEnabled = options.reconnect ?? true;
    this.#initialDelay = options.reconnectInitialDelayMs ?? 250;
    this.#maxDelay = options.reconnectMaxDelayMs ?? 10000;
    this.#maxAttempts =
      options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    this.#connectTimeout = options.connectTimeoutMs ?? 10000;
    this.#commandTimeout = options.commandTimeoutMs ?? 10000;

    this.#connect();
  }

  /** Current connection state (advisory; the polyfill keeps working across reconnects). */
  get connectionState(): WebSocketConnectionState {
    return this.#state;
  }

  // ── connection lifecycle ────────────────────────────────────────────────────

  #connect(): void {
    /* istanbul ignore next — reconnect timers are cleared on explicit disconnect() */
    if (this.#state === 'closed') {
      return;
    }
    this.#state = this.#everConnected ? 'reconnecting' : 'connecting';
    let ws: WebSocketLike;
    try {
      ws = new this.#Ctor(this.#url);
    } catch {
      // Construction itself failed (e.g. bad URL on some impls) — treat as a drop.
      this.#handleSocketDown();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    let dead = false;
    const onDown = () => {
      // Fire once per socket, and ignore a stale socket we've already replaced.
      if (dead || ws !== this.#ws) {
        return;
      }
      dead = true;
      this.#handleSocketDown();
    };

    ws.addEventListener('open', () => {
      if (ws === this.#ws) {
        void this.#onOpen();
      }
    });
    ws.addEventListener('message', event => {
      if (ws === this.#ws) {
        this.#onMessage((event as {data?: unknown}).data);
      }
    });
    ws.addEventListener('error', onDown);
    ws.addEventListener('close', onDown);
  }

  async #onOpen(): Promise<void> {
    const reconnected = this.#everConnected;
    this.#everConnected = true;
    this.#state = 'open';
    this.#reconnectAttempts = 0;
    try {
      // Re-establish the remote session before letting queued I/O resume, so
      // writes never go out at the wrong baud rate / signal state.
      await this.#restoreSession();
      await this.#loadPortInfo();
    } catch {
      // A drop happened mid-restore; the close handler schedules another retry.
      return;
    }
    if (!reconnected) {
      this.#emit(this.#connectListeners, this.#connectEvent());
    }
    this.#options.onConnected?.({reconnected});
    this.#releaseWaiters();
  }

  async #restoreSession(): Promise<void> {
    if (!this.#portOpen) {
      return; // nothing to restore until the app has opened the port
    }
    /* istanbul ignore next */
    if (this.#lastLineCoding) {
      await this.#sendCommand('setLineCoding', {...this.#lastLineCoding});
    }
    if (this.#dtr || this.#rts) {
      await this.#sendCommand('setSignals', {dtr: this.#dtr, rts: this.#rts});
    }
    // A fresh bridge connection forwards data by default; mirror the app's intent.
    await this.#sendCommand(this.#reading ? 'startReading' : 'stopReading');
  }

  async #loadPortInfo(): Promise<void> {
    if (this.#metadataLoaded) {
      return;
    }
    let info: {
      usbVendorId?: unknown;
      usbProductId?: unknown;
      serialNumber?: unknown;
    } | null = null;
    try {
      info = (await this.#sendCommand('getPortInfo')) as {
        usbVendorId?: unknown;
        usbProductId?: unknown;
        serialNumber?: unknown;
      } | null;
    } catch {
      // Older bridge versions won't implement getPortInfo; keep defaults.
      return;
    }
    if (info && typeof info === 'object') {
      if (typeof info.usbVendorId === 'number') {
        this.#usbVendorId = info.usbVendorId;
      }
      if (typeof info.usbProductId === 'number') {
        this.#usbProductId = info.usbProductId;
      }
      if (typeof info.serialNumber === 'string') {
        this.#serialNumber = info.serialNumber;
      }
    }
    this.#metadataLoaded = true;
  }

  async #probeAlive(): Promise<void> {
    try {
      // `getSignals` is supported by all bridge versions and gives us a
      // request/response roundtrip to detect half-open sockets.
      await this.#sendCommand('getSignals');
    } catch (error) {
      this.#handleSocketDown();
      throw error;
    }
  }

  #handleSocketDown(): void {
    if (this.#state === 'closed') {
      return;
    }
    // Commands tied to the dead socket can never be answered — reject them.
    this.#failAll('WebSocket connection lost');
    if (this.#reconnectEnabled && this.#reconnectAttempts < this.#maxAttempts) {
      this.#scheduleReconnect();
    } else {
      this.#terminate('WebSocket connection lost and will not be retried.');
    }
  }

  #scheduleReconnect(): void {
    this.#state = 'reconnecting';
    const attempt = this.#reconnectAttempts++; // 0-based for the backoff curve
    const delay = Math.min(this.#initialDelay * 2 ** attempt, this.#maxDelay);
    // Full jitter in the upper half keeps a herd of clients from syncing up.
    const jittered = Math.round(delay * (0.5 + Math.random() * 0.5));
    this.#options.onReconnecting?.(attempt + 1, jittered);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, jittered);
  }

  #terminate(reason: string): void {
    /* istanbul ignore next — terminate() only runs once per transport lifecycle */
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closed';
    this.#portOpen = false;
    this.#reading = false;
    /* istanbul ignore next — reconnect timers are either fired or cleared earlier */
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#failAll(reason);
    this.#rejectWaiters(new Error(reason));
    // Surface to the polyfill so any open stream fails with a NetworkError.
    this.#emit(this.#errorListeners, {
      deviceId: this.#deviceId,
      portNumber: this.#portNumber,
      error: reason,
    });
    this.#emit(this.#disconnectListeners, this.#connectEvent());
    this.#options.onClosed?.(reason);
  }

  /**
   * Release the socket because the consumer closed the port. Unlike a drop, this
   * does not auto-reconnect (no lingering bridge session) — the next `open()` or
   * discovery reconnects on demand. Distinct from the terminal `disconnect()`.
   */
  #suspend(): void {
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#reconnectAttempts = 0;
    this.#failAll('serial port closed');
    this.#state = 'suspended';
    const ws = this.#ws;
    this.#ws = null; // detach first so the socket's close handler is a no-op
    try {
      ws?.close();
    } catch {
      // already closing
    }
  }

  /**
   * Resolve when the socket is connected; reject on timeout or terminal close.
   * Wakes a `suspended` transport (after `close()`) by reconnecting on demand.
   */
  #whenConnected(): Promise<void> {
    if (this.#state === 'open') {
      return Promise.resolve();
    }
    if (this.#state === 'closed') {
      return Promise.reject(new Error('WebSocket transport is closed.'));
    }
    if (this.#state === 'suspended') {
      this.#connect(); // reconnect on demand
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#connectWaiters.delete(waiter);
        reject(new Error('Timed out waiting for the WebSocket connection.'));
      }, this.#connectTimeout);
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.#connectWaiters.add(waiter);
    });
  }

  #releaseWaiters(): void {
    for (const waiter of [...this.#connectWaiters]) {
      waiter.resolve();
    }
    this.#connectWaiters.clear();
  }

  #rejectWaiters(reason: Error): void {
    for (const waiter of [...this.#connectWaiters]) {
      waiter.reject(reason);
    }
    this.#connectWaiters.clear();
  }

  // ── message handling ───────────────────────────────────────────────────────

  #onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.#emit(this.#dataListeners, {
        deviceId: this.#deviceId,
        portNumber: this.#portNumber,
        data: Array.from(new Uint8Array(data)),
      });
      return;
    }
    if (typeof data !== 'string') {
      return;
    }
    const msg = parseControlMessage(data);
    if (!msg) {
      return;
    }
    if (msg.type === 'response') {
      const pending = this.#pending.get(msg.id);
      if (pending) {
        this.#pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.type === 'event') {
      if (msg.event === 'error') {
        this.#emit(this.#errorListeners, {
          deviceId: this.#deviceId,
          portNumber: this.#portNumber,
          error: msg.error ?? 'serial error',
        });
      } else if (msg.event === 'close') {
        // The host's serial port itself went away — a real disconnect (distinct
        // from a transport drop, which we reconnect through silently).
        this.#portOpen = false;
        this.#emit(this.#disconnectListeners, this.#connectEvent());
      }
    }
  }

  #failAll(reason: string): void {
    for (const [, pending] of this.#pending) {
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #connectEvent(): ConnectEvent {
    return {
      deviceId: this.#deviceId,
      usbVendorId: this.#usbVendorId,
      usbProductId: this.#usbProductId,
    };
  }

  /** Register a pending command and send it on the (already-open) socket. */
  #sendCommand(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || this.#state === 'closed') {
      return Promise.reject(new Error('WebSocket transport is closed.'));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`Command "${command}" timed out.`));
        }
      }, this.#commandTimeout);
      this.#pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        ws.send(JSON.stringify({type: 'command', id, command, args}));
      } catch (e) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Wait for a connection (reconnecting if necessary), then run a command. */
  async #command(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.#whenConnected();
    return this.#sendCommand(command, args);
  }

  #subscribe<E>(set: Set<Listener<E>>, listener: Listener<E>): Subscription {
    set.add(listener);
    return {remove: () => set.delete(listener)};
  }

  #emit<E>(set: Set<Listener<E>>, event: E): void {
    for (const listener of [...set]) {
      listener(event);
    }
  }

  // ── discovery & permission ─────────────────────────────────────────────────

  async findAllDrivers(): Promise<ReadonlyArray<PortId>> {
    try {
      await this.#whenConnected();
      await this.#probeAlive();
      await this.#loadPortInfo();
    } catch {
      // Discovery should be resilient: treat transport down as "no devices".
      return [];
    }
    return [
      {
        deviceId: this.#deviceId,
        portNumber: this.#portNumber,
        usbVendorId: this.#usbVendorId,
        usbProductId: this.#usbProductId,
        hasPermission: true,
      },
    ];
  }

  async showPortPicker(
    _filter: ReadonlyArray<PortFilter>,
    _labels?: PortPickerLabels,
  ): Promise<PortId> {
    const [port] = await this.findAllDrivers();
    return port;
  }

  requestPermission(_deviceId: number): Promise<boolean> {
    return Promise.resolve(true);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  #lineCoding(options: OpenOptions): LineCoding {
    return {
      baudRate: options.baudRate,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: PARITY[options.parity ?? 0] ?? 'none',
    };
  }

  async open(
    _deviceId: number,
    _portNumber: number,
    options: OpenOptions,
  ): Promise<void> {
    this.#lastLineCoding = this.#lineCoding(options);
    await this.#command('setLineCoding', {...this.#lastLineCoding});
    this.#portOpen = true;
  }

  async close(_deviceId: number, _portNumber: number): Promise<void> {
    this.#portOpen = false;
    this.#reading = false;
    if (this.#state === 'closed' || this.#state === 'suspended') {
      return;
    }
    // Tell the bridge to stop forwarding, then drop the socket so the remote
    // serial session is released and the device isn't left in a stale state.
    // A later open() reconnects on demand (see #whenConnected → #suspend).
    if (this.#state === 'open') {
      await this.#sendCommand('stopReading').catch(() => undefined);
    }
    this.#suspend();
  }

  isOpen(_deviceId: number, _portNumber: number): boolean {
    return this.#portOpen;
  }

  // ── I/O ────────────────────────────────────────────────────────────────────

  async write(
    _deviceId: number,
    _portNumber: number,
    data: number[],
    _timeout?: number,
  ): Promise<void> {
    await this.#whenConnected();
    const ws = this.#ws;
    /* istanbul ignore next — #whenConnected() guarantees an attached socket */
    if (!ws) {
      throw new Error('WebSocket transport is closed.');
    }
    ws.send(Uint8Array.from(data));
  }

  async startReading(_deviceId: number, _portNumber: number): Promise<void> {
    this.#reading = true;
    await this.#command('startReading');
  }

  async stopReading(_deviceId: number, _portNumber: number): Promise<void> {
    this.#reading = false;
    await this.#command('stopReading');
  }

  async setParameters(
    _deviceId: number,
    _portNumber: number,
    options: OpenOptions,
  ): Promise<void> {
    this.#lastLineCoding = this.#lineCoding(options);
    await this.#command('setLineCoding', {...this.#lastLineCoding});
  }

  // ── control signals ────────────────────────────────────────────────────────

  async setDTR(_d: number, _p: number, value: boolean): Promise<void> {
    this.#dtr = value;
    await this.#command('setSignals', {dtr: value});
  }

  async setRTS(_d: number, _p: number, value: boolean): Promise<void> {
    this.#rts = value;
    await this.#command('setSignals', {rts: value});
  }

  getDTR(_d: number, _p: number): Promise<boolean> {
    return Promise.resolve(this.#dtr);
  }

  getRTS(_d: number, _p: number): Promise<boolean> {
    return Promise.resolve(this.#rts);
  }

  async #signals(): Promise<{
    cts: boolean;
    dsr: boolean;
    dcd: boolean;
    ri: boolean;
  }> {
    const s = (await this.#command('getSignals')) as {
      cts?: boolean;
      dsr?: boolean;
      dcd?: boolean;
      ri?: boolean;
    } | null;
    return {
      cts: !!s?.cts,
      dsr: !!s?.dsr,
      dcd: !!s?.dcd,
      ri: !!s?.ri,
    };
  }

  async getCD(_d: number, _p: number): Promise<boolean> {
    return (await this.#signals()).dcd;
  }

  async getCTS(_d: number, _p: number): Promise<boolean> {
    return (await this.#signals()).cts;
  }

  async getDSR(_d: number, _p: number): Promise<boolean> {
    return (await this.#signals()).dsr;
  }

  async getRI(_d: number, _p: number): Promise<boolean> {
    return (await this.#signals()).ri;
  }

  async getControlLines(_d: number, _p: number): Promise<ControlLine[]> {
    const s = await this.#signals();
    const lines: ControlLine[] = [];
    if (this.#rts) lines.push('RTS');
    if (this.#dtr) lines.push('DTR');
    if (s.cts) lines.push('CTS');
    if (s.dsr) lines.push('DSR');
    if (s.dcd) lines.push('CD');
    if (s.ri) lines.push('RI');
    return lines;
  }

  getSupportedControlLines(_d: number, _p: number): Promise<ControlLine[]> {
    return Promise.resolve(['RTS', 'CTS', 'DTR', 'DSR', 'CD', 'RI']);
  }

  // ── flow control ───────────────────────────────────────────────────────────

  setFlowControl(
    _d: number,
    _p: number,
    _flowControl: FlowControl,
  ): Promise<void> {
    // Flow control is fixed at the rate the bridge was started with; accept the
    // call so open({flowControl}) doesn't fail, but it isn't changed live.
    return Promise.resolve();
  }

  getFlowControl(_d: number, _p: number): Promise<FlowControl> {
    return Promise.resolve('NONE');
  }

  getSupportedFlowControl(_d: number, _p: number): Promise<FlowControl[]> {
    return Promise.resolve(['NONE', 'RTS_CTS']);
  }

  // ── misc ───────────────────────────────────────────────────────────────────

  async setBreak(_d: number, _p: number, value: boolean): Promise<void> {
    await this.#command('setSignals', {brk: value});
  }

  async purgeHwBuffers(
    _d: number,
    _p: number,
    _purgeWrite: boolean,
    _purgeRead: boolean,
  ): Promise<void> {
    await this.#command('flush').catch(() => undefined);
  }

  getSerial(_d: number, _p: number): Promise<string> {
    return Promise.resolve(this.#serialNumber);
  }

  // ── subscriptions ──────────────────────────────────────────────────────────

  onData(listener: Listener<DataEvent>): Subscription {
    return this.#subscribe(this.#dataListeners, listener);
  }

  onError(listener: Listener<ErrorEvent>): Subscription {
    return this.#subscribe(this.#errorListeners, listener);
  }

  onConnect(listener: Listener<ConnectEvent>): Subscription {
    return this.#subscribe(this.#connectListeners, listener);
  }

  onDisconnect(listener: Listener<ConnectEvent>): Subscription {
    return this.#subscribe(this.#disconnectListeners, listener);
  }

  /**
   * Permanently close the transport (and the remote port session). Cancels any
   * pending reconnect and stops auto-reconnecting.
   */
  disconnect(): void {
    const alreadyClosed = this.#state === 'closed';
    this.#state = 'closed'; // set first so the socket's close handler won't reconnect
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    try {
      this.#ws?.close();
    } catch {
      // already closing
    }
    if (!alreadyClosed) {
      this.#portOpen = false;
      this.#reading = false;
      this.#failAll('WebSocket transport closed by client');
      this.#rejectWaiters(new Error('WebSocket transport is closed.'));
      this.#emit(this.#disconnectListeners, this.#connectEvent());
      this.#options.onClosed?.('closed by client');
    }
  }
}
