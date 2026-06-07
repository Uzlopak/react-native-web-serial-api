/**
 * @format
 */

import {afterEach, expect, it, jest} from '@jest/globals';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {DevicesScreen, chipLabel} from '../../src/screens/DevicesScreen';

jest.mock('../../src/components/AppBar', () => {
  const React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    AppBar: ({title, onBack, menu}: any) => (
      <View>
        {onBack ? (
          <Pressable testID="back" onPress={onBack}>
            <Text>back</Text>
          </Pressable>
        ) : null}
        <Text>{title}</Text>
        {menu?.map((item: any) => (
          <Pressable
            key={item.key}
            testID={`menu-${item.key}`}
            onPress={item.onPress}>
            <Text>{item.title}</Text>
          </Pressable>
        ))}
      </View>
    ),
  };
});

jest.mock('../../src/components/PromptDialog', () => {
  const React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    PromptDialog: ({visible, title, onSubmit, onClose}: any) =>
      visible ? (
        <View testID={`prompt-${title}`}>
          <Text>{title}</Text>
          <Pressable
            testID="prompt-submit"
            onPress={() => {
              onSubmit('ws://bridge.local:8080');
              onClose();
            }}>
            <Text>submit</Text>
          </Pressable>
        </View>
      ) : null,
  };
});

type Driver = {
  deviceId: number;
  portNumber: number;
  usbVendorId: number;
  usbProductId: number;
  hasPermission: boolean;
};

function createSerialStub() {
  return {
    getPorts: jest.fn(),
    requestPort: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as any;
}

function createTransportStub(drivers: Driver[]) {
  return {
    findAllDrivers: jest.fn(async () => drivers),
    requestPermission: jest.fn(async () => undefined),
  } as any;
}

afterEach(() => {
  jest.restoreAllMocks();
});

it('loads the device list, opens permitted ports, grants permission, and drives the menu', async () => {
  const permittedPort = {
    getInfo: () => ({usbVendorId: 0x0403, usbProductId: 0x6001}),
  };
  const serial = createSerialStub();
  serial.getPorts.mockResolvedValue([permittedPort]);
  const requestedPort = {
    getInfo: () => ({usbVendorId: 0x1111, usbProductId: 0x2222}),
  };
  serial.requestPort.mockResolvedValue(requestedPort);
  const transport = createTransportStub([
    {
      deviceId: 1,
      portNumber: 0,
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      hasPermission: true,
    },
    {
      deviceId: 2,
      portNumber: 0,
      usbVendorId: 0x10c4,
      usbProductId: 0xea60,
      hasPermission: false,
    },
  ]);
  const onToggleDemo = jest.fn();
  const onOpenSelfTest = jest.fn();
  const onSelect = jest.fn();
  const onSetRemote = jest.fn();

  render(
    <DevicesScreen
      serial={serial}
      transport={transport}
      demoMode={false}
      onToggleDemo={onToggleDemo}
      onOpenSelfTest={onOpenSelfTest}
      onSelect={onSelect}
      remoteUrl={null}
      onSetRemote={onSetRemote}
    />,
  );

  await waitFor(() => expect(transport.findAllDrivers).toHaveBeenCalled());
  await act(async () => {
    await transport.findAllDrivers.mock.results[0]?.value;
  });
  await waitFor(() => expect(screen.getByText('FTDI')).toBeTruthy());
  expect(screen.getByText(/CP210x/)).toBeTruthy();

  fireEvent.press(screen.getByText('FTDI'));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(permittedPort));
  expect(serial.getPorts).toHaveBeenCalled();

  fireEvent.press(screen.getByText(/CP210x/));
  await waitFor(() => expect(transport.requestPermission).toHaveBeenCalledWith(2));
  expect(transport.findAllDrivers).toHaveBeenCalledTimes(2);

  fireEvent.press(screen.getByTestId('menu-demo'));
  expect(onToggleDemo).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByTestId('menu-remote'));
  expect(screen.getByTestId('prompt-Remote serial (WebSocket)')).toBeTruthy();
  fireEvent.press(screen.getByTestId('prompt-submit'));
  expect(onSetRemote).toHaveBeenCalledWith('ws://bridge.local:8080');

  fireEvent.press(screen.getByTestId('menu-selftest'));
  expect(onOpenSelfTest).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByTestId('menu-request'));
  await waitFor(() => expect(serial.requestPort).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(requestedPort));
});

