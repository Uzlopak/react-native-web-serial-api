/**
 * VirtualSerialTransport — an in-memory {@link SerialTransport} for tests and
 * on-device demos.
 *
 * It implements the exact same interface the production `UsbSerialModule` does,
 * but talks to simulated devices instead of real USB hardware. Because it has
 * **no `react-native` dependency**, the same instance drives:
 *
 *   - Jest/Node unit tests and the conformance suite,
 *   - the example app's "virtual device" mode on a real Android device, and
 *   - the example app running in a browser (react-native-web).
 *
 * Inject it via `new Serial(transport)` or globally with `setUsbSerial(transport)`.
 *
 * @example
 * const transport = new VirtualSerialTransport();
 * transport.addDevice(new EchoDevice(), {hasPermission: true});
 * const serial = new Serial(transport);
 * const [port] = await serial.getPorts();
 * await port.open({baudRate: 115200});
 * // writes to port.writable now come back on port.readable (echo)
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
import {DEFAULT_OPEN_OPTIONS} from '../transport';
import type {
  SerialDevice,
  SerialDeviceHost,
  SerialInputSignals,
} from './serial-device';

/** Transport-side knobs when registering a {@link SerialDevice}. */
export type VirtualSerialDeviceOptions = {
  /** Whether the app already holds USB permission. Defaults to false. */
  hasPermission?: boolean;
  /** Defaults to 0. A USB device may expose several ports. */
  portNumber?: number;
  /** Override the device's serialNumber for enumeration. */
  serialNumber?: string;
  /**
   * Cross-wire output signals onto inputs the way a null-modem/loopback plug
   * would (DTR→DSR+DCD, RTS→CTS) so getSignals() reflects setSignals().
   * Defaults to true.
   */
  loopbackSignals?: boolean;
  /**
   * When the port is opened with hardware (RTS/CTS) flow control, the device
   * de-asserts CTS once this many bytes have been written without the receiver
   * draining — modelling a full receive buffer. Defaults to 256.
   */
  flowControlThreshold?: number;
};

export type VirtualSerialTransportOptions = {
  /** Devices to register on construction (same as calling addDevice). */
  devices?: SerialDevice[];
  /**
   * Delay (ms) applied to async operations and to inbound data delivery.
   * 0 (default) resolves on a microtask — deterministic for Jest. A small
   * positive value makes streaming feel realistic on a device.
   */
  latencyMs?: number;
  /**
   * Whether showPortPicker() grants USB permission to the chosen device,
   * mirroring the real Android picker. Defaults to true.
   */
  autoGrantPermission?: boolean;
  /**
   * If set, inbound data larger than this is delivered as several `onData`
   * events of at most this many bytes — modelling how a real serial port hands
   * data up in chunks. 0/undefined delivers each write's reply in one event.
   */
  chunkSize?: number;
};

/** Operations whose next invocation can be made to fail (error injection). */
export type FailableOp =
  | 'open'
  | 'close'
  | 'write'
  | 'startReading'
  | 'stopReading'
  | 'setSignals'
  | 'getSignals';

type OutputSignals = {dtr: boolean; rts: boolean; brk: boolean};
type InputSignals = {dcd: boolean; cts: boolean; ri: boolean; dsr: boolean};

function toByte(n: number): number {
  return n & 0xff;
}

/** Map the device's verbose input-signal names onto the internal short names. */
function mapInputSignals(s: SerialInputSignals): Partial<InputSignals> {
  const out: Partial<InputSignals> = {};
  if (s.dataCarrierDetect !== undefined) out.dcd = s.dataCarrierDetect;
  if (s.clearToSend !== undefined) out.cts = s.clearToSend;
  if (s.ringIndicator !== undefined) out.ri = s.ringIndicator;
  if (s.dataSetReady !== undefined) out.dsr = s.dataSetReady;
  return out;
}

/**
 * A simulated USB-serial device. Returned by {@link VirtualSerialTransport.addDevice}.
 * The mutable fields and the helper methods let a test or demo drive the device
 * the way physical hardware (and a human plugging cables) otherwise would.
 */
