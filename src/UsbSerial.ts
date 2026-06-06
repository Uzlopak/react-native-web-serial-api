import {NativeEventEmitter, NativeModules} from 'react-native';
import NativeUsbSerial from './NativeUsbSerial';
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
} from './transport';
import {DEFAULT_OPEN_OPTIONS} from './transport';

// These types and enums were originally declared in this module and form part
// of the public `UsbSerial` namespace. They now live in ./transport (a
// react-native-free module the virtual transport also builds on) and are
// re-exported here unchanged for backwards compatibility.
export type {
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
} from './transport';
export {DataBits, Parity, StopBits} from './transport';

export class UsbSerialModule implements SerialTransport {
  private readonly native: NonNullable<typeof NativeUsbSerial>;
  private readonly emitter: NativeEventEmitter;

  constructor() {
    if (!NativeUsbSerial) {
      throw new Error('NativeUsbSerial is not available');
    }
    this.native = NativeUsbSerial;
    this.emitter = new NativeEventEmitter(NativeModules.NativeUsbSerial);
  }

  findAllDrivers(): Promise<ReadonlyArray<PortId>> {
    return this.native.findAllDrivers() as Promise<ReadonlyArray<PortId>>;
  }

  showPortPicker(
    filter: Readonly<PortFilter[]>,
    labels?: PortPickerLabels,
  ): Promise<PortId> {
    return this.native.showPortPicker(filter, labels) as Promise<PortId>;
  }

  requestPermission(deviceId: number): Promise<boolean> {
    return this.native.requestPermission(deviceId);
  }

  open(
    deviceId: number,
    portNumber: number,
    options: OpenOptions,
  ): Promise<void> {
    const opts = {...DEFAULT_OPEN_OPTIONS, ...options};
    return this.native.open(
      deviceId,
      portNumber,
      opts.baudRate,
      opts.dataBits,
      opts.stopBits,
      opts.parity,
    );
  }

  close(deviceId: number, portNumber: number): Promise<void> {
    return this.native.close(deviceId, portNumber);
  }

  isOpen(deviceId: number, portNumber: number): boolean {
    return this.native.isOpen(deviceId, portNumber);
  }

  write(
    deviceId: number,
    portNumber: number,
    data: number[],
    timeout: number = 2000,
  ): Promise<void> {
    return this.native.write(deviceId, portNumber, data, timeout);
  }

  startReading(deviceId: number, portNumber: number): Promise<void> {
    return this.native.startReading(deviceId, portNumber);
  }

  stopReading(deviceId: number, portNumber: number): Promise<void> {
    return this.native.stopReading(deviceId, portNumber);
  }

  setParameters(
    deviceId: number,
    portNumber: number,
    options: OpenOptions,
  ): Promise<void> {
    const opts = {...DEFAULT_OPEN_OPTIONS, ...options};
    return this.native.setParameters(
      deviceId,
      portNumber,
      opts.baudRate,
      opts.dataBits,
      opts.stopBits,
      opts.parity,
    );
  }

  setDTR(deviceId: number, portNumber: number, value: boolean): Promise<void> {
    return this.native.setDTR(deviceId, portNumber, value);
  }

  setRTS(deviceId: number, portNumber: number, value: boolean): Promise<void> {
    return this.native.setRTS(deviceId, portNumber, value);
  }

  getDTR(deviceId: number, portNumber: number): Promise<boolean> {
    return this.native.getDTR(deviceId, portNumber);
  }

  getRTS(deviceId: number, portNumber: number): Promise<boolean> {
    return this.native.getRTS(deviceId, portNumber);
  }

  getCD(deviceId: number, portNumber: number): Promise<boolean> {
    return this.native.getCD(deviceId, portNumber);
  }

  getCTS(deviceId: number, portNumber: number): Promise<boolean> {
    return this.native.getCTS(deviceId, portNumber);
  }

  getDSR(deviceId: number, portNumber: number): Promise<boolean> {
    return this.native.getDSR(deviceId, portNumber);
  }

