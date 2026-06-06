/**
 * SimulatedDevice — author a complete simulated serial peripheral.
 *
 * Extend the class and override the lifecycle hooks to model a real device's
 * whole behaviour (firmware/protocol): react to `open()`, to bytes the host
 * writes, to control-signal changes, and stream data back over time. It is
 * hosted by an {@link InMemorySerialTransport} ({@link ./virtual-serial}) and is
 * free of any `react-native` dependency, so the same device runs under Jest,
 * in a browser, and inside a React Native app on a device/emulator (for E2E).
 *
 * @example
 * class Thermometer extends SimulatedDevice {
 *   usbVendorId = 0x0403;
 *   usbProductId = 0x6001;
 *   #timer?: ReturnType<typeof setInterval>;
 *   onOpen() {
 *     this.#timer = setInterval(() => this.send(`${20 + Math.random()}C\r\n`), 1000);
 *   }
 *   onData(bytes) {                       // host wrote a command
 *     if (String.fromCharCode(...bytes).trim() === 'ID?') this.send('ACME-TEMP\r\n');
 *   }
 *   onClose() { clearInterval(this.#timer); }
 * }
 * transport.addDevice(new Thermometer(), {hasPermission: true});
 */
import type {OpenOptions} from '../transport';

/** The negotiated connection parameters (native parity code: 0 none/1 odd/2 even). */
export type SimulatedDeviceOpenOptions = Required<OpenOptions>;

/** Device-asserted input signals — what the host reads via getSignals(). */
export type SerialInputSignals = {
  dataCarrierDetect?: boolean;
  clearToSend?: boolean;
  ringIndicator?: boolean;
  dataSetReady?: boolean;
};

/** Host-asserted output signals (DTR/RTS/break) the device observes. */
export type HostSignals = {
  dataTerminalReady: boolean;
  requestToSend: boolean;
  break: boolean;
};

/**
 * The handle a {@link SimulatedDevice} uses to talk back to the host. Provided by
 * the transport; you normally use the `protected` helpers on `SimulatedDevice`
 * rather than this directly.
 */
export interface SimulatedDeviceHost {
  readonly deviceId: number;
  readonly portNumber: number;
  readonly isOpen: boolean;
  readonly openOptions: SimulatedDeviceOpenOptions | null;
  send(bytes: number[]): void;
  raiseError(message: string, name?: string): void;
  setSignals(signals: SerialInputSignals): void;
}

/** Coerce a payload into a byte array (string → char codes, & 0xff). */
export function toBytes(data: number[] | Uint8Array | string): number[] {
  if (typeof data === 'string') {
    return Array.from(data, c => c.charCodeAt(0) & 0xff);
  }
  if (data instanceof Uint8Array) return Array.from(data);
  return data.map(n => n & 0xff);
}

/**
 * Base class for a simulated serial peripheral. Override the `on*` hooks you
 * care about (all default to no-ops and may be async) and use the `protected`
 * helpers to drive the host.
 */
export abstract class SimulatedDevice {
  /** USB Vendor ID this device reports for enumeration. */
  abstract readonly usbVendorId: number;
  /** USB Product ID this device reports for enumeration. */
  abstract readonly usbProductId: number;
  /** Optional USB serial number. */
  readonly serialNumber?: string;

  #host: SimulatedDeviceHost | null = null;

  /** @internal Bind the transport host (called by InMemorySerialTransport). */
  _bind(host: SimulatedDeviceHost): void {
    this.#host = host;
  }

  /** Send bytes to the host (they appear on `port.readable`). */
  protected send(data: number[] | Uint8Array | string): void {
    this.#host?.send(toBytes(data));
  }

  /**
   * Raise a typed read error on the host's readable stream. `name` is the W3C
   * error type, e.g. "BreakError", "BufferOverrunError", "FramingError",
   * "ParityError" (defaults to "NetworkError").
   */
  protected raiseError(message: string, name?: string): void {
    this.#host?.raiseError(message, name);
  }

  /** Set device-asserted input signals (DCD/CTS/RI/DSR) the host can read. */
  protected setSignals(signals: SerialInputSignals): void {
    this.#host?.setSignals(signals);
  }

  /** The parameters the host opened the port with, or null when closed. */
  protected get openOptions(): SimulatedDeviceOpenOptions | null {
    return this.#host?.openOptions ?? null;
  }

  protected get deviceId(): number {
    return this.#host?.deviceId ?? -1;
  }

  protected get portNumber(): number {
    return this.#host?.portNumber ?? 0;
  }

  /** The host opened the port. */
  onOpen(_options: SimulatedDeviceOpenOptions): void | Promise<void> {}
  /** The host wrote bytes to the device. */
  onData(_data: Uint8Array): void | Promise<void> {}
  /** The host changed DTR/RTS/break. */
  onHostSignals(_signals: HostSignals): void | Promise<void> {}
  /** The host closed the port. */
  onClose(): void | Promise<void> {}
}

/** Optional USB identity for built-in devices. */
export type SimulatedDeviceIdentity = {
  usbVendorId?: number;
  usbProductId?: number;
  serialNumber?: string;
};

/** A loopback device: every byte written is echoed straight back. */
export class LoopbackDevice extends SimulatedDevice {
  readonly usbVendorId: number;
  readonly usbProductId: number;
  readonly serialNumber?: string;

  constructor(identity: SimulatedDeviceIdentity = {}) {
    super();
    this.usbVendorId = identity.usbVendorId ?? 0x0403;
    this.usbProductId = identity.usbProductId ?? 0x6001;
    this.serialNumber = identity.serialNumber;
  }

  onData(data: Uint8Array): void {
    this.send(data);
  }
}

/**
 * Base for a line-oriented command/response device: buffers incoming bytes and
 * calls {@link onLine} for each `\n`-terminated line (trailing CR/LF stripped).
 */
export abstract class LineBufferedDevice extends SimulatedDevice {
  #buffer = '';

  /** Handle one line received from the host. */
  abstract onLine(line: string): void | Promise<void>;

  onData(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.#buffer += String.fromCharCode(data[i]);
    }
    let nl = this.#buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.#buffer.slice(0, nl).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(nl + 1);
      void this.onLine(line);
      nl = this.#buffer.indexOf('\n');
    }
  }
}

/** A device that accepts writes but never sends anything back. */
export class SinkDevice extends SimulatedDevice {
  readonly usbVendorId: number;
  readonly usbProductId: number;
  readonly serialNumber?: string;

  constructor(identity: SimulatedDeviceIdentity = {}) {
    super();
    this.usbVendorId = identity.usbVendorId ?? 0x0403;
    this.usbProductId = identity.usbProductId ?? 0x6001;
    this.serialNumber = identity.serialNumber;
  }
}
