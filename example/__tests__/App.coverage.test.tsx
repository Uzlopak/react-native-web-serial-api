/**
 * @format
 */

import {afterEach, expect, it, jest} from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

const mockDisconnectSpy = jest.fn();
const mockDemoTransport = {kind: 'demo-transport', disconnect: jest.fn()};
const mockNativeTransport = {kind: 'native-transport'};
const mockWebsocketTransportFactory = jest.fn((url: string) => ({
  kind: 'ws-transport',
  url,
  disconnect: mockDisconnectSpy,
}));

jest.mock('react-native-web-serial-api', () => {
  const serial = {kind: 'platform-serial', getPorts: jest.fn()};
  const Serial = jest.fn(function Serial(this: any, transport: any) {
    return {
      kind: `serial:${transport?.kind ?? 'unknown'}`,
      transport,
    };
  });
  const UsbSerial = {
    getUsbSerial: jest.fn(),
  };
  return {Serial, serial, UsbSerial};
});

jest.mock('react-native-web-serial-api/websocket', () => ({
  WebSocketSerialTransport: jest.fn((url: string) =>
    mockWebsocketTransportFactory(url),
  ),
}));

jest.mock('../src/virtual', () => ({
  createDemoTransport: jest.fn(() => mockDemoTransport),
}));

jest.mock('../src/screens/DevicesScreen', () => {
  const _React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    DevicesScreen: ({
      serial,
      transport,
      demoMode,
      remoteUrl,
      onToggleDemo,
      onOpenSelfTest,
      onSelect,
      onSetRemote,
    }: any) => (
      <View>
        <Text testID="devices-state">{`devices:${serial.kind}:${transport?.kind ?? 'none'}:${demoMode ? 'demo' : 'native'}:${remoteUrl ?? 'none'}`}</Text>
        <Pressable
          testID="devices-select"
          onPress={() =>
            onSelect({
              getInfo: () => ({usbVendorId: 0x0403, usbProductId: 0x6001}),
            })
          }>
          <Text>select</Text>
        </Pressable>
        <Pressable testID="devices-toggle-demo" onPress={onToggleDemo}>
          <Text>demo</Text>
        </Pressable>
        <Pressable testID="devices-selftest" onPress={onOpenSelfTest}>
          <Text>selftest</Text>
        </Pressable>
        <Pressable
          testID="devices-remote-on"
          onPress={() => onSetRemote('ws://bridge.local:8080')}>
          <Text>remote on</Text>
        </Pressable>
        <Pressable
          testID="devices-remote-off"
          onPress={() => onSetRemote(null)}>
          <Text>remote off</Text>
        </Pressable>
      </View>
    ),
  };
});

jest.mock('../src/screens/ConnectScreen', () => {
  const _React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    ConnectScreen: ({initial, onBack, onConnect}: any) => (
      <View>
        <Text testID="connect-state">{String(initial.baudRate)}</Text>
        <Pressable testID="connect-back" onPress={onBack}>
          <Text>back</Text>
        </Pressable>
        <Pressable
          testID="connect-start"
          onPress={() =>
            onConnect({
              baudRate: 57600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none',
              flowControl: 'none',
            })
          }>
          <Text>start</Text>
        </Pressable>
      </View>
    ),
  };
});

jest.mock('../src/screens/TerminalScreen', () => {
  const _React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    TerminalScreen: ({settings, onBack}: any) => (
      <View>
        <Text testID="terminal-state">{String(settings.baudRate)}</Text>
        <Pressable testID="terminal-back" onPress={onBack}>
          <Text>back</Text>
        </Pressable>
      </View>
    ),
  };
});

jest.mock('../src/screens/SelfTestScreen', () => {
  const _React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    SelfTestScreen: ({serial, onBack}: any) => (
      <View>
        <Text testID="selftest-state">{serial.kind}</Text>
        <Pressable testID="selftest-back" onPress={onBack}>
          <Text>back</Text>
        </Pressable>
      </View>
    ),
  };
});

const {UsbSerial} = jest.requireMock('react-native-web-serial-api') as {
  UsbSerial: {getUsbSerial: jest.Mock};
};

const {WebSocketSerialTransport} = jest.requireMock(
  'react-native-web-serial-api/websocket',
) as {
  WebSocketSerialTransport: jest.Mock;
};

import App from '../App';

afterEach(() => {
  jest.clearAllMocks();
  mockDisconnectSpy.mockClear();
});

it('switches among devices, connect, terminal, self-test, demo, and remote modes', async () => {
  UsbSerial.getUsbSerial.mockReturnValue(mockNativeTransport);

  render(<App />);

  expect(screen.getByTestId('devices-state')).toHaveTextContent(
    'devices:platform-serial:native-transport:native:none',
  );

  fireEvent.press(screen.getByTestId('devices-select'));
  expect(screen.getByTestId('connect-state')).toHaveTextContent('115200');

  fireEvent.press(screen.getByTestId('connect-start'));
  expect(screen.getByTestId('terminal-state')).toHaveTextContent('57600');

  fireEvent.press(screen.getByTestId('terminal-back'));
  expect(screen.getByTestId('connect-state')).toBeTruthy();

  fireEvent.press(screen.getByTestId('connect-back'));
  expect(screen.getByTestId('devices-state')).toBeTruthy();

  fireEvent.press(screen.getByTestId('devices-selftest'));
  expect(screen.getByTestId('selftest-state')).toHaveTextContent(
    'platform-serial',
  );

  fireEvent.press(screen.getByTestId('selftest-back'));
  expect(screen.getByTestId('devices-state')).toBeTruthy();

  fireEvent.press(screen.getByTestId('devices-toggle-demo'));
  expect(screen.getByTestId('devices-state')).toHaveTextContent(
    'devices:serial:demo-transport:demo-transport:demo:none',
  );

  fireEvent.press(screen.getByTestId('devices-remote-on'));
  await waitFor(() =>
    expect(WebSocketSerialTransport).toHaveBeenCalledWith(
      'ws://bridge.local:8080',
    ),
  );
  expect(screen.getByTestId('devices-state')).toHaveTextContent(
    'devices:serial:ws-transport:ws-transport:native:ws://bridge.local:8080',
  );

  fireEvent.press(screen.getByTestId('devices-remote-off'));
  expect(screen.getByTestId('devices-state')).toHaveTextContent(
    'devices:platform-serial:native-transport:native:none',
  );
});

it('falls back cleanly when native transport lookup or websocket construction fails', async () => {
  UsbSerial.getUsbSerial.mockImplementation(() => {
    throw new Error('usb unavailable');
  });
  WebSocketSerialTransport.mockImplementationOnce(() => {
    throw new Error('bad bridge');
  });

  render(<App />);
  expect(screen.getByTestId('devices-state')).toHaveTextContent(
    'devices:platform-serial:none:native:none',
  );

  fireEvent.press(screen.getByTestId('devices-remote-on'));
  await waitFor(() => expect(WebSocketSerialTransport).toHaveBeenCalled());
  expect(screen.getByTestId('devices-state')).toHaveTextContent(
    'devices:platform-serial:none:native:ws://bridge.local:8080',
  );
});

it('disconnects the websocket transport when the app unmounts', async () => {
  UsbSerial.getUsbSerial.mockReturnValue(mockNativeTransport);

  const {unmount} = render(<App />);

  fireEvent.press(screen.getByTestId('devices-remote-on'));
  await waitFor(() => expect(WebSocketSerialTransport).toHaveBeenCalled());
  unmount();
  expect(mockDisconnectSpy).toHaveBeenCalledTimes(1);
});
