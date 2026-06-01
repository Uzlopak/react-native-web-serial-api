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
 * const device = transport.addDevice({
 *   usbVendorId: 0x0403,
 *   usbProductId: 0x6001,
 *   hasPermission: true,
 *   behavior: 'echo',
 * });
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

/**
 * A scripted device reply. Receives the bytes the host just wrote and returns
 * the bytes the device should send back (one or more frames), or nothing.
 */
export type DeviceResponder = (
  data: Uint8Array,
  ctx: {deviceId: number; portNumber: number; device: VirtualDevice},
) => number[] | Uint8Array | Array<number[] | Uint8Array> | undefined;

/**
 * How a virtual device reacts to host writes:
 *  - `'echo'`   — send the same bytes straight back (loopback). Default.
 *  - `'silent'` — accept writes but never send anything back.
 *  - a {@link DeviceResponder} — model a real protocol.
 */
export type VirtualDeviceBehavior = 'echo' | 'silent' | DeviceResponder;

export type VirtualDeviceInit = {
  usbVendorId: number;
  usbProductId: number;
  serialNumber?: string;
  /** Defaults to 0. A USB device may expose several ports. */
  portNumber?: number;
  /** Whether the app already holds USB permission. Defaults to false. */
  hasPermission?: boolean;
  /** Defaults to `'echo'`. */
  behavior?: VirtualDeviceBehavior;
  /**
   * Cross-wire output signals onto inputs the way a null-modem/loopback plug
   * would (DTR→DSR+DCD, RTS→CTS) so getSignals() reflects setSignals().
   * Defaults to true.
   */
  loopbackSignals?: boolean;
};

