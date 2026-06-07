/**
 * @format
 */

import {expect, it, jest} from '@jest/globals';
import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {SelfTestScreen} from '../../src/screens/SelfTestScreen';
import type {
  ConformanceProgress,
  ConformanceResult,
} from '../../../src/__tests__/conformance-suite';

jest.mock('../../../src/__tests__/conformance-suite', () => ({
  runSerialConformance: jest.fn(),
  runRealDeviceSmokeTest: jest.fn(),
}));

jest.mock('../../src/devices/gps/conformance', () => ({
  compareGpsWithSimulator: jest.fn(),
  makeVirtualGpsPort: jest.fn(),
  runGpsConformance: jest.fn(),
}));

jest.mock('../../src/devices/wmbus/conformance', () => ({
  compareWithSimulator: jest.fn(),
  makeVirtualGatewayPort: jest.fn(),
  runWMBusConformance: jest.fn(),
}));

const conformance = jest.requireMock('../../../src/__tests__/conformance-suite') as {
  runSerialConformance: jest.MockedFunction<
    (progress?: ConformanceProgress) => Promise<ConformanceResult[]>
  >;
  runRealDeviceSmokeTest: jest.MockedFunction<
    (
      serial: unknown,
      progress?: ConformanceProgress,
    ) => Promise<ConformanceResult[]>
  >;
};

const gps = jest.requireMock('../../src/devices/gps/conformance') as any;

const wmbus = jest.requireMock('../../src/devices/wmbus/conformance') as any;

const fakePort = {kind: 'fake-port'};

it('shows progress and results for a passing virtual suite', async () => {
  conformance.runSerialConformance.mockImplementation(async progress => {
    progress?.onStart?.('loopback echoes bytes', 0, 1);
    progress?.onResult?.({
      name: 'loopback echoes bytes',
      passed: true,
      durationMs: 3,
    });
    return [{name: 'loopback echoes bytes', passed: true, durationMs: 3}];
  });

  render(<SelfTestScreen serial={{} as any} onBack={jest.fn()} />);

  fireEvent.press(screen.getByText('Run conformance suite'));
  await waitFor(() =>
    expect(screen.getByText('Conformance suite (virtual) — 1/1 passed')).toBeTruthy(),
  );
  expect(screen.getByText('loopback echoes bytes')).toBeTruthy();
  expect(screen.getByText('✓')).toBeTruthy();
});

it('renders a failure when the connected-device smoke test throws', async () => {
  conformance.runRealDeviceSmokeTest.mockRejectedValueOnce(
    new Error('device unavailable'),
  );

  render(<SelfTestScreen serial={{} as any} onBack={jest.fn()} />);

  fireEvent.press(screen.getByText('Run on connected device'));
  await waitFor(() =>
    expect(screen.getByText('Connected device smoke test — 0/1 passed')).toBeTruthy(),
  );
  expect(screen.getByText(/device unavailable/)).toBeTruthy();
  expect(screen.getByText('✗')).toBeTruthy();
});

it('runs the WM-Bus and GPS virtual and compare suites', async () => {
  gps.makeVirtualGpsPort.mockResolvedValueOnce(fakePort);
  gps.runGpsConformance.mockResolvedValue([{name: 'gps ok', passed: true, durationMs: 1}]);
  gps.compareGpsWithSimulator.mockResolvedValue([
    {name: 'gps compare', passed: true, durationMs: 1},
  ]);
  wmbus.makeVirtualGatewayPort.mockResolvedValueOnce(fakePort);
  wmbus.runWMBusConformance.mockResolvedValue([
    {name: 'wmbus ok', passed: true, durationMs: 1},
  ]);
  wmbus.compareWithSimulator.mockResolvedValue([
    {name: 'wmbus compare', passed: true, durationMs: 1},
  ]);

  const serial = {
    getPorts: jest.fn(async () => [fakePort]),
  } as any;

  render(<SelfTestScreen serial={serial} onBack={jest.fn()} />);

  fireEvent.press(screen.getByTestId('wmbus-virtual'));
  await waitFor(() =>
    expect(
      screen.getByText('WM-Bus gateway suite (virtual) — 1/1 passed'),
    ).toBeTruthy(),
  );
  expect(screen.getByText('wmbus ok')).toBeTruthy();

  fireEvent.press(screen.getByTestId('wmbus-compare'));
  await waitFor(() =>
    expect(screen.getByText('WM-Bus device vs simulator — 1/1 passed')).toBeTruthy(),
  );
  expect(screen.getByText('wmbus compare')).toBeTruthy();

  fireEvent.press(screen.getByTestId('gps-virtual'));
  await waitFor(() =>
    expect(screen.getByText('GPS NMEA suite (virtual) — 1/1 passed')).toBeTruthy(),
  );
  expect(screen.getByText('gps ok')).toBeTruthy();

  fireEvent.press(screen.getByTestId('gps-compare'));
  await waitFor(() =>
    expect(screen.getByText('GPS receiver vs simulator — 1/1 passed')).toBeTruthy(),
  );
  expect(screen.getByText('gps compare')).toBeTruthy();
});

it('shows compare errors when no WM-Bus or GPS device is connected', async () => {
  const serial = {
    getPorts: jest.fn(async () => []),
  } as any;

  render(<SelfTestScreen serial={serial} onBack={jest.fn()} />);

  fireEvent.press(screen.getByTestId('wmbus-compare'));
  await waitFor(() =>
    expect(
      screen.getByText('WM-Bus device vs simulator — 0/1 passed'),
    ).toBeTruthy(),
  );
  expect(screen.getByText(/Connect a WM-Bus gateway/)).toBeTruthy();

  fireEvent.press(screen.getByTestId('gps-compare'));
  await waitFor(() =>
    expect(screen.getByText('GPS receiver vs simulator — 0/1 passed')).toBeTruthy(),
  );
  expect(screen.getByText(/Connect an NMEA 0183 GPS receiver/)).toBeTruthy();
});
