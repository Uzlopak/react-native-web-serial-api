import {
  ByteLengthQueuingStrategy,
  ReadableStream,
  WritableStream,
} from 'web-streams-polyfill';
import {DOMException} from './lib/dom-exception';
import {Event, EventTarget} from './lib/event-target';
import {createDeferredPromise} from './lib/promise';
import type {
  ConnectEvent,
  DataEvent,
  ErrorEvent,
  OpenOptions,
  PortId,
  UsbSerialModule,
} from './UsbSerial';
import {getUsbSerial} from './UsbSerial';

/**
 * @see https://wicg.github.io/serial/#dom-paritytype
 *
 * none - No parity bit is sent for each data word.
 * even - Data word plus parity bit has even parity.
 * odd - Data word plus parity bit has odd parity.
 */
type ParityType = 'none' | 'even' | 'odd';

/**
 * @see https://wicg.github.io/serial/#dom-flowcontroltype
 * none - No flow control is enabled.
 * hardware - Hardware flow control using the RTS and CTS signals is enabled.
 */
type FlowControlType = 'none' | 'hardware';

/**
 * @see https://wicg.github.io/serial/#dom-serialoptions
 */
export type SerialOptions = {
  /**
   * A positive, non-zero value indicating the baud rate at which serial
   * communication should be established.
   *
   * Note: baudRate is the only required member of this dictionary. While there
   * are common default for other connection parameters it is important for
   * developers to consider and consult with the documentation for devices they
   * intend to connect to determine the correct values. While some values are
   * common there is no standard baud rate. Requiring this parameter reduces the
   * potential for confusion if an arbitrary default were chosen by this
   * specification.
   */
  baudRate: number;
  /**
   * The number of data bits per frame. Either 7 or 8.
   */
  dataBits?: 7 | 8;
  /**
   * The number of stop bits at the end of a frame. Either 1 or 2.
   */
  stopBits?: 1 | 2;
  /**
   * The parity mode.
   */
  parity?: ParityType;
  /**
   * A positive, non-zero value indicating the size of the read and write
   * buffers that should be created.
   */
  bufferSize?: number;
  /**
   * The flow control mode.
   */
  flowControl?: FlowControlType;
};

/**
 * @see https://wicg.github.io/serial/#dom-serialoutputsignals
 */
export type SerialOutputSignals = {
  /**
   * Data Terminal Ready (DTR)
   */
  dataTerminalReady?: boolean;
  /**
   * Request To Send (RTS)
   */
  requestToSend?: boolean;
  /**
   * Break
   */
  break?: boolean;
};

/**
 * @see https://wicg.github.io/serial/#dom-serialinputsignals
 */
export type SerialInputSignals = {
  /**
   * Data Carrier Detect (DCD)
   */
  dataCarrierDetect: boolean;
  /**
   * Clear To Send (CTS)
   */
  clearToSend: boolean;
  /**
   * Ring Indicator (RI)
   */
  ringIndicator: boolean;
  /**
   * Data Set Ready (DSR)
   */
  dataSetReady: boolean;
};

/**
 * @see https://wicg.github.io/serial/#serialportinfo-dictionary
 */
export type SerialPortInfo =
  | {
      /** USB Vendor ID */
      usbVendorId: number;
      /** USB Product ID */
      usbProductId: number;
      bluetoothServiceClassId?: never;
    }
  | {
      usbVendorId?: never;
      usbProductId?: never;
      /** Bluetooth service class ID */
      bluetoothServiceClassId: number | string;
    };

/**
 * @see https://wicg.github.io/serial/#dom-serialportfilter
 */
export type SerialPortFilter = {
  /** USB Vendor ID */
  usbVendorId?: number;
  /** USB Product ID */
  usbProductId?: number;
  /** Bluetooth service class ID */
  bluetoothServiceClassId?: number | string;
};

/**
 * @see https://wicg.github.io/serial/#dom-serialportrequestoptions
 */
export type SerialPortRequestOptions = {
  /**
   * Filters for serial ports
   */
  filters?: SerialPortFilter[];
  /**
   * A list of BluetoothServiceUUID values representing Bluetooth service class
   * IDs. Bluetooth ports with custom service class IDs are excluded from the
   * list of ports presented to the user unless the service class ID is included
   * in this list.
   */
  allowedBluetoothServiceClassIds?: (number | string)[];
};

