export {default as serial} from './serial';
export type {SerialTransport} from './transport';
export {resetUsbSerial, setUsbSerial} from './UsbSerial';
export type {
  SerialInputSignals,
  SerialOptions,
  SerialOutputSignals,
  SerialPortFilter,
  SerialPortInfo,
  SerialPortRequestOptions,
} from './WebSerial';
// W3C Web Serial API classes
export {Serial, SerialPort} from './WebSerial';

import * as UsbSerial from './UsbSerial';

export {
  EventImpl as Event,
  EventTargetImpl as EventTarget,
} from './lib/event-target';
export {UsbSerial};