export class VirtualSerialDevice {
  readonly usbVendorId: number;
  readonly usbProductId: number;
  readonly portNumber: number;
  serialNumber: string;

  /** Reassigned on every (re)attach, mirroring Android's behaviour. */
  deviceId: number;
  attached = true;
  hasPermission: boolean;
  isOpen = false;
  reading = false;
  /** The hosted behaviour. */
  readonly serialDevice: SerialDevice;
  loopbackSignals: boolean;
  flowControl: FlowControl = 'NONE';
  flowControlThreshold: number;
  openOptions: Required<OpenOptions> | null = null;

  /**
   * When non-null, the device delivers at most this many bytes before raising a
   * `BufferOverrunError` — models a fixed-size receive buffer overflowing.
   */
  overrunLimit: number | null = null;

  // @internal counters used by the transport.
  _rxDelivered = 0;
  _overran = false;
  _hwWritten = 0;

  readonly output: OutputSignals = {dtr: false, rts: false, brk: false};
  readonly input: InputSignals = {
    dcd: false,
    cts: false,
    ri: false,
    dsr: false,
  };

  /** Every byte frame the host has written to this device, in order. */
  readonly written: number[][] = [];

  readonly #fails = new Set<FailableOp>();
  readonly #transport: VirtualSerialTransport;

  constructor(
    transport: VirtualSerialTransport,
    deviceId: number,
    device: SerialDevice,
    options: VirtualSerialDeviceOptions,
  ) {
    this.#transport = transport;
    this.deviceId = deviceId;
    this.serialDevice = device;
    this.usbVendorId = device.usbVendorId;
    this.usbProductId = device.usbProductId;
    this.portNumber = options.portNumber ?? 0;
    this.serialNumber =
      options.serialNumber ??
      device.serialNumber ??
      `VSERIAL-${device.usbVendorId.toString(16)}-${device.usbProductId.toString(16)}`;
    this.hasPermission = options.hasPermission ?? false;
    this.loopbackSignals = options.loopbackSignals ?? true;
    this.flowControlThreshold = options.flowControlThreshold ?? 256;
  }

  /** Push inbound bytes to the host as if the device sent them unprompted. */
  push(bytes: number[] | Uint8Array): void {
    this.#transport._deliver(this, [...bytes].map(toByte));
  }

  /**
   * Raise a read error on the host's readable stream. `name` is the W3C error
   * type (e.g. "BreakError", "BufferOverrunError"); the current polyfill ignores
   * it and surfaces "NetworkError" regardless (a documented spec gap).
   */
  emitError(message: string, name?: string): void {
    this.#transport._error(this, message, name);
  }

  /**
   * Make the device deliver at most `bytes` bytes and then raise a
   * `BufferOverrunError`, modelling a receive buffer of that size overflowing.
   */
  overrunAfter(bytes: number): this {
    this.overrunLimit = bytes;
    this._rxDelivered = 0;
    this._overran = false;
    return this;
  }

  /** Make the next call to `op` reject once (error injection). */
  failNext(op: FailableOp): this {
    this.#fails.add(op);
    return this;
  }

  /** @internal consume a queued failure for `op`. */
  _consumeFail(op: FailableOp): boolean {
    if (this.#fails.has(op)) {
      this.#fails.delete(op);
      return true;
    }
    return false;
  }

  /** Directly set device-asserted input signals (DCD/CTS/RI/DSR). */
  setInputSignals(signals: Partial<InputSignals>): void {
    Object.assign(this.input, signals);
  }

  /** Physically attach (or re-attach) this device — fires "connect". */
  attach(): void {
    this.#transport.attach(this);
  }

  /** Physically detach this device — fires "disconnect". */
  detach(): void {
    this.#transport.detach(this);
  }

  /** Simulate an unplug while open: errors the open stream, then disconnects. */
  loseDevice(): void {
    this.#transport.loseDevice(this);
  }
}

type Listener<E> = (event: E) => void;

/**
 * In-memory transport backing one or more {@link VirtualSerialDevice}s.
 */
export class VirtualSerialTransport implements SerialTransport {
  readonly #devices: VirtualSerialDevice[] = [];
  readonly #latencyMs: number;
  readonly #autoGrant: boolean;
  readonly #chunkSize: number;
  #nextDeviceId = 1;

