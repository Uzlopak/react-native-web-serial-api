/**
 * Remote-serial-over-WebSocket entry point.
 *
 *   import {WebSocketSerialTransport}
 *     from 'react-native-web-serial-api/websocket';
 *
 * Client side only — the Node bridge that backs it is shipped as the
 * `expose-serial-websocket` binary (see `bin/expose-serial.js`). The wire
 * protocol is in {@link ./protocol}; the bridge core in {@link ./bridge}.
 */

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
export type {
  WebSocketCtor,
  WebSocketLike,
  WebSocketSerialOptions,
} from './WebSocketSerialTransport';
export {WebSocketSerialTransport} from './WebSocketSerialTransport';