it('shows the remote banner, polls for changes, and can turn remote mode off', async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']});
  const serial = createSerialStub();
  serial.getPorts.mockResolvedValue([]);
  const transport = createTransportStub([]);
  const setIntervalSpy = jest.spyOn(global, 'setInterval');
  const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
  const onSetRemote = jest.fn();

  const {unmount} = render(
    <DevicesScreen
      serial={serial}
      transport={transport}
      demoMode={true}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl="ws://bridge.local:8080"
      onSetRemote={onSetRemote}
    />,
  );

  expect(screen.getByText('Virtual device mode — no hardware required')).toBeTruthy();
  expect(screen.getByText('Remote serial — ws://bridge.local:8080')).toBeTruthy();
  expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1500);

  fireEvent.press(screen.getByTestId('menu-remote'));
  expect(onSetRemote).toHaveBeenCalledWith(null);

  await act(async () => {
    jest.advanceTimersByTime(1500);
    await Promise.resolve();
  });
  expect(transport.findAllDrivers).toHaveBeenCalledTimes(2);

  unmount();
  expect(clearIntervalSpy).toHaveBeenCalled();
  jest.useRealTimers();
});

it('shows an error when web serial is unavailable', () => {
  render(
    <DevicesScreen
      serial={null as any}
      transport={null}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  expect(
    screen.getByText('Web Serial API is not available on this platform.'),
  ).toBeTruthy();
});

it('surfaces transport enumeration errors', async () => {
  const transport = createTransportStub([]);
  transport.findAllDrivers.mockRejectedValue('transport boom');

  render(
    <DevicesScreen
      serial={null as any}
      transport={transport}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await waitFor(() => expect(transport.findAllDrivers).toHaveBeenCalledTimes(1));
  await act(async () => {
    await transport.findAllDrivers.mock.results[0]?.value.catch(() => undefined);
  });
  await waitFor(() => expect(screen.getByText('transport boom')).toBeTruthy());
});

it('surfaces web serial enumeration errors', async () => {
  const serial = createSerialStub();
  serial.getPorts.mockRejectedValue(new Error('get ports boom'));

  render(
    <DevicesScreen
      serial={serial}
      transport={null}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await waitFor(() => expect(serial.getPorts).toHaveBeenCalledTimes(1));
  await act(async () => {
    await serial.getPorts.mock.results[0]?.value.catch(() => undefined);
  });
  await waitFor(() => expect(screen.getByText('get ports boom')).toBeTruthy());
});

it('surfaces an error when opening a permitted device fails', async () => {
  const serial = createSerialStub();
  serial.getPorts.mockRejectedValue(new Error('open boom'));
  const transport = createTransportStub([
    {
      deviceId: 1,
      portNumber: 0,
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      hasPermission: true,
    },
  ]);

  render(
    <DevicesScreen
      serial={serial}
      transport={transport}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await waitFor(() => expect(transport.findAllDrivers).toHaveBeenCalledTimes(1));
  await act(async () => {
    await transport.findAllDrivers.mock.results[0]?.value;
  });
  await waitFor(() => expect(screen.getByTestId('device-1')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('device-1'));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('open boom')).toBeTruthy());
});

it('falls back to the first available port when the VID/PID match is missing', async () => {
  const fallbackPort = {getInfo: () => ({usbVendorId: 0x2222, usbProductId: 0x3333})};
  const serial = createSerialStub();
  serial.getPorts.mockResolvedValue([fallbackPort]);
  const transport = createTransportStub([
    {
      deviceId: 1,
      portNumber: 0,
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      hasPermission: true,
    },
  ]);
  const onSelect = jest.fn();

  render(
    <DevicesScreen
      serial={serial}
      transport={transport}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={onSelect}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await waitFor(() => expect(transport.findAllDrivers).toHaveBeenCalledTimes(1));
  await act(async () => {
    await transport.findAllDrivers.mock.results[0]?.value;
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('device-1'));
    await Promise.resolve();
  });
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(fallbackPort));
});

it('surfaces device-open and permission-grant failures', async () => {
  const serial = createSerialStub();
  serial.getPorts.mockResolvedValue([]);
  const transport = createTransportStub([
    {
      deviceId: 1,
      portNumber: 0,
      usbVendorId: 0x0403,
      usbProductId: 0x6001,
      hasPermission: true,
    },
    {
      deviceId: 2,
      portNumber: 0,
      usbVendorId: 0x10c4,
      usbProductId: 0xea60,
      hasPermission: false,
    },
  ]);
  transport.requestPermission.mockRejectedValue(new Error('permission boom'));

  render(
    <DevicesScreen
      serial={serial}
      transport={transport}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await waitFor(() => expect(transport.findAllDrivers).toHaveBeenCalledTimes(1));
  await act(async () => {
    await transport.findAllDrivers.mock.results[0]?.value;
  });
  await waitFor(() => expect(screen.getByTestId('device-1')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('device-1'));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('Device is no longer available.')).toBeTruthy());

  await waitFor(() => expect(screen.getByTestId('device-2')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId('device-2'));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('permission boom')).toBeTruthy());
});

it('falls back to zeroed ids when the web port info is incomplete', async () => {
  const serial = createSerialStub();
  serial.getPorts.mockResolvedValue([
    {
      getInfo: () => ({}),
    },
  ]);

  render(
    <DevicesScreen
      serial={serial}
      transport={null}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await waitFor(() => expect(serial.getPorts).toHaveBeenCalledTimes(1));
  await act(async () => {
    await serial.getPorts.mock.results[0]?.value;
  });
  await waitFor(() => expect(screen.getByTestId('device--1')).toBeTruthy());
  expect(screen.getByText('Vendor 0000, Product 0000')).toBeTruthy();
});

it('surfaces a request-port error and refreshes on app foreground', async () => {
  const serial = createSerialStub();
  serial.requestPort.mockRejectedValue('picker closed');
  serial.getPorts.mockResolvedValue([]);
  let appStateListener: ((state: string) => void) | undefined;
  const appState = require('react-native').AppState;
  const addEventListenerSpy = jest.spyOn(appState, 'addEventListener');
  addEventListenerSpy.mockImplementation((...args: unknown[]) => {
    appStateListener = args[1] as ((state: string) => void) | undefined;
    return {remove: jest.fn()};
  });

  render(
    <DevicesScreen
      serial={serial}
      transport={null}
      demoMode={false}
      onToggleDemo={jest.fn()}
      onOpenSelfTest={jest.fn()}
      onSelect={jest.fn()}
      remoteUrl={null}
      onSetRemote={jest.fn()}
    />,
  );

  await act(async () => {
    fireEvent.press(screen.getByTestId('menu-request'));
  });
  await waitFor(() => expect(serial.requestPort).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByText('picker closed')).toBeTruthy());

  await act(async () => {
    appStateListener?.('active');
  });
  await waitFor(() => expect(serial.getPorts).toHaveBeenCalledTimes(2));
});

it('maps known USB vendor ids to chip labels', () => {
  expect(chipLabel(0x0403)).toBe('FTDI');
  expect(chipLabel(0x10c4)).toBe('CP210x');
  expect(chipLabel(0x04b4)).toBe('Cypress');
  expect(chipLabel(0x1a86)).toBe('CH34x');
  expect(chipLabel(0x067b)).toBe('Prolific');
  expect(chipLabel(0x9999)).toBe('USB serial');
  expect(chipLabel(undefined)).toBe('USB serial');
});