// Maps SerialPort instances to their deviceId — avoids exposing deviceId on
// the public type while still allowing Serial to access it for requestPermission
const serialPortDeviceIds = new WeakMap<SerialPort, number>();

// "Friend" channel: lets Serial match/update/reset a SerialPort across USB
// detach + re-attach (Android assigns a new deviceId on every attach) without
// widening the public SerialPort API. Each port registers a set of closures
// over its #private fields in its constructor.
type PortInternals = {
  getVid(): number | undefined;
  getPid(): number | undefined;
  getPortNumber(): number;
  getDeviceId(): number;
  setDeviceId(id: number): void;
  /** Reset to a closed, re-openable state after the device is physically lost. */
  handleDeviceLost(): void;
};
const portInternals = new WeakMap<SerialPort, PortInternals>();

const kDefaultDataBits = 8;
const kDefaultStopBits = 1;
const kDefaultParity: ParityType = 'none';
const kDefaultBufferSize = 255;
const kDefaultFlowControl: FlowControlType = 'none';

const kAcceptableDataBits = [7, 8] as const;
const kAcceptableStopBits = [1, 2] as const;
const kAcceptableParity: ParityType[] = ['none', 'even', 'odd'];

function parityToNative(parity: ParityType): number {
  switch (parity) {
    case 'odd':
      return 1;
    case 'even':
      return 2;
    default:
      return 0;
  }
}

function flowControlToNative(flowControl: FlowControlType): 'RTS_CTS' | 'NONE' {
  return flowControl === 'hardware' ? 'RTS_CTS' : 'NONE';
}

/**
 * Methods on this interface typically complete asynchronously, queuing work on
 * the serial port task source.
 *
 * The get the parent algorithm for SerialPort returns the same Serial instance
 * that is returned by the SerialPort's relevant global object's Navigator
 * object's serial getter.
 *
 * Instances of SerialPort are created with the internal slots described in the
 * following table:
 *
 * @see https://wicg.github.io/serial/#serialport-interface
 */