  getRI(deviceId: number, portNumber: number): Promise<boolean> {
    return this.native.getRI(deviceId, portNumber);
  }

  getControlLines(
    deviceId: number,
    portNumber: number,
  ): Promise<ControlLine[]> {
    return this.native.getControlLines(deviceId, portNumber) as Promise<
      ControlLine[]
    >;
  }

  getSupportedControlLines(
    deviceId: number,
    portNumber: number,
  ): Promise<ControlLine[]> {
    return this.native.getSupportedControlLines(
      deviceId,
      portNumber,
    ) as Promise<ControlLine[]>;
  }

  setFlowControl(
    deviceId: number,
    portNumber: number,
    flowControl: FlowControl,
  ): Promise<void> {
    return this.native.setFlowControl(deviceId, portNumber, flowControl);
  }

  getFlowControl(deviceId: number, portNumber: number): Promise<FlowControl> {
    return this.native.getFlowControl(
      deviceId,
      portNumber,
    ) as Promise<FlowControl>;
  }

  getSupportedFlowControl(
    deviceId: number,
    portNumber: number,
  ): Promise<FlowControl[]> {
    return this.native.getSupportedFlowControl(deviceId, portNumber) as Promise<
      FlowControl[]
    >;
  }

  setBreak(
    deviceId: number,
    portNumber: number,
    value: boolean,
  ): Promise<void> {
    return this.native.setBreak(deviceId, portNumber, value);
  }

  purgeHwBuffers(
    deviceId: number,
    portNumber: number,
    purgeWriteBuffers: boolean,
    purgeReadBuffers: boolean,
  ): Promise<void> {
    return this.native.purgeHwBuffers(
      deviceId,
      portNumber,
      purgeWriteBuffers,
      purgeReadBuffers,
    );
  }

  getSerial(deviceId: number, portNumber: number): Promise<string> {
    return this.native.getSerial(deviceId, portNumber);
  }

  onData(listener: (event: DataEvent) => void): Subscription {
    return this.emitter.addListener(
      'data',
      listener as (...args: readonly Record<string, unknown>[]) => unknown,
    );
  }

  onError(listener: (event: ErrorEvent) => void): Subscription {
    return this.emitter.addListener(
      'error',
      listener as (...args: readonly Record<string, unknown>[]) => unknown,
    );
  }

  onConnect(listener: (event: ConnectEvent) => void): Subscription {
    return this.emitter.addListener(
      'connect',
      listener as (...args: readonly Record<string, unknown>[]) => unknown,
    );
  }

  onDisconnect(listener: (event: ConnectEvent) => void): Subscription {
    return this.emitter.addListener(
      'disconnect',
      listener as (...args: readonly Record<string, unknown>[]) => unknown,
    );
  }
}

let instance: SerialTransport | null = null;
let override: SerialTransport | null = null;

/**
 * Resolve the active serial transport. Returns the override set via
 * {@link setUsbSerial} if present (used by tests and by the example's on-device
 * "virtual device" mode); otherwise lazily constructs the real native-backed
 * {@link UsbSerialModule}.
 */
export function getUsbSerial(): SerialTransport {
  if (override) return override;
  if (!instance) {
    instance = new UsbSerialModule();
  }
  return instance;
}

/**
 * Override the transport returned by {@link getUsbSerial}. Pass a
 * {@link SerialTransport} (e.g. an `InMemorySerialTransport`) to make the
 * singleton `serial` instance — and any `new Serial()` created without an
 * explicit transport — talk to it instead of real hardware. Pass `null` to
 * clear the override.
 *
 * Inject before the first `getPorts()` / `requestPort()` / `addEventListener()`
 * call so the lazy initialisation in `Serial` picks it up.
 */
export function setUsbSerial(transport: SerialTransport | null): void {
  override = transport;
}

/** Clear any override and drop the cached native instance (test teardown). */
export function resetUsbSerial(): void {
  override = null;
  instance = null;
}
