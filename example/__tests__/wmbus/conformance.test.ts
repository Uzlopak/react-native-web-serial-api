/**
 * @format
 *
 * The WM-Bus gateway HCI conformance suite must pass against the simulator —
 * it is the reference a real device is compared to on the Self Test screen.
 */
import {describe, expect, it} from '@jest/globals';
import {compareTestResults} from 'react-native-web-serial-api/testing';
import {
  compareWithSimulator,
  makeVirtualGatewayPort,
  runWMBusConformance,
  wmbusConformanceTests,
} from '../../src/devices/wmbus/conformance';

describe('WM-Bus gateway conformance suite', () => {
  it('passes every case against the simulated gateway', async () => {
    const results = await runWMBusConformance(await makeVirtualGatewayPort());
    expect(results).toHaveLength(wmbusConformanceTests.length);
    const failures = results.filter(r => !r.passed);
    expect(failures).toEqual([]);
  }, 30000);

  it('reports two simulators as identical', async () => {
    // Comparing the reference against another simulator must be all-green.
    const results = await compareWithSimulator(await makeVirtualGatewayPort());
    expect(results.filter(r => !r.passed)).toEqual([]);
    expect(results).toHaveLength(wmbusConformanceTests.length);
  }, 60000);

  it('treats matching pass/fail outcomes as identical', () => {
    const compared = compareTestResults(
      [
        {name: 'A', passed: true, durationMs: 1},
        {name: 'B', passed: false, error: 'sim failed', durationMs: 2},
      ],
      [
        {name: 'A', passed: true, durationMs: 3},
        {name: 'B', passed: false, error: 'device failed too', durationMs: 4},
      ],
    );

    expect(compared).toEqual([
      {name: 'A', passed: true, error: undefined, durationMs: 3},
      {name: 'B', passed: true, error: undefined, durationMs: 4},
    ]);
  });

  it('reports mismatches and unexpected device-only cases', () => {
    const compared = compareTestResults(
      [{name: 'A', passed: true, durationMs: 1}],
      [
        {name: 'A', passed: false, error: 'timeout', durationMs: 5},
        {name: 'X', passed: true, durationMs: 6},
      ],
    );

    expect(compared).toHaveLength(2);
    expect(compared[0]).toEqual({
      name: 'candidate: X',
      passed: false,
      error: 'candidate produced an unexpected result',
      durationMs: 6,
    });
    expect(compared[1]?.name).toBe('A');
    expect(compared[1]?.passed).toBe(false);
    expect(compared[1]?.error).toContain('reference passed, candidate failed');
    expect(compared[1]?.error).toContain('timeout');
  });
});