export class SerialPort extends EventTarget {
  #events = {
    connect: null as ((event: Event) => void) | null,
    disconnect: null as ((event: Event) => void) | null,
  };

  // Internal slots
  #state:
    | 'closed'
    | 'opening'
    | 'opened'
    | 'closing'
    | 'forgetting'
    | 'forgotten' = 'closed'; // [[state]] = "closed"
  #bufferSize: number | undefined = undefined; // [[bufferSize]] = undefined
  #connected: boolean = false; // [[connected]] = false
  #readable: ReadableStream<Uint8Array> | null = null; // [[readable]] = null
  #readFatal: boolean = false; // [[readFatal]] = false
  #writable: WritableStream<Uint8Array> | null = null; // [[writable]] = null
  #writeFatal: boolean = false; // [[writeFatal]] = false
  #pendingClosePromise: ReturnType<typeof createDeferredPromise<void>> | null =
    null; // [[pendingClosePromise]] = null

  #usb: UsbSerialModule;
  #deviceId: number;
  #portNumber: number;
  #usbVendorId?: number;
  #usbProductId?: number;

  // Tracks the current state of output signals for partial updates
  #outputSignals: Required<SerialOutputSignals> = {
    dataTerminalReady: false,
    requestToSend: false,
    break: false,
  };

  #dataSubscription: {remove: () => void} | null = null;
  #errorSubscription: {remove: () => void} | null = null;

  constructor(
    usb: UsbSerialModule,
    deviceId: number,
    portNumber: number,
    usbVendorId: number,
    usbProductId: number,
  ) {
    super();
    this.#usb = usb;
    this.#deviceId = deviceId;
    this.#portNumber = portNumber;
    serialPortDeviceIds.set(this, deviceId);
    this.#usbVendorId = usbVendorId;
    this.#usbProductId = usbProductId;

    // Expose a private control channel to Serial (see portInternals).
    portInternals.set(this, {
      getVid: () => this.#usbVendorId,
      getPid: () => this.#usbProductId,
      getPortNumber: () => this.#portNumber,
      getDeviceId: () => this.#deviceId,
      setDeviceId: (id: number) => {
        this.#deviceId = id;
        serialPortDeviceIds.set(this, id);
      },
      handleDeviceLost: () => this.#handleDeviceLost(),
    });
  }

  /**
   * Reset this port to a closed, re-openable state after the underlying USB
   * device has been physically removed. Unlike close(), this must NOT touch the
   * (now-gone) device — doing so would throw "USB get_status request failed".
   * After this, a later open() (e.g. when the device is re-attached) succeeds.
   */
  #handleDeviceLost(): void {
    // Tear down read/write streams without invoking the OS on the dead device.
    if (this.#readable) {
      this.#readFatal = true;
      try {
        // No active reader is required for cancel(); errors are non-fatal here.
        this.#readable.cancel().catch(() => {});
      } catch {}
    }
    if (this.#writable) {
      this.#writeFatal = true;
      try {
        this.#writable.abort().catch(() => {});
      } catch {}
    }
    this.#dataSubscription?.remove();
    this.#errorSubscription?.remove();
    this.#dataSubscription = null;
    this.#errorSubscription = null;

    this.#readable = null;
    this.#writable = null;
    this.#readFatal = false;
    this.#writeFatal = false;
    this.#pendingClosePromise = null;
    this.#bufferSize = undefined;
    this.#state = 'closed';
    this.#connected = false;

    this.dispatchEvent(new Event('disconnect'));
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-onconnect
   */
  get onconnect() {
    return this.#events.connect;
  }

  set onconnect(fn: ((event: Event) => void) | null) {
    if (this.#events.connect) {
      this.removeEventListener('connect', this.#events.connect);
    }
    if (fn !== null) {
      this.addEventListener('connect', fn);
      this.#events.connect = fn;
    } else {
      this.#events.connect = null;
    }
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-ondisconnect
   */
  get ondisconnect() {
    return this.#events.disconnect;
  }

  set ondisconnect(fn: ((event: Event) => void) | null) {
    if (this.#events.disconnect) {
      this.removeEventListener('disconnect', this.#events.disconnect);
    }
    if (fn !== null) {
      this.addEventListener('disconnect', fn);
      this.#events.disconnect = fn;
    } else {
      this.#events.disconnect = null;
    }
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-connected
   */
  get connected(): boolean {
    // The connected getter steps are:

    // 1. Return this.[[connected]].
    return this.#connected;
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-readable
   */
  get readable(): ReadableStream<Uint8Array> | null {
    // The readable getter steps are:

    // 1. If this.[[readable]] is not null, return this.[[readable]].
    if (this.#readable !== null) return this.#readable;

    // 2. If this.[[state]] is not "opened", return null.
    if (this.#state !== 'opened') return null;

    // 3. If this.[[readFatal]] is true, return null.
    if (this.#readFatal) return null;

    // 4. Let stream be a new ReadableStream.
    const self = this;
    const deviceId = this.#deviceId;
    const portNumber = this.#portNumber;
    const bufferSize = this.#bufferSize!;

    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          self.#dataSubscription = self.#usb.onData((event: DataEvent) => {
            if (
              event.deviceId === deviceId &&
              event.portNumber === portNumber
            ) {
              controller.enqueue(new Uint8Array(event.data));
            }
          });

          self.#errorSubscription = self.#usb.onError((event: ErrorEvent) => {
            if (
              event.deviceId === deviceId &&
              event.portNumber === portNumber
            ) {
              self.#readFatal = true; // Set this.[[readFatal]] to true.
              controller.error(new DOMException(event.error, 'NetworkError'));
              self.#handleClosingReadableStream();
            }
          });
        },
        async cancel() {
          // cancelAlgorithm: Invoke the operating system to discard the contents
          // of all software and hardware receive buffers for the port.
          await self.#usb
            .purgeHwBuffers(deviceId, portNumber, false, true)
            .catch(() => {});
          self.#handleClosingReadableStream();
        },
      },
      new ByteLengthQueuingStrategy({highWaterMark: bufferSize}),
    );

    // Set this.[[readable]] to stream.
    this.#readable = stream;

    // Return stream.
    return stream;
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-writable
   */
  get writable(): WritableStream<Uint8Array> | null {
    // The writable getter steps are:

    // 1. If this.[[writable]] is not null, return this.[[writable]].
    if (this.#writable !== null) return this.#writable;

    // 2. If this.[[state]] is not "opened", return null.
    if (this.#state !== 'opened') return null;

    // 3. If this.[[writeFatal]] is true, return null.
    if (this.#writeFatal) return null;

    // 4. Let stream be a new WritableStream.
    const self = this;
    const deviceId = this.#deviceId;
    const portNumber = this.#portNumber;
    const bufferSize = this.#bufferSize!;

    const stream = new WritableStream<Uint8Array>(
      {
        async write(chunk) {
          try {
            await self.#usb.write(deviceId, portNumber, Array.from(chunk));
          } catch (e) {
            // If the port was disconnected, set this.[[writeFatal]] to true.
            self.#writeFatal = true;
            self.#handleClosingWritableStream();
            throw new DOMException(
              `Write failed: ${(e as Error).message}`,
              'NetworkError',
            );
          }
        },
        async abort() {
          // abortAlgorithm: Invoke the operating system to discard the contents
          // of all software and hardware transmit buffers for the port.
          await self.#usb
            .purgeHwBuffers(deviceId, portNumber, true, false)
            .catch(() => {});
          self.#handleClosingWritableStream();
        },
        async close() {
          // closeAlgorithm: Invoke the operating system to flush the contents
          // of all software and hardware transmit buffers for the port.
          self.#handleClosingWritableStream();
        },
      },
      new ByteLengthQueuingStrategy({highWaterMark: bufferSize}),
    );

    // Set this.[[writable]] to stream.
    this.#writable = stream;

    // Return stream.
    return stream;
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-getinfo
   */
  getInfo(): SerialPortInfo {
    // The getInfo() method steps are:

    // 1. Let info be an empty ordered map.
    const info: SerialPortInfo = Object.create(null);

    // 2. If the port is part of a USB device, perform the following steps:
    if (this.#usbVendorId !== undefined) {
      // 1. Set info["usbVendorId"] to the vendor ID of the device.
      info.usbVendorId = this.#usbVendorId;
      // 2. Set info["usbProductId"] to the product ID of the device.
      info.usbProductId = this.#usbProductId;
    }

    // 3. If the port is a service on a Bluetooth device, perform the following steps:
    //   1. Set info["bluetoothServiceClassId"] to the service class UUID of the Bluetooth service.

    // 4. Return info.
    return info;
  }

  /**
   * Before communicating on a serial port it must be opened. Opening the port
   * allows the site to specify the necessary parameters which control how data
   * is transmitted and received. Developers should check the documentation for
   * the device they are connecting to for the appropriate parameters.
   *
   * await port.open({ baudRate: 115200 });
   *
   * Once open() has resolved the readable and writable attributes can be
   * accessed to get the ReadableStream and WritableStream instances for
   * receiving data from and sending data to the connected device.
   * @see https://wicg.github.io/serial/#dom-serialport-open
   */
  async open(options: SerialOptions): Promise<void> {
    // The open() method steps are:

    // 2. If this.[[state]] is not "closed", reject promise with an
    // "InvalidStateError" DOMException and return promise.
    if (this.#state !== 'closed') {
      throw new DOMException('The port is already open.', 'InvalidStateError');
    }

    // 3. If options["baudRate"] is 0, reject promise with a TypeError and
    // return promise.
    if (options.baudRate === 0) {
      throw new TypeError('baudRate must be a positive, non-zero value.');
    }

    // 4. If options["dataBits"] is not 7 or 8, reject promise with a TypeError
    // and return promise.
    const dataBits = options.dataBits ?? kDefaultDataBits;
    if (!kAcceptableDataBits.includes(dataBits)) {
      throw new TypeError('dataBits must be 7 or 8.');
    }

    // 5. If options["stopBits"] is not 1 or 2, reject promise with a TypeError
    // and return promise.
    const stopBits = options.stopBits ?? kDefaultStopBits;
    if (!kAcceptableStopBits.includes(stopBits)) {
      throw new TypeError('stopBits must be 1 or 2.');
    }

    // 6. If options["bufferSize"] is 0, reject promise with a TypeError and
    // return promise.
    const bufferSize = options.bufferSize ?? kDefaultBufferSize;
    if (bufferSize === 0) {
      throw new TypeError('bufferSize must be a positive, non-zero value.');
    }

    const parity = options.parity ?? kDefaultParity;
    if (!kAcceptableParity.includes(parity)) {
      throw new TypeError(
        `parity must be one of: ${kAcceptableParity.join(', ')}.`,
      );
    }

    const flowControl = options.flowControl ?? kDefaultFlowControl;

    // 8. Set this.[[state]] to "opening".
    this.#state = 'opening';

    // 9.1. Invoke the operating system to open the serial port using the
    // connection parameters.
    const nativeOptions: OpenOptions = {
      baudRate: options.baudRate,
      dataBits,
      stopBits,
      parity: parityToNative(parity),
    };

    try {
      await this.#usb.open(this.#deviceId, this.#portNumber, nativeOptions);
    } catch (e) {
      // 9.2. If this fails for any reason, reject promise with a "NetworkError"
      // DOMException and abort these steps.
      this.#state = 'closed';
      throw new DOMException(
        `Failed to open serial port: ${(e as Error).message}`,
        'NetworkError',
      );
    }

    if (flowControl !== 'none') {
      await this.#usb.setFlowControl(
        this.#deviceId,
        this.#portNumber,
        flowControlToNative(flowControl),
      );
    }

    this.#state = 'opened'; // 9.3. Set this.[[state]] to "opened".
    this.#bufferSize = bufferSize; // 9.4. Set this.[[bufferSize]] to options["bufferSize"].

    await this.#usb.startReading(this.#deviceId, this.#portNumber);

    // When the port becomes logically connected:
    this.#connected = true; // 2. Set port.[[connected]] to true.
    // NOTE: the port-level "connect"/"disconnect" events represent physical
    // device presence (attach/detach), dispatched by Serial from the native
    // USB state events — not logical open()/close(). So we do not dispatch them
    // here; that also avoids re-entrancy with auto-reconnect listeners.
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-close
   */
  async close(): Promise<void> {
    // The close() method steps are:

    // 2. If this.[[state]] is not "opened", reject promise with an
    // "InvalidStateError" DOMException and return promise.
    if (this.#state !== 'opened') {
      throw new DOMException('The port is not open.', 'InvalidStateError');
    }

    // 3. Let cancelPromise be the result of invoking cancel on this.[[readable]]
    // or a promise resolved with undefined if this.[[readable]] is null.
    const cancelPromise = this.#readable
      ? this.#readable.cancel().catch(() => {})
      : Promise.resolve();

    // 4. Let abortPromise be the result of invoking abort on this.[[writable]]
    // or a promise resolved with undefined if this.[[writable]] is null.
    const abortPromise = this.#writable
      ? this.#writable.abort().catch(() => {})
      : Promise.resolve();

    // 5. Let pendingClosePromise be a new promise.
    const pendingClosePromise = createDeferredPromise<void>();

    // 6. If this.[[readable]] and this.[[writable]] are null, resolve
    // pendingClosePromise with undefined.
    if (this.#readable === null && this.#writable === null) {
      pendingClosePromise.resolve();
    } else {
      // 7. Set this.[[pendingClosePromise]] to pendingClosePromise.
      this.#pendingClosePromise = pendingClosePromise;
    }

    // 9. Set this.[[state]] to "closing".
    this.#state = 'closing';

    // 8. Let combinedPromise be the result of getting a promise to wait for all
    // with «cancelPromise, abortPromise, pendingClosePromise».
    // 10. React to combinedPromise.
    await Promise.all([
      cancelPromise,
      abortPromise,
      pendingClosePromise.promise,
    ]);

    // 10.1.1. Invoke the operating system to close the serial port and release
    // any associated resources.
    try {
      await this.#usb.close(this.#deviceId, this.#portNumber);
    } catch {
      // ignore
    }

    this.#dataSubscription?.remove();
    this.#errorSubscription?.remove();
    this.#dataSubscription = null;
    this.#errorSubscription = null;

    this.#state = 'closed'; // 10.1.2. Set this.[[state]] to "closed".
    this.#readFatal = false; // 10.1.3. Set this.[[readFatal]] and this.[[writeFatal]] to false.
    this.#writeFatal = false; // 10.1.3. (continued)
    this.#pendingClosePromise = null; // 10.1.4. Set this.[[pendingClosePromise]] to null.

    // When the port is no longer logically connected:
    this.#connected = false; // 2. Set port.[[connected]] to false.
    // (No port-level "disconnect" dispatch here — that event signals physical
    // detach, fired by Serial from the native USB state events. See open().)
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-forget
   */
  async forget(): Promise<void> {
    // The forget() method steps are:

    // 2.1. Set this.[[state]] to "forgetting".
    this.#state = 'forgetting';
    // 2.2. Remove this from the sequence of serial ports on the system which
    // the user has allowed the site to access.
    // (no persistent permissions to revoke in this implementation)
    // 2.3. Set this.[[state]] to "forgotten".
    this.#state = 'forgotten';
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-setsignals
   */
  async setSignals(signals: SerialOutputSignals = {}): Promise<void> {
    // The setSignals() method steps are:

    // 2. If this.[[state]] is not "opened", reject promise with an
    // "InvalidStateError" DOMException and return promise.
    if (this.#state !== 'opened') {
      throw new DOMException('The port is not open.', 'InvalidStateError');
    }

    // 3. If all of the specified members of signals are not present, reject
    // promise with a TypeError and return promise.
    if (
      signals.dataTerminalReady === undefined &&
      signals.requestToSend === undefined &&
      signals.break === undefined
    ) {
      throw new TypeError('At least one signal must be specified.');
    }

    // Merge with current output signal state for partial updates
    this.#outputSignals = {...this.#outputSignals, ...signals};

    const promises: Promise<void>[] = [];

    // 4.1. If signals["dataTerminalReady"] is present, invoke the operating
    // system to either assert (if true) or deassert (if false) the "DTR" signal.
    if (signals.dataTerminalReady !== undefined) {
      promises.push(
        this.#usb.setDTR(
          this.#deviceId,
          this.#portNumber,
          signals.dataTerminalReady,
        ),
      );
    }

    // 4.2. If signals["requestToSend"] is present, invoke the operating system
    // to either assert (if true) or deassert (if false) the "RTS" signal.
    if (signals.requestToSend !== undefined) {
      promises.push(
        this.#usb.setRTS(
          this.#deviceId,
          this.#portNumber,
          signals.requestToSend,
        ),
      );
    }

    // 4.3. If signals["break"] is present, invoke the operating system to
    // either assert (if true) or deassert (if false) the "break" signal.
    if (signals.break !== undefined) {
      promises.push(
        this.#usb.setBreak(this.#deviceId, this.#portNumber, signals.break),
      );
    }

    try {
      await Promise.all(promises);
    } catch (e) {
      // 4.4. If the operating system fails to change the state of any of these
      // signals for any reason, reject promise with a "NetworkError" DOMException.
      throw new DOMException(
        `Failed to set signals: ${(e as Error).message}`,
        'NetworkError',
      );
    }
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serialport-getsignals
   */
  async getSignals(): Promise<SerialInputSignals> {
    // The getSignals() method steps are:

    // 2. If this.[[state]] is not "opened", reject promise with an
    // "InvalidStateError" DOMException and return promise.
    if (this.#state !== 'opened') {
      throw new DOMException('The port is not open.', 'InvalidStateError');
    }

    // 3. Query the operating system for the status of the control signals that
    // may be asserted by the device connected to the serial port.
    try {
      const [dcd, cts, ri, dsr] = await Promise.all([
        this.#usb.getCD(this.#deviceId, this.#portNumber), // 3.3. Let dataCarrierDetect be true if the "DCD" signal has been asserted by the device, and false otherwise.
        this.#usb.getCTS(this.#deviceId, this.#portNumber), // 3.4. Let clearToSend be true if the "CTS" signal has been asserted by the device, and false otherwise.
        this.#usb.getRI(this.#deviceId, this.#portNumber), // 3.5. Let ringIndicator be true if the "RI" signal has been asserted by the device, and false otherwise.
        this.#usb.getDSR(this.#deviceId, this.#portNumber), // 3.6. Let dataSetReady be true if the "DSR" signal has been asserted by the device, and false otherwise.
      ]);

      // 3.7. Let signals be the ordered map «[ "dataCarrierDetect" → dataCarrierDetect, "clearToSend" → clearToSend, "ringIndicator" → ringIndicator, "dataSetReady" → dataSetReady ]».
      return {
        dataCarrierDetect: dcd,
        clearToSend: cts,
        ringIndicator: ri,
        dataSetReady: dsr,
      };
    } catch (e) {
      // 3.2. If the operating system fails to determine the status of these
      // signals for any reason, reject promise with a "NetworkError" DOMException
      // and abort these steps.
      throw new DOMException(
        `Failed to get signals: ${(e as Error).message}`,
        'NetworkError',
      );
    }
  }

  /**
   * @see https://wicg.github.io/serial/#dfn-handle-closing-the-readable-stream
   */
  #handleClosingReadableStream(): void {
    // To handle closing the readable stream perform the following steps:

    // 1. Set this.[[readable]] to null.
    this.#readable = null;

    // 2. If this.[[writable]] is null and this.[[pendingClosePromise]] is not
    // null, resolve this.[[pendingClosePromise]] with undefined.
    if (this.#writable === null && this.#pendingClosePromise !== null) {
      this.#pendingClosePromise.resolve();
    }
  }

  /**
   * @see https://wicg.github.io/serial/#dfn-handle-closing-the-writable-stream
   */
  #handleClosingWritableStream(): void {
    // To handle closing the writable stream perform the following steps:

    // 1. Set this.[[writable]] to null.
    this.#writable = null;

    // 2. If this.[[readable]] is null and this.[[pendingClosePromise]] is not
    // null, resolve this.[[pendingClosePromise]] with undefined.
    if (this.#readable === null && this.#pendingClosePromise !== null) {
      this.#pendingClosePromise.resolve();
    }
  }
}

/**
 * @see https://wicg.github.io/serial/#serial-interface
 */
export class Serial extends EventTarget {
  #events = {
    connect: null as ((event: Event) => void) | null,
    disconnect: null as ((event: Event) => void) | null,
  };

  #usb: UsbSerialModule | null = null;
  #knownPorts: Map<string, SerialPort> = new Map();
  #initialized = false;

  /**
   * Lazily acquire the native USB-serial module and wire connect/disconnect
   * listeners on first use (getPorts/requestPort) rather than at construction.
   * Deferring native access out of the module-import path avoids touching the
   * TurboModule before the runtime is ready.
   */
  #ensureInit(): UsbSerialModule | null {
    if (this.#initialized) return this.#usb;
    this.#initialized = true;
    try {
      this.#usb = getUsbSerial();

      // A USB device was attached. Android assigns a NEW deviceId on every
      // attach, so match previously-known ports of the same physical device by
      // VID/PID, update their deviceId, re-key them, and fire "connect" on the
      // same SerialPort instance (W3C spec model: the port is reused).
      this.#usb.onConnect((event: ConnectEvent) => {
        let matched = false;
        for (const [key, port] of [...this.#knownPorts.entries()]) {
          const internals = portInternals.get(port);
          if (!internals) continue;
          if (
            internals.getVid() === event.usbVendorId &&
            internals.getPid() === event.usbProductId
          ) {
            internals.setDeviceId(event.deviceId);
            const newKey = this.#portKey(
              event.deviceId,
              internals.getPortNumber(),
            );
            if (newKey !== key) {
              this.#knownPorts.delete(key);
              this.#knownPorts.set(newKey, port);
            }
            port.dispatchEvent(new Event('connect'));
            matched = true;
          }
        }
        this.dispatchEvent(new Event('connect'));
        // If we matched no known port this is a brand-new device; getPorts()
        // will surface it on the next refresh.
        void matched;
      });

      // A USB device was detached. Reset the matching port(s) to a closed,
      // re-openable state (without touching the gone device) but KEEP the
      // SerialPort instance so a re-attach can reuse it. handleDeviceLost()
      // dispatches "disconnect" on the port.
      this.#usb.onDisconnect((event: ConnectEvent) => {
        const prefix = `${event.deviceId}:`;
        for (const [key, port] of [...this.#knownPorts.entries()]) {
          if (key.startsWith(prefix)) {
            portInternals.get(port)?.handleDeviceLost();
          }
        }
        this.dispatchEvent(new Event('disconnect'));
      });
    } catch {
      this.#usb = null;
    }
    return this.#usb;
  }
  /**
   * @see https://wicg.github.io/serial/#dom-serial-onconnect
   */
  get onconnect() {
    return this.#events.connect;
  }

  set onconnect(fn: ((event: Event) => void) | null) {
    if (this.#events.connect) {
      this.removeEventListener('connect', this.#events.connect);
    }
    if (fn !== null) {
      this.addEventListener('connect', fn);
      this.#events.connect = fn;
    } else {
      this.#events.connect = null;
    }
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serial-ondisconnect
   */
  get ondisconnect() {
    return this.#events.disconnect;
  }

  set ondisconnect(fn: ((event: Event) => void) | null) {
    if (this.#events.disconnect) {
      this.removeEventListener('disconnect', this.#events.disconnect);
    }
    if (fn !== null) {
      this.addEventListener('disconnect', fn);
      this.#events.disconnect = fn;
    } else {
      this.#events.disconnect = null;
    }
  }

  #portKey(deviceId: number, portNumber: number): string {
    return `${deviceId}:${portNumber}`;
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serial-getports
   */
  async getPorts(): Promise<SerialPort[]> {
    // The getPorts() method steps are:

    const usb = this.#ensureInit();
    if (!usb) return []; // Native module not available

    // 3.1. Let availablePorts be the sequence of available serial ports which
    // the user has allowed the site to access as the result of a previous call
    // to requestPort().
    // Modification for Android: availablePorts is the sequence of all
    // USB-serial ports the app has permission to access, which includes ports
    // previously granted via requestPort() AND ports the app was granted native
    // permission for (e.g. "use by default for this device" attach dialog).
    const portIds = await usb.findAllDrivers();

    // 3.2. Let ports be the sequence of the SerialPorts representing the ports
    // in availablePorts.
    const ports: SerialPort[] = [];
    for (const {
      deviceId,
      portNumber,
      usbVendorId,
      usbProductId,
      hasPermission,
    } of portIds) {
      if (!hasPermission) continue;
      const key = this.#portKey(deviceId, portNumber);
      if (!this.#knownPorts.has(key)) {
        this.#knownPorts.set(
          key,
          new SerialPort(usb, deviceId, portNumber, usbVendorId, usbProductId),
        );
      }
      ports.push(this.#knownPorts.get(key)!);
    }

    // 3.3. Resolve promise with ports.
    return ports;
  }

  /**
   * @see https://wicg.github.io/serial/#dom-serial-requestport
   */
  async requestPort(
    options: SerialPortRequestOptions = {},
  ): Promise<SerialPort> {
    // The requestPort() method steps are:

    const usb = this.#ensureInit();
    if (!usb) {
      throw new DOMException(
        'NativeUsbSerial is not available.',
        'NotFoundError',
      );
    }

    // 4. If options["filters"] is present, then for each filter in
    // options["filters"] run the following steps:
    if (options.filters) {
      for (const filter of options.filters) {
        if (filter.bluetoothServiceClassId !== undefined) {
          // 4.1.1. If filter["usbVendorId"] is present, reject promise with a
          // TypeError and return promise.
          if (filter.usbVendorId !== undefined) {
            throw new TypeError(
              'A filter cannot specify both bluetoothServiceClassId and usbVendorId.',
            );
          }
          // 4.1.2. If filter["usbProductId"] is present, reject promise with a
          // TypeError and return promise.
          if (filter.usbProductId !== undefined) {
            throw new TypeError(
              'A filter cannot specify both bluetoothServiceClassId and usbProductId.',
            );
          }
        } else if (filter.usbVendorId === undefined) {
          // 4.2. If filter["usbVendorId"] is not present, reject promise with a
          // TypeError and return promise.
          throw new TypeError(
            'A filter must specify usbVendorId if usbProductId is specified, or must not be empty.',
          );
        }
      }
    }

    // 5.4. Prompt the user to grant the site access to a serial port —
    // shows a native Android dialog with available ports filtered by
    // options["filters"] and requests USB permission for the selected port.
    const nativeFilters = (options.filters ?? [])
      .filter(f => f.usbVendorId !== undefined)
      .map(f => ({usbVendorId: f.usbVendorId, usbProductId: f.usbProductId}));

    let portId: PortId;
    try {
      portId = await usb.showPortPicker(nativeFilters);
    } catch {
      // 5.5. If the user does not choose a port, reject promise with a
      // "NotFoundError" DOMException and abort these steps.
      throw new DOMException('No port selected by the user.', 'NotFoundError');
    }

    // 5.6. Let port be a SerialPort representing the port chosen by the user.
    const key = `${portId.deviceId}:${portId.portNumber}`;
    if (!this.#knownPorts.has(key)) {
      this.#knownPorts.set(
        key,
        new SerialPort(
          usb,
          portId.deviceId,
          portId.portNumber,
          portId.usbVendorId,
          portId.usbProductId,
        ),
      );
    }

    // 5.7. Resolve promise with port.
    return this.#knownPorts.get(key)!;
  }
}

export const serial = new Serial();