export type VirtualSerialOptions = {
  devices?: VirtualDeviceInit[];
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

function normalizeFrames(result: ReturnType<DeviceResponder>): number[][] {
  if (result == null) return [];
  if (result instanceof Uint8Array) return [Array.from(result)];
  if (Array.isArray(result)) {
    if (result.length === 0) return [];
    if (typeof result[0] === 'number') return [result as number[]];
    return (result as Array<number[] | Uint8Array>).map(frame =>
      frame instanceof Uint8Array ? Array.from(frame) : [...frame],
    );
  }
  return [];
}

/**
 * A simulated USB-serial device. Returned by {@link VirtualSerialTransport.addDevice}.
 * The mutable fields and the helper methods let a test or demo drive the device
 * the way physical hardware (and a human plugging cables) otherwise would.
 */
export class VirtualDevice {
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
  behavior: VirtualDeviceBehavior;
  loopbackSignals: boolean;
  flowControl: FlowControl = 'NONE';
  openOptions: Required<OpenOptions> | null = null;

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
    init: VirtualDeviceInit,
  ) {
    this.#transport = transport;
    this.deviceId = deviceId;
    this.usbVendorId = init.usbVendorId;
    this.usbProductId = init.usbProductId;
    this.portNumber = init.portNumber ?? 0;
    this.serialNumber =
      init.serialNumber ??
      `VSERIAL-${init.usbVendorId.toString(16)}-${init.usbProductId.toString(16)}`;
    this.hasPermission = init.hasPermission ?? false;
    this.behavior = init.behavior ?? 'echo';
    this.loopbackSignals = init.loopbackSignals ?? true;
  }

  /** Push inbound bytes to the host as if the device sent them unprompted. */
  push(bytes: number[] | Uint8Array): void {
    this.#transport._deliver(this, [...bytes].map(toByte));
  }

  /** Raise a read error on the host's readable stream. */
  emitError(message: string): void {
    this.#transport._error(this, message);
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
 * In-memory transport backing one or more {@link VirtualDevice}s.
 */
export class VirtualSerialTransport implements SerialTransport {
  readonly #devices: VirtualDevice[] = [];
  readonly #latencyMs: number;
  readonly #autoGrant: boolean;
  #nextDeviceId = 1;

  readonly #dataListeners = new Set<Listener<DataEvent>>();
  readonly #errorListeners = new Set<Listener<ErrorEvent>>();
  readonly #connectListeners = new Set<Listener<ConnectEvent>>();
  readonly #disconnectListeners = new Set<Listener<ConnectEvent>>();

  /** Scripts the next showPortPicker() outcome. */
  #pendingPick:
    | VirtualDevice
    | ((d: VirtualDevice) => boolean)
    | 'reject'
    | null = null;

  constructor(options: VirtualSerialOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0;
    this.#autoGrant = options.autoGrantPermission ?? true;
    for (const init of options.devices ?? []) this.addDevice(init);
  }

  // ── Device management ──────────────────────────────────────────────────────

  /** All devices known to the transport (attached or not). */
  get devices(): readonly VirtualDevice[] {
    return this.#devices;
  }

  /** Register a device. It starts attached but does not fire "connect". */
  addDevice(init: VirtualDeviceInit): VirtualDevice {
    const device = new VirtualDevice(this, this.#nextDeviceId++, init);
    this.#devices.push(device);
    return device;
  }

  /** Remove a device entirely; detaches it first if attached. */
  removeDevice(device: VirtualDevice): void {
    if (device.attached) this.detach(device);
    const i = this.#devices.indexOf(device);
    if (i >= 0) this.#devices.splice(i, 1);
  }

  /** (Re)attach a device, assigning it a fresh deviceId, and fire "connect". */
  attach(device: VirtualDevice): void {
    device.deviceId = this.#nextDeviceId++;
    device.attached = true;
    this.#emit(this.#connectListeners, {
      deviceId: device.deviceId,
      usbVendorId: device.usbVendorId,
      usbProductId: device.usbProductId,
    });
  }

  /** Detach a device and fire "disconnect"; any open port becomes closed. */
  detach(device: VirtualDevice): void {
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
  loseDevice(device: VirtualDevice): void {
    if (device.isOpen) this._error(device, 'Device disconnected');
    this.detach(device);
  }

  /** Script the next showPortPicker() resolution (a device or a predicate). */
  selectNextPort(
    target: VirtualDevice | ((d: VirtualDevice) => boolean),
  ): void {
    this.#pendingPick = target;
  }

  /** Make the next showPortPicker() reject (user cancelled / no port). */
  rejectNextPortPicker(): void {
    this.#pendingPick = 'reject';
  }

  // ── Internal event helpers (called by VirtualDevice) ───────────────────────

  /** @internal deliver inbound bytes to the host's readable stream. */
  _deliver(device: VirtualDevice, data: number[]): void {
    if (!device.attached || !device.isOpen || !device.reading) return;
    const event: DataEvent = {
      deviceId: device.deviceId,
      portNumber: device.portNumber,
      data,
    };
    this.#schedule(() => this.#emit(this.#dataListeners, event));
  }

  /** @internal raise a read error for a device's open port. */
  _error(device: VirtualDevice, message: string): void {
    const event: ErrorEvent = {
      deviceId: device.deviceId,
      portNumber: device.portNumber,
      error: message,
    };
    this.#schedule(() => this.#emit(this.#errorListeners, event));
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

    let chosen: VirtualDevice | undefined;
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
    this.#applyBehavior(device, bytes);
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
    return this.#resolve(this.#find(deviceId, portNumber)?.input.cts ?? false);
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

  #applyBehavior(device: VirtualDevice, bytes: number[]): void {
    const behavior = device.behavior;
    if (behavior === 'silent') return;
    if (behavior === 'echo') {
      this._deliver(device, bytes);
      return;
    }
    const frames = normalizeFrames(
      behavior(Uint8Array.from(bytes), {
        deviceId: device.deviceId,
        portNumber: device.portNumber,
        device,
      }),
    );
    for (const frame of frames) this._deliver(device, frame.map(toByte));
  }

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
    }
    return this.#resolve();
  }

  #toPortId = (d: VirtualDevice): PortId => ({
    deviceId: d.deviceId,
    portNumber: d.portNumber,
    usbVendorId: d.usbVendorId,
    usbProductId: d.usbProductId,
    hasPermission: d.hasPermission,
  });

  #matchesFilters(
    device: VirtualDevice,
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

  #find(deviceId: number, portNumber?: number): VirtualDevice | undefined {
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
