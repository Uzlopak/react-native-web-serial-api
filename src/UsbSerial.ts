import {NativeEventEmitter, NativeModules} from 'react-native';
import NativeUsbSerial from './NativeUsbSerial';

export type ControlLine = 'RTS' | 'CTS' | 'DTR' | 'DSR' | 'CD' | 'RI';
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

const DEFAULT_OPEN_OPTIONS: Required<Omit<OpenOptions, 'baudRate'>> = {
  dataBits: DataBits.EIGHT,
  stopBits: StopBits.ONE,
  parity: Parity.NONE,
};

type Subscription = {remove: () => void};

export class UsbSerialModule {
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

let instance: UsbSerialModule | null = null;

export function getUsbSerial(): UsbSerialModule {
  if (!instance) {
    instance = new UsbSerialModule();
  }
  return instance;
}