  readonly #dataListeners = new Set<Listener<DataEvent>>();
  readonly #errorListeners = new Set<Listener<ErrorEvent>>();
  readonly #connectListeners = new Set<Listener<ConnectEvent>>();
  readonly #disconnectListeners = new Set<Listener<ConnectEvent>>();

  /** Scripts the next showPortPicker() outcome. */
  #pendingPick:
    | VirtualSerialDevice
    | ((d: VirtualSerialDevice) => boolean)
    | 'reject'
    | null = null;

  constructor(options: VirtualSerialTransportOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0;
    this.#autoGrant = options.autoGrantPermission ?? true;
    this.#chunkSize = options.chunkSize ?? 0;
    for (const device of options.devices ?? []) this.addDevice(device);
  }

  // ── Device management ──────────────────────────────────────────────────────

  /** All devices known to the transport (attached or not). */
  get devices(): readonly VirtualSerialDevice[] {
    return this.#devices;
  }

  /**
   * Register a {@link SerialDevice}. It starts attached but does not fire
   * "connect"; its identity (usbVendorId/usbProductId/serialNumber) is read from
   * the device, and `options` carries the transport-side knobs.
   */
  addDevice(
    serialDevice: SerialDevice,
    options: VirtualSerialDeviceOptions = {},
  ): VirtualSerialDevice {
    const device = new VirtualSerialDevice(
      this,
      this.#nextDeviceId++,
      serialDevice,
      options,
    );
    serialDevice._bind(this.#hostFor(device));
    this.#devices.push(device);
    return device;
  }

  /** The handle a hosted {@link SerialDevice} uses to talk back to the host. */
  #hostFor(device: VirtualSerialDevice): SerialDeviceHost {
    return {
      get deviceId() {
        return device.deviceId;
      },
      get portNumber() {
        return device.portNumber;
      },
      get isOpen() {
        return device.isOpen;
      },
      get openOptions() {
        return device.openOptions;
      },
      send: bytes => this._deliver(device, bytes.map(toByte)),
      raiseError: (message, name) => this._error(device, message, name),
      setSignals: signals => device.setInputSignals(mapInputSignals(signals)),
    };
  }

