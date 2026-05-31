import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type {SerialPort} from 'react-native-web-serial-api';
import {AppBar} from '../components/AppBar';
import {
  type Choice,
  SingleChoiceDialog,
} from '../components/SingleChoiceDialog';
import {
  BAUD_RATES,
  type ConnectionSettings,
  DATA_BITS,
  DEFAULT_SETTINGS,
  FLOW_CONTROL_LABELS,
  FLOW_CONTROLS,
  PARITIES,
  STOP_BITS,
} from '../settings';
import {colors} from '../theme';

type Props = {
  port: SerialPort;
  initial?: ConnectionSettings;
  onBack: () => void;
  onConnect: (settings: ConnectionSettings) => void;
};

function hex4(n: number | undefined): string {
  return (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
}

export function ConnectScreen({port, initial, onBack, onConnect}: Props) {
  const [settings, setSettings] = React.useState<ConnectionSettings>(
    initial ?? DEFAULT_SETTINGS,
  );
  // Which dropdown's dialog is open (null = none).
  const [open, setOpen] = React.useState<keyof ConnectionSettings | null>(null);

  const info = port.getInfo();

  const set = <K extends keyof ConnectionSettings>(
    key: K,
    value: ConnectionSettings[K],
  ) => setSettings(s => ({...s, [key]: value}));

  return (
    <View style={styles.container}>
      <AppBar title="Connection settings" onBack={onBack} />

      <ScrollView contentContainerStyle={styles.form}>
        <Text style={styles.device}>
          {`Vendor ${hex4(info.usbVendorId)}  ·  Product ${hex4(
            info.usbProductId,
          )}`}
        </Text>

        <Dropdown
          label="Baud rate"
          value={String(settings.baudRate)}
          onPress={() => setOpen('baudRate')}
        />
        <Dropdown
          label="Data bits"
          value={String(settings.dataBits)}
          onPress={() => setOpen('dataBits')}
        />
        <Dropdown
          label="Stop bits"
          value={String(settings.stopBits)}
          onPress={() => setOpen('stopBits')}
        />
        <Dropdown
          label="Parity"
          value={settings.parity}
          onPress={() => setOpen('parity')}
        />
        <Dropdown
          label="Flow control"
          value={FLOW_CONTROL_LABELS[settings.flowControl]}
          onPress={() => setOpen('flowControl')}
        />

        <TouchableOpacity
          style={styles.connectBtn}
          onPress={() => onConnect(settings)}>
          <Text style={styles.connectText}>Connect</Text>
        </TouchableOpacity>
      </ScrollView>

      <SingleChoiceDialog
        visible={open === 'baudRate'}
        title="Baud rate"
        options={BAUD_RATES.map(b => ({label: String(b), value: b}))}
        selected={settings.baudRate}
        onSelect={v => set('baudRate', v)}
        onClose={() => setOpen(null)}
      />
      <SingleChoiceDialog
        visible={open === 'dataBits'}
        title="Data bits"
        options={DATA_BITS.map(b => ({label: String(b), value: b}))}
        selected={settings.dataBits}
        onSelect={v => set('dataBits', v as ConnectionSettings['dataBits'])}
        onClose={() => setOpen(null)}
      />
      <SingleChoiceDialog
        visible={open === 'stopBits'}
        title="Stop bits"
        options={STOP_BITS.map(b => ({label: String(b), value: b}))}
        selected={settings.stopBits}
        onSelect={v => set('stopBits', v as ConnectionSettings['stopBits'])}
        onClose={() => setOpen(null)}
      />
      <SingleChoiceDialog
        visible={open === 'parity'}
        title="Parity"
        options={PARITIES.map(p => ({label: p, value: p})) as Choice<string>[]}
        selected={settings.parity}
        onSelect={v => set('parity', v as ConnectionSettings['parity'])}
        onClose={() => setOpen(null)}
      />
      <SingleChoiceDialog
        visible={open === 'flowControl'}
        title="Flow control"
        options={
          FLOW_CONTROLS.map(f => ({
            label: FLOW_CONTROL_LABELS[f],
            value: f,
          })) as Choice<string>[]
        }
        selected={settings.flowControl}
        onSelect={v =>
          set('flowControl', v as ConnectionSettings['flowControl'])
        }
        onClose={() => setOpen(null)}
      />
    </View>
  );
}

function Dropdown({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValueWrap}>
        <Text style={styles.rowValue}>{value}</Text>
        <Text style={styles.caret}>▾</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.background},
  form: {padding: 16},
  device: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowLabel: {fontSize: 16, color: colors.text},
  rowValueWrap: {flexDirection: 'row', alignItems: 'center'},
  rowValue: {fontSize: 16, color: colors.primary, fontWeight: '600'},
  caret: {fontSize: 14, color: colors.primary, marginLeft: 8},
  connectBtn: {
    marginTop: 28,
    backgroundColor: colors.primary,
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
  },
  connectText: {color: colors.onPrimary, fontSize: 16, fontWeight: '600'},
});
