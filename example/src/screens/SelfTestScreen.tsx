import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type {Serial} from 'react-native-web-serial-api';
import type {ConformanceResult} from 'react-native-web-serial-api/testing';
import {
  runRealDeviceSmokeTest,
  runSerialConformance,
} from 'react-native-web-serial-api/testing';
import {AppBar} from '../components/AppBar';
import {colors} from '../theme';

type Props = {
  serial: Serial;
  onBack: () => void;
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

  const run = React.useCallback(
    async (name: string, fn: () => Promise<ConformanceResult[]>) => {
      setRunning(true);
      setLabel(name);
      setResults(null);
      try {
        setResults(await fn());
      } catch (e) {
        setResults([{name, passed: false, error: String(e), durationMs: 0}]);
      } finally {
        setRunning(false);
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
            run('Conformance suite (virtual)', runSerialConformance)
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
            run('Connected device smoke test', () =>
              runRealDeviceSmokeTest(serial),
            )
          }>
          <Text style={styles.buttonText}>Run on connected device</Text>
        </TouchableOpacity>
      </View>

      {label ? (
        <View
          style={[
            styles.summary,
            results ? (allPassed ? styles.ok : styles.fail) : null,
          ]}>
          <Text style={styles.summaryText}>
            {running
              ? `Running: ${label}…`
              : `${label} — ${passed}/${total} passed`}
          </Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          The conformance suite runs entirely in-app against a virtual device —
          no hardware required. “Run on connected device” exercises a small,
          safe subset against a real port (or the active demo device).
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
