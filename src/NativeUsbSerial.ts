import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

// UsbSerialPort.ControlLine enum
export type ControlLine = 'RTS' | 'CTS' | 'DTR' | 'DSR' | 'CD' | 'RI';

// UsbSerialPort.FlowControl enum
export type FlowControl =
  | 'NONE'
  | 'RTS_CTS'
  | 'DTR_DSR'
  | 'XON_XOFF'
  | 'XON_XOFF_INLINE';

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

export type PortPickerLabels = {
  titleSelectPort?: string;
  titleNoPortsAvailable?: string;
  messageNoPortsAvailable?: string;
};

export type PortFilter = {
  usbVendorId?: number;
  usbProductId?: number;
};

export interface Spec extends TurboModule {
  // UsbSerialProber
  findAllDrivers(): Promise<ReadonlyArray<PortId>>;

  // Port picker dialog — shows available ports filtered by filters, requests permission for selected port
  showPortPicker(
    filters: ReadonlyArray<PortFilter>,
    labels?: PortPickerLabels,
  ): Promise<PortId>;

  // UsbSerialPort lifecycle
  open(
    deviceId: number,
    portNumber: number,
    baudRate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
  ): Promise<void>;
  close(deviceId: number, portNumber: number): Promise<void>;
  isOpen(deviceId: number, portNumber: number): boolean;

  // Read/Write
  write(
    deviceId: number,
    portNumber: number,
    data: ReadonlyArray<number>,
    timeout: number,
  ): Promise<void>;
  startReading(deviceId: number, portNumber: number): Promise<void>;
  stopReading(deviceId: number, portNumber: number): Promise<void>;

  // Parameters
  setParameters(
    deviceId: number,
    portNumber: number,
    baudRate: number,
    dataBits: number,
    stopBits: number,
    parity: number,
  ): Promise<void>;

  // Control lines
  setDTR(deviceId: number, portNumber: number, value: boolean): Promise<void>;
  setRTS(deviceId: number, portNumber: number, value: boolean): Promise<void>;
  getDTR(deviceId: number, portNumber: number): Promise<boolean>;
  getRTS(deviceId: number, portNumber: number): Promise<boolean>;
  getCD(deviceId: number, portNumber: number): Promise<boolean>;
  getCTS(deviceId: number, portNumber: number): Promise<boolean>;
  getDSR(deviceId: number, portNumber: number): Promise<boolean>;
  getRI(deviceId: number, portNumber: number): Promise<boolean>;

  getControlLines(
    deviceId: number,
    portNumber: number,
  ): Promise<ReadonlyArray<string>>;
  getSupportedControlLines(
    deviceId: number,
    portNumber: number,
  ): Promise<ReadonlyArray<string>>;

  // Flow control
  setFlowControl(
    deviceId: number,
    portNumber: number,
    flowControl: string,
  ): Promise<void>;
  getFlowControl(deviceId: number, portNumber: number): Promise<string>;
  getSupportedFlowControl(
    deviceId: number,
    portNumber: number,
  ): Promise<ReadonlyArray<string>>;

  // Misc
  setBreak(deviceId: number, portNumber: number, value: boolean): Promise<void>;
  purgeHwBuffers(
    deviceId: number,
    portNumber: number,
    purgeWriteBuffers: boolean,
    purgeReadBuffers: boolean,
  ): Promise<void>;
  getSerial(deviceId: number, portNumber: number): Promise<string>;

  // USB permission
  requestPermission(deviceId: number): Promise<boolean>;

  // NativeEventEmitter
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('NativeUsbSerial');
