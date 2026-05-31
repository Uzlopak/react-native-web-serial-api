import type {SerialOptions} from 'react-native-web-serial-api';

// Connection settings chosen on the form, passed straight into port.open().
export type ConnectionSettings = {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'even' | 'odd';
  flowControl: 'none' | 'hardware';
};

export const DEFAULT_SETTINGS: ConnectionSettings = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

export const BAUD_RATES = [2400, 9600, 19200, 57600, 115200] as const;
export const DATA_BITS = [7, 8] as const;
export const STOP_BITS = [1, 2] as const;
export const PARITIES = ['none', 'even', 'odd'] as const;
export const FLOW_CONTROLS = ['none', 'hardware'] as const;

export const FLOW_CONTROL_LABELS: Record<
  ConnectionSettings['flowControl'],
  string
> = {
  none: '<none>',
  hardware: 'RTS/CTS',
};

/** Map the form settings onto the Web Serial open() options. */
export function toSerialOptions(s: ConnectionSettings): SerialOptions {
  return {
    baudRate: s.baudRate,
    dataBits: s.dataBits,
    stopBits: s.stopBits,
    parity: s.parity,
    flowControl: s.flowControl,
  };
}