  /** Invoke a device hook, isolating the transport from author errors. */
  #invokeHook(fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          console.error('SerialDevice hook rejected:', err);
        });
      }
    } catch (err) {
      console.error('SerialDevice hook threw:', err);
    }
  }

  /** Remove a device entirely; detaches it first if attached. */
  removeDevice(device: VirtualSerialDevice): void {
    if (device.attached) this.detach(device);
    const i = this.#devices.indexOf(device);
    if (i >= 0) this.#devices.splice(i, 1);
  }

  /** (Re)attach a device, assigning it a fresh deviceId, and fire "connect". */
  attach(device: VirtualSerialDevice): void {
    device.deviceId = this.#nextDeviceId++;
    device.attached = true;
    this.#emit(this.#connectListeners, {
      deviceId: device.deviceId,
      usbVendorId: device.usbVendorId,
      usbProductId: device.usbProductId,
    });
  }

  /** Detach a device and fire "disconnect"; any open port becomes closed. */
  detach(device: VirtualSerialDevice): void {
    const {deviceId, usbVendorId, usbProductId} = device;
    device.attached = false;
    device.isOpen = false;
    device.reading = false;
    this.#emit(this.#disconnectListeners, {
      deviceId,
      usbVendorId,
      usbProductId,
    });
  }

  /** Simulate an unplug while open: error the stream first, then disconnect. */
  loseDevice(device: VirtualSerialDevice): void {
    if (device.isOpen) this._error(device, 'Device disconnected');
    this.detach(device);
  }

  /** Script the next showPortPicker() resolution (a device or a predicate). */
  selectNextPort(
    target: VirtualSerialDevice | ((d: VirtualSerialDevice) => boolean),
  ): void {
    this.#pendingPick = target;
  }

  /** Make the next showPortPicker() reject (user cancelled / no port). */
  rejectNextPortPicker(): void {
    this.#pendingPick = 'reject';
  }

  // ── Internal event helpers (called by VirtualSerialDevice) ───────────────────────

  /** @internal deliver inbound bytes to the host's readable stream. */
  _deliver(device: VirtualSerialDevice, data: number[]): void {
    if (!device.attached || !device.isOpen || !device.reading) return;

    if (device.overrunLimit != null) {
      if (device._overran) return; // buffer already overflowed; drop the rest
      const remaining = device.overrunLimit - device._rxDelivered;
      if (data.length > remaining) {
        const head = data.slice(0, Math.max(0, remaining));
        device._rxDelivered += head.length;
        device._overran = true;
        if (head.length) this.#emitData(device, head);
        this._error(device, 'Receive buffer overrun', 'BufferOverrunError');
        return;
      }
      device._rxDelivered += data.length;
    }

    this.#emitData(device, data);
  }

  /** @internal raise a read error for a device's open port. */
  _error(device: VirtualSerialDevice, message: string, name?: string): void {
    const event: ErrorEvent = {
      deviceId: device.deviceId,
      portNumber: device.portNumber,
      error: message,
      errorName: name,
    };
    this.#schedule(() => this.#emit(this.#errorListeners, event));
  }

  /** Deliver `data` as one or more onData events, honouring `chunkSize`. */
  #emitData(device: VirtualSerialDevice, data: number[]): void {
    const emitOne = (slice: number[]) => {
      const event: DataEvent = {
        deviceId: device.deviceId,
        portNumber: device.portNumber,
        data: slice,
      };
      this.#schedule(() => this.#emit(this.#dataListeners, event));
    };
    const chunk = this.#chunkSize;
    if (chunk && data.length > chunk) {
      for (let i = 0; i < data.length; i += chunk) {
        emitOne(data.slice(i, i + chunk));
      }
    } else {
      emitOne(data);
    }
  }

  // ── SerialTransport: discovery & permission ────────────────────────────────

  findAllDrivers(): Promise<ReadonlyArray<PortId>> {
    const ports = this.#devices.filter(d => d.attached).map(this.#toPortId);
    return this.#resolve(ports);
  }

  showPortPicker(
    filter: ReadonlyArray<PortFilter>,
    _labels?: PortPickerLabels,
  ): Promise<PortId> {
    const pick = this.#pendingPick;
    this.#pendingPick = null;

    if (pick === 'reject') {
      return this.#reject(new Error('No port selected'));
    }

    const candidates = this.#devices.filter(
      d => d.attached && this.#matchesFilters(d, filter),
    );

    let chosen: VirtualSerialDevice | undefined;
    if (typeof pick === 'function') {
      chosen = candidates.find(pick);
    } else if (pick) {
      chosen = candidates.includes(pick) ? pick : undefined;
    } else {
      chosen = candidates[0];
    }

    if (!chosen) return this.#reject(new Error('No port selected'));
    if (this.#autoGrant) chosen.hasPermission = true;
    return this.#resolve(this.#toPortId(chosen));
  }

  requestPermission(deviceId: number): Promise<boolean> {
    const device = this.#find(deviceId);
    if (device) device.hasPermission = true;
    return this.#resolve(!!device);
  }

  // ── SerialTransport: lifecycle ─────────────────────────────────────────────

  open(
    deviceId: number,
    portNumber: number,
    options: OpenOptions,
  ): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (!device) return this.#reject(new Error('Device not found'));
    if (device._consumeFail('open')) {
      return this.#reject(new Error('open failed (injected)'));
    }
    device.isOpen = true;
    device.openOptions = {...DEFAULT_OPEN_OPTIONS, ...options};
    device._hwWritten = 0;
    this.#invokeHook(() => device.serialDevice.onOpen(device.openOptions!));
    return this.#resolve();
  }

  close(deviceId: number, portNumber: number): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (device?._consumeFail('close')) {
      return this.#reject(new Error('close failed (injected)'));
    }
    if (device) {
      device.isOpen = false;
      device.reading = false;
      this.#invokeHook(() => device.serialDevice.onClose());
    }
    return this.#resolve();
  }

  isOpen(deviceId: number, portNumber: number): boolean {
    return this.#find(deviceId, portNumber)?.isOpen ?? false;
  }

  // ── SerialTransport: I/O ───────────────────────────────────────────────────

  write(
    deviceId: number,
    portNumber: number,
    data: number[],
    _timeout?: number,
  ): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (!device?.isOpen) {
      return this.#reject(new Error('Port is not open'));
    }
    if (device._consumeFail('write')) {
      return this.#reject(new Error('write failed (injected)'));
    }
    const bytes = data.map(toByte);
    device.written.push(bytes);
    if (device.flowControl === 'RTS_CTS') device._hwWritten += bytes.length;
    this.#invokeHook(() => device.serialDevice.onData(Uint8Array.from(bytes)));
    return this.#resolve();
  }

  startReading(deviceId: number, portNumber: number): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (device?._consumeFail('startReading')) {
      return this.#reject(new Error('startReading failed (injected)'));
    }
    if (device) device.reading = true;
    return this.#resolve();
  }

  stopReading(deviceId: number, portNumber: number): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (device?._consumeFail('stopReading')) {
      return this.#reject(new Error('stopReading failed (injected)'));
    }
    if (device) device.reading = false;
    return this.#resolve();
  }

  setParameters(
    deviceId: number,
    portNumber: number,
    options: OpenOptions,
  ): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (device) device.openOptions = {...DEFAULT_OPEN_OPTIONS, ...options};
    return this.#resolve();
  }

  // ── SerialTransport: control signals ───────────────────────────────────────

  setDTR(deviceId: number, portNumber: number, value: boolean): Promise<void> {
    return this.#setOutput(deviceId, portNumber, 'dtr', value);
  }

  setRTS(deviceId: number, portNumber: number, value: boolean): Promise<void> {
    return this.#setOutput(deviceId, portNumber, 'rts', value);
  }

  setBreak(
    deviceId: number,
    portNumber: number,
    value: boolean,
  ): Promise<void> {
    return this.#setOutput(deviceId, portNumber, 'brk', value);
  }

  getDTR(deviceId: number, portNumber: number): Promise<boolean> {
    return this.#resolve(this.#find(deviceId, portNumber)?.output.dtr ?? false);
  }

  getRTS(deviceId: number, portNumber: number): Promise<boolean> {
    return this.#resolve(this.#find(deviceId, portNumber)?.output.rts ?? false);
  }

  getCD(deviceId: number, portNumber: number): Promise<boolean> {
    const device = this.#find(deviceId, portNumber);
    if (device?._consumeFail('getSignals')) {
      return this.#reject(new Error('getSignals failed (injected)'));
    }
    return this.#resolve(device?.input.dcd ?? false);
  }

  getCTS(deviceId: number, portNumber: number): Promise<boolean> {
    const device = this.#find(deviceId, portNumber);
    // Under hardware (RTS/CTS) flow control the device drives CTS itself,
    // de-asserting it once its receive buffer fills (modelled by the byte
    // threshold). Otherwise CTS just reflects the loopback wiring.
    if (device && device.flowControl === 'RTS_CTS') {
      return this.#resolve(device._hwWritten < device.flowControlThreshold);
    }
    return this.#resolve(device?.input.cts ?? false);
  }

  getRI(deviceId: number, portNumber: number): Promise<boolean> {
    return this.#resolve(this.#find(deviceId, portNumber)?.input.ri ?? false);
  }

  getDSR(deviceId: number, portNumber: number): Promise<boolean> {
    return this.#resolve(this.#find(deviceId, portNumber)?.input.dsr ?? false);
  }

  getControlLines(
    deviceId: number,
    portNumber: number,
  ): Promise<ControlLine[]> {
    const device = this.#find(deviceId, portNumber);
    const lines: ControlLine[] = [];
    if (device) {
      if (device.output.dtr) lines.push('DTR');
      if (device.output.rts) lines.push('RTS');
      if (device.input.cts) lines.push('CTS');
      if (device.input.dsr) lines.push('DSR');
      if (device.input.dcd) lines.push('CD');
      if (device.input.ri) lines.push('RI');
    }
    return this.#resolve(lines);
  }

  getSupportedControlLines(
    _deviceId: number,
    _portNumber: number,
  ): Promise<ControlLine[]> {
    return this.#resolve(['RTS', 'CTS', 'DTR', 'DSR', 'CD', 'RI']);
  }

  // ── SerialTransport: flow control & misc ───────────────────────────────────

  setFlowControl(
    deviceId: number,
    portNumber: number,
    flowControl: FlowControl,
  ): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (device) device.flowControl = flowControl;
    return this.#resolve();
  }

  getFlowControl(deviceId: number, portNumber: number): Promise<FlowControl> {
    return this.#resolve(
      this.#find(deviceId, portNumber)?.flowControl ?? 'NONE',
    );
  }

  getSupportedFlowControl(
    _deviceId: number,
    _portNumber: number,
  ): Promise<FlowControl[]> {
    return this.#resolve(['NONE', 'RTS_CTS']);
  }

  purgeHwBuffers(
    _deviceId: number,
    _portNumber: number,
    _purgeWriteBuffers: boolean,
    _purgeReadBuffers: boolean,
  ): Promise<void> {
    return this.#resolve();
  }

  getSerial(deviceId: number, portNumber: number): Promise<string> {
    return this.#resolve(this.#find(deviceId, portNumber)?.serialNumber ?? '');
  }

  // ── SerialTransport: subscriptions ─────────────────────────────────────────

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

  // ── Private helpers ────────────────────────────────────────────────────────

  #setOutput(
    deviceId: number,
    portNumber: number,
    key: keyof OutputSignals,
    value: boolean,
  ): Promise<void> {
    const device = this.#find(deviceId, portNumber);
    if (device?._consumeFail('setSignals')) {
      return this.#reject(new Error('setSignals failed (injected)'));
    }
    if (device) {
      device.output[key] = value;
      if (device.loopbackSignals) {
        if (key === 'dtr') {
          device.input.dsr = value;
          device.input.dcd = value;
        } else if (key === 'rts') {
          device.input.cts = value;
        }
      }
      this.#invokeHook(() =>
        device.serialDevice.onHostSignals({
          dataTerminalReady: device.output.dtr,
          requestToSend: device.output.rts,
          break: device.output.brk,
        }),
      );
    }
    return this.#resolve();
  }

  #toPortId = (d: VirtualSerialDevice): PortId => ({
    deviceId: d.deviceId,
    portNumber: d.portNumber,
    usbVendorId: d.usbVendorId,
    usbProductId: d.usbProductId,
    hasPermission: d.hasPermission,
  });

  #matchesFilters(
    device: VirtualSerialDevice,
    filters: ReadonlyArray<PortFilter>,
  ): boolean {
    if (!filters || filters.length === 0) return true;
    return filters.some(f => {
      if (f.usbVendorId !== undefined && f.usbVendorId !== device.usbVendorId) {
        return false;
      }
      if (
        f.usbProductId !== undefined &&
        f.usbProductId !== device.usbProductId
      ) {
        return false;
      }
      return true;
    });
  }

  #find(
    deviceId: number,
    portNumber?: number,
  ): VirtualSerialDevice | undefined {
    return this.#devices.find(
      d =>
        d.attached &&
        d.deviceId === deviceId &&
        (portNumber === undefined || d.portNumber === portNumber),
    );
  }

  #subscribe<E>(set: Set<Listener<E>>, listener: Listener<E>): Subscription {
    set.add(listener);
    return {remove: () => set.delete(listener)};
  }

  #emit<E>(set: Set<Listener<E>>, event: E): void {
    for (const listener of [...set]) listener(event);
  }

  #schedule(fn: () => void): void {
    if (this.#latencyMs > 0) setTimeout(fn, this.#latencyMs);
    else queueMicrotask(fn);
  }

  #resolve<T>(value?: T): Promise<T> {
    if (this.#latencyMs > 0) {
      return new Promise(r => setTimeout(() => r(value as T), this.#latencyMs));
    }
    return Promise.resolve(value as T);
  }

  #reject(error: Error): Promise<never> {
    if (this.#latencyMs > 0) {
      return new Promise((_, reject) =>
        setTimeout(() => reject(error), this.#latencyMs),
      );
    }
    return Promise.reject(error);
  }
}
