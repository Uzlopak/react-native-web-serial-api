/**
 * The NMEA 0183 GPS conformance suite must pass against the emulator — it is
 * the reference a real receiver (e.g. a u-blox 8) is compared to on the Self
 * Test screen. The checks are behavioural and talker-agnostic, so the same
 * cases pass for `$GP…` (emulator) and `$GN…/$GL…` (multi-GNSS hardware).
 */
import {describe, expect, it} from '@jest/globals';
import {
  compareGpsWithSimulator,
  gpsConformanceTests,
  makeVirtualGpsPort,
  runGpsConformance,
} from '../../src/devices/gps/conformance';

describe('GPS NMEA 0183 conformance suite', () => {
  it('passes every case against the simulated GPS receiver', async () => {
    const results = await runGpsConformance(await makeVirtualGpsPort());
    expect(results).toHaveLength(gpsConformanceTests.length);
    expect(results.filter(r => !r.passed)).toEqual([]);
  }, 15000);

  it('reports two simulators as identical', async () => {
    const results = await compareGpsWithSimulator(await makeVirtualGpsPort());
    expect(results).toHaveLength(gpsConformanceTests.length);
    expect(results.filter(r => !r.passed)).toEqual([]);
  }, 20000);
});
