import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type {Serial} from 'react-native-web-serial-api';
import type {ConformanceResult} from '../../../src/__tests__/conformance-suite';
import {
  runRealDeviceSmokeTest,
  runSerialConformance,
} from '../../../src/__tests__/conformance-suite';
import {AppBar} from '../components/AppBar';
import {
  compareGpsWithSimulator,
  makeVirtualGpsPort,
  runGpsConformance,
} from '../devices/gps/conformance';
import {
  compareWithSimulator,
  makeVirtualGatewayPort,
  runWMBusConformance,
} from '../devices/wmbus/conformance';
import {colors} from '../theme';

type Props = {
  serial: Serial;
  onBack: () => void;
};

/** Live-progress hooks shared by every runner (results stream in as they finish). */
type Progress = {
  onStart: (name: string, index: number, total: number) => void;
  onResult: (result: ConformanceResult) => void;
};

/**
 * On-device test runner. The conformance suite is the *same*
 * `serialConformanceTests` that run under Jest — here they execute in-app
 * against a virtual device, so the library can be validated on real hardware
 * (or an emulator, or the browser) without any USB device attached.
 */
export function SelfTestScreen({serial, onBack}: Props) {
  const [results, setResults] = React.useState<ConformanceResult[] | null>(
    null,
  );
  const [running, setRunning] = React.useState(false);
  const [label, setLabel] = React.useState('');
  const [current, setCurrent] = React.useState<{
    name: string;
    index: number;
    total: number;
  } | null>(null);

  const run = React.useCallback(
    async (
      name: string,
      fn: (progress: Progress) => Promise<ConformanceResult[]>,
    ) => {
      setRunning(true);
      setLabel(name);
      setResults([]);
      setCurrent(null);
      // Results stream in live via onResult; rows appear as each test finishes.
      const collected: ConformanceResult[] = [];
      const progress: Progress = {
        onStart: (n, index, total) => setCurrent({name: n, index, total}),
        onResult: r => {
          collected.push(r);
          setResults([...collected]);
        },
      };
      try {
        const final = await fn(progress);
        setResults(collected.length > 0 ? collected : final);
      } catch (e) {
        collected.push({name, passed: false, error: String(e), durationMs: 0});
        setResults([...collected]);
      } finally {
        setRunning(false);
        setCurrent(null);
      }
    },
    [],
  );

  const passed = results?.filter(r => r.passed).length ?? 0;
  const total = results?.length ?? 0;
  const allPassed = total > 0 && passed === total;

  return (
    <View style={styles.container}>
      <AppBar title="Self Test" onBack={onBack} />

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, running && styles.buttonDisabled]}
          disabled={running}
          onPress={() =>
            run('Conformance suite (virtual)', progress =>
              runSerialConformance(progress),
            )
          }>
          <Text style={styles.buttonText}>Run conformance suite</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.button,
            styles.buttonAlt,
            running && styles.buttonDisabled,
          ]}
          disabled={running}
          onPress={() =>
            run('Connected device smoke test', progress =>
              runRealDeviceSmokeTest(serial, progress),
            )
          }>
          <Text style={styles.buttonText}>Run on connected device</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          testID="wmbus-virtual"
          style={[
            styles.button,
            styles.buttonWmbus,
            running && styles.buttonDisabled,
          ]}
          disabled={running}
          onPress={() =>
            run('WM-Bus gateway suite (virtual)', async progress =>
              runWMBusConformance(await makeVirtualGatewayPort(), progress),
            )
          }>
          <Text style={styles.buttonText}>WM-Bus suite (virtual)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="wmbus-compare"
          style={[
            styles.button,
            styles.buttonWmbus,
            running && styles.buttonDisabled,
          ]}
          disabled={running}
          onPress={() =>
            run('WM-Bus device vs simulator', async progress => {
              const [connected] = await serial.getPorts();
              if (!connected) {
                return [
                  {
                    name: 'a WM-Bus gateway is connected',
                    passed: false,
                    error:
                      'Connect a WM-Bus gateway and grant USB permission, then retry.',
                    durationMs: 0,
                  },
                ];
              }
              return compareWithSimulator(connected, progress);
            })
          }>
          <Text style={styles.buttonText}>Compare device ↔ sim</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          testID="gps-virtual"
          style={[
            styles.button,
            styles.buttonGps,
            running && styles.buttonDisabled,
          ]}
          disabled={running}
          onPress={() =>
            run('GPS NMEA suite (virtual)', async progress =>
              runGpsConformance(await makeVirtualGpsPort(), progress),
            )
          }>
          <Text style={styles.buttonText}>GPS suite (virtual)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="gps-compare"
          style={[
            styles.button,
            styles.buttonGps,
            running && styles.buttonDisabled,
          ]}
          disabled={running}
          onPress={() =>
            run('GPS receiver vs simulator', async progress => {
              const [connected] = await serial.getPorts();
              if (!connected) {
                return [
                  {
                    name: 'a GPS receiver is connected',
                    passed: false,
                    error:
                      'Connect an NMEA 0183 GPS receiver (e.g. a u-blox) and grant USB permission, then retry.',
                    durationMs: 0,
                  },
                ];
              }
              return compareGpsWithSimulator(connected, progress);
            })
          }>
          <Text style={styles.buttonText}>Compare device ↔ sim</Text>
        </TouchableOpacity>
      </View>

      {label ? (
        <View
          style={[
            styles.summary,
            results && !running ? (allPassed ? styles.ok : styles.fail) : null,
          ]}>
          <Text style={styles.summaryText}>
            {running
              ? current
                ? `Running ${current.total ? `${current.index + 1}/${current.total} ` : ''}· ${passed}✓ ${total - passed}✗ — ${current.name}…`
                : `Running: ${label}…`
              : `${label} — ${passed}/${total} passed`}
          </Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          The conformance suite runs entirely in-app against a virtual device —
          no hardware required. “Run on connected device” exercises a small,
          safe subset against a real port (or the active demo device).{'\n\n'}
          “WM-Bus suite (virtual)” runs the IMST HCI gateway checks against the
          built-in simulator. “Compare device ↔ sim” runs the same checks
          against the connected gateway and the simulator and flags any case
          where the real device behaves differently — turn demo mode off and
          connect a real WM-Bus gateway first.{'\n\n'}
          “GPS suite (virtual)” validates the NMEA 0183 stream from the built-in
          GPS emulator; “Compare device ↔ sim” runs the same checks against a
          connected NMEA receiver (e.g. a u-blox 8) — connect one with a fix
          first.
        </Text>
      )}

      <ScrollView style={styles.list}>
        {results?.map((r, i) => (
          <View key={`${r.name}:${i}`} style={styles.row}>
            <Text
              style={[styles.mark, r.passed ? styles.markOk : styles.markFail]}>
              {r.passed ? '✓' : '✗'}
            </Text>
            <View style={styles.rowBody}>
              <Text style={styles.rowName}>{r.name}</Text>
              {r.error ? <Text style={styles.rowError}>{r.error}</Text> : null}
            </View>
            <Text style={styles.duration}>{r.durationMs}ms</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.background},
  actions: {flexDirection: 'row', padding: 12, gap: 8},
  button: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 4,
    alignItems: 'center',
  },
  buttonAlt: {backgroundColor: colors.accent},
  buttonWmbus: {backgroundColor: '#6a1b9a'},
  buttonGps: {backgroundColor: '#00695c'},
  buttonDisabled: {opacity: 0.5},
  buttonText: {color: colors.onPrimary, fontWeight: '600'},
  hint: {color: colors.textSecondary, paddingHorizontal: 16, paddingBottom: 8},
  summary: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: colors.divider,
  },
  ok: {backgroundColor: '#2e7d32'},
  fail: {backgroundColor: '#c62828'},
  summaryText: {color: colors.onPrimary, fontWeight: '600'},
  list: {flex: 1},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  mark: {width: 24, fontSize: 16, fontWeight: '700'},
  markOk: {color: '#2e7d32'},
  markFail: {color: '#c62828'},
  rowBody: {flex: 1, paddingHorizontal: 8},
  rowName: {color: colors.text, fontSize: 14},
  rowError: {color: '#c62828', fontSize: 12, marginTop: 2},
  duration: {color: colors.textSecondary, fontSize: 12},
});
