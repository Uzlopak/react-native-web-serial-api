/**
 * Remote-serial-over-WebSocket entry point.
 *
 *   import {WebSocketSerialTransport}
 *     from 'react-native-web-serial-api/websocket';
 *
 * Client side: `WebSocketSerialTransport` connects an app to a remote serial
 * port. Server side: {@link attachBridge} pipes a WebSocket to a serial port,
 * and {@link serialDeviceToSerialLike} lets that "serial port" be an in-memory
 * {@link SerialDevice} simulator (used by `testing/exposeSerialDevice`). The
 * wire protocol is in {@link ./protocol}; the bridge core in {@link ./bridge}.
 */

// The bridge core + the in-memory device adapter, so a test can expose a
// SerialDevice simulator over a WebSocket (see testing/exposeSerialDevice).
export type {BridgeOptions, SerialLike, WsLike} from './bridge';
export {attachBridge} from './bridge';
export type {
  CommandMessage,
  CommandName,
  ControlMessage,
  EventMessage,
  InputSignals,
  LineCoding,
  Parity,
  PortInfo,
  ResponseMessage,
} from './protocol';
export {
  portInfoFromDevice,
  serialDeviceToSerialLike,
} from './serial-device-bridge';
export type {
  WebSocketCtor,
  WebSocketLike,
  WebSocketSerialOptions,
} from './WebSocketSerialTransport';
export {WebSocketSerialTransport} from './WebSocketSerialTransport';
