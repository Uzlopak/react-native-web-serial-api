// Platform-resolved Web Serial API instance.
// On React Native (Android) this is the USB-serial-backed polyfill; on web it
// is the browser's native navigator.serial. (See serial.android.ts / serial.web.ts)
export {default as serial} from './serial';
// Transport seam (advanced). Implement `SerialTransport` to back the polyfill
// with something other than real hardware, then inject it via `new
// Serial(transport)` or globally with `setUsbSerial(transport)`. The ready-made
// in-memory double + conformance suite live in the `react-native-web-serial-api/testing`
// subpath so they stay out of the main bundle.
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

// Lower-level access to the raw USB-serial TurboModule (Android only).
// (Imported + re-exported rather than `export * as` so older Babel presets
// without @babel/plugin-transform-export-namespace-from can consume the source.)
import * as UsbSerial from './UsbSerial';

// Web Serial API event/exception primitives used by the polyfill
export {Event, EventTarget} from './lib/event-target';
export {UsbSerial};
