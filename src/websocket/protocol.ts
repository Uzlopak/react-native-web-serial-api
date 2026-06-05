/**
 * Wire protocol shared by the WebSocket serial bridge (Node, see
 * {@link ./bridge}) and the client transport ({@link ./WebSocketSerialTransport}).
 *
 * A single WebSocket carries two kinds of frame:
 *   - **binary** frames are raw serial bytes (client→bridge = data to write to the
 *     port; bridge→client = data read from the port), and
 *   - **text** frames are JSON control messages (this module).
 *
 * Control flow is request/response: the client tags each {@link CommandMessage}
 * with an incrementing `id` and the bridge replies with a {@link ResponseMessage}
 * carrying the same `id`. The bridge may also push unsolicited
 * {@link EventMessage}s (port open/close/error).
 */

/** Serial parity, mirroring the `serialport` package's string values. */
export type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space';

/** Connection parameters for `setLineCoding`. */
export type LineCoding = {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: Parity;
};

/** Input control-signal state returned by `getSignals`. */
export type InputSignals = {
  cts: boolean;
  dsr: boolean;
  dcd: boolean;
  ri: boolean;
};

/** Optional serial-port metadata returned by `getPortInfo`. */
export type PortInfo = {
  usbVendorId?: number;
  usbProductId?: number;
  serialNumber?: string;
};

/** Every control command the bridge understands. */
export type CommandName =
  | 'setLineCoding'
  | 'setBaudRate'
  | 'setSignals'
  | 'getSignals'
  | 'getPortInfo'
  | 'startReading'
  | 'stopReading'
  | 'flush'
  | 'drain'
  | 'break'
  | 'close';

/** client → bridge */
export type CommandMessage = {
  type: 'command';
  id: number;
  command: CommandName;
  args?: Record<string, unknown>;
};

/** bridge → client, answering a {@link CommandMessage} with the same `id`. */
export type ResponseMessage = {
  type: 'response';
  id: number;
  error: string | null;
  result?: unknown;
};

/** An unsolicited port lifecycle event the bridge emits to the client. */
export type BridgeEventName = 'open' | 'close' | 'error';

/** bridge → client */
export type EventMessage = {
  type: 'event';
  event: BridgeEventName;
  error?: string;
};

export type ControlMessage = CommandMessage | ResponseMessage | EventMessage;

/** Parse a text frame into a {@link ControlMessage}, or null if it isn't one. */
export function parseControlMessage(text: string): ControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const type = (value as {type?: unknown}).type;
  if (type === 'command' || type === 'response' || type === 'event') {
    return value as ControlMessage;
  }
  return null;
}
