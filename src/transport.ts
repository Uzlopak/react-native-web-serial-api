/**
 * Hardware-transport seam for the Web Serial polyfill.
 *
 * `SerialTransport` is the single interface that the `Serial`/`SerialPort`
 * classes depend on to talk to "the device". The production implementation
 * (`UsbSerialModule`, backed by the `NativeUsbSerial` TurboModule — see
 * {@link ./UsbSerial}) and the in-memory test/dev double
 * (`InMemorySerialTransport` — see {@link ./testing/in-memory-serial-transport}) both
 * implement it.
 *
 * This module is intentionally free of any `react-native` import. That is what
 * lets the virtual transport — and therefore the conformance suite built on top
 * of it — run unchanged under Node/Jest, in a browser, and on a device.
 */

// UsbSerialPort.ControlLine enum
export type ControlLine = 'RTS' | 'CTS' | 'DTR' | 'DSR' | 'CD' | 'RI';

// UsbSerialPort.FlowControl enum
export type FlowControl =
  | 'NONE'
  | 'RTS_CTS'
  | 'DTR_DSR'
  | 'XON_XOFF'
  | 'XON_XOFF_INLINE';

export type PortFilter = {
  usbVendorId?: number;
  usbProductId?: number;
};

export type PortPickerLabels = {
  titleSelectPort?: string;
  titleNoPortsAvailable?: string;
  messageNoPortsAvailable?: string;
};

export type PortId = {
  deviceId: number;
  portNumber: number;
  usbVendorId: number;
  usbProductId: number;
  /**
   * Whether the app currently holds Android USB permission to access this
   * device (via the system attach dialog or a prior permission request).
   */
  hasPermission: boolean;
};

export type DataEvent = {
  deviceId: number;
  portNumber: number;
  data: number[];
};

export type ErrorEvent = {
  deviceId: number;
  portNumber: number;
  error: string;
  /**
   * Optional spec error name (e.g. "BreakError", "BufferOverrunError",
   * "FramingError", "ParityError") for a typed read error. When present the
   * polyfill surfaces a DOMException of that name on the readable stream
   * (otherwise it defaults to "NetworkError"); the WPT-derived spec tests in
   * src/__tests__/conformance-suite.ts exercise this (BreakError,
   * BufferOverrunError).
   */
  errorName?: string;
};

export type ConnectEvent = {
  deviceId: number;
  usbVendorId: number;
  usbProductId: number;
};

export const Parity = {
  NONE: 0,
  ODD: 1,
  EVEN: 2,
  MARK: 3,
  SPACE: 4,
} as const;

export const DataBits = {
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
} as const;

export const StopBits = {
  ONE: 1,
  ONE_FIVE: 3,
  TWO: 2,
} as const;

export type OpenOptions = {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: number;
};

export const DEFAULT_OPEN_OPTIONS: Required<Omit<OpenOptions, 'baudRate'>> = {
  dataBits: DataBits.EIGHT,
  stopBits: StopBits.ONE,
  parity: Parity.NONE,
};

/** Handle returned by the `on*` subscription methods. */
export type Subscription = {remove: () => void};

/**
 * The contract every serial transport must satisfy. It mirrors the JS-friendly
 * surface of `UsbSerialModule` exactly, so `UsbSerialModule implements
 * SerialTransport` is a faithful 1:1 and any conforming double (e.g.
 * `InMemorySerialTransport`) is a drop-in replacement.
 *
 * Ports are addressed by the pair `(deviceId, portNumber)`. Inbound bytes,
 * read errors and device attach/detach arrive through the `on*` subscriptions.
 */
export interface SerialTransport {
  // Discovery & permission
  findAllDrivers(): Promise<ReadonlyArray<PortId>>;
  showPortPicker(
    filter: ReadonlyArray<PortFilter>,
    labels?: PortPickerLabels,
  ): Promise<PortId>;
  requestPermission(deviceId: number): Promise<boolean>;

  // Lifecycle
  open(
    deviceId: number,
    portNumber: number,
    options: OpenOptions,
  ): Promise<void>;
  close(deviceId: number, portNumber: number): Promise<void>;
  isOpen(deviceId: number, portNumber: number): boolean;

  // I/O
  write(
    deviceId: number,
    portNumber: number,
    data: number[],
    timeout?: number,
  ): Promise<void>;
  startReading(deviceId: number, portNumber: number): Promise<void>;
  stopReading(deviceId: number, portNumber: number): Promise<void>;

  // Parameters
  setParameters(
    deviceId: number,
    portNumber: number,
    options: OpenOptions,
  ): Promise<void>;

  // Control signals
  setDTR(deviceId: number, portNumber: number, value: boolean): Promise<void>;
  setRTS(deviceId: number, portNumber: number, value: boolean): Promise<void>;
  getDTR(deviceId: number, portNumber: number): Promise<boolean>;
  getRTS(deviceId: number, portNumber: number): Promise<boolean>;
  getCD(deviceId: number, portNumber: number): Promise<boolean>;
  getCTS(deviceId: number, portNumber: number): Promise<boolean>;
  getDSR(deviceId: number, portNumber: number): Promise<boolean>;
  getRI(deviceId: number, portNumber: number): Promise<boolean>;
  getControlLines(deviceId: number, portNumber: number): Promise<ControlLine[]>;
  getSupportedControlLines(
    deviceId: number,
    portNumber: number,
  ): Promise<ControlLine[]>;

  // Flow control
  setFlowControl(
    deviceId: number,
    portNumber: number,
    flowControl: FlowControl,
  ): Promise<void>;
  getFlowControl(deviceId: number, portNumber: number): Promise<FlowControl>;
  getSupportedFlowControl(
    deviceId: number,
    portNumber: number,
  ): Promise<FlowControl[]>;

  // Misc
  setBreak(deviceId: number, portNumber: number, value: boolean): Promise<void>;
  purgeHwBuffers(
    deviceId: number,
    portNumber: number,
    purgeWriteBuffers: boolean,
    purgeReadBuffers: boolean,
  ): Promise<void>;
  getSerial(deviceId: number, portNumber: number): Promise<string>;

  // Event subscriptions
  onData(listener: (event: DataEvent) => void): Subscription;
  onError(listener: (event: ErrorEvent) => void): Subscription;
  onConnect(listener: (event: ConnectEvent) => void): Subscription;
  onDisconnect(listener: (event: ConnectEvent) => void): Subscription;
}
