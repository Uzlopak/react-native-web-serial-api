import React from 'react';
import {FlatList, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import type {SerialPort} from 'react-native-web-serial-api';
import {serial} from 'react-native-web-serial-api';
import {AppBar} from '../components/AppBar';
import {colors} from '../theme';

type Props = {
  onSelect: (port: SerialPort) => void;
};

function hex4(n: number | undefined): string {
  return (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
}

// The Web Serial API only exposes VID/PID (not the driver/chip class), so we
// derive a best-effort label from known USB-serial vendor IDs.
function chipLabel(vendorId: number | undefined): string {
  switch (vendorId) {
    case 0x0403:
      return 'FTDI';
    case 0x10c4:
      return 'CP210x';
    case 0x1a86:
      return 'CH34x';
    case 0x067b:
      return 'Prolific';
    default:
      return 'USB serial';
  }
}

export function DevicesScreen({onSelect}: Props) {
  const [ports, setPorts] = React.useState<SerialPort[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      if (!serial) {
        setError('Web Serial API is not available on this platform.');
        return;
      }
      setPorts(await serial.getPorts());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  React.useEffect(() => {
    refresh();
    if (!serial) {
      return;
    }
    // Auto-refresh the list when a USB device is attached or detached, so the
    // user doesn't have to hit "Refresh Devices" manually.
    serial.addEventListener('connect', refresh);
    serial.addEventListener('disconnect', refresh);
    return () => {
      serial.removeEventListener('connect', refresh);
      serial.removeEventListener('disconnect', refresh);
    };
  }, [refresh]);

  const requestNew = React.useCallback(async () => {
    setError(null);
    try {
      const port = await serial.requestPort();
      onSelect(port);
    } catch (e: any) {
      // user cancelled the picker, or no device
      setError(e?.message ?? String(e));
    }
  }, [onSelect]);

  return (
    <View style={styles.container}>
      <AppBar
        title="Simple USB Terminal"
        menu={[
          {key: 'refresh', title: 'Refresh Devices', onPress: refresh},
          {key: 'request', title: 'Connect new device…', onPress: requestNew},
        ]}
      />

      <View style={styles.header}>
        <Text style={styles.headerText}>USB Devices</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={ports}
        keyExtractor={(_, i) => String(i)}
        ListEmptyComponent={
          <View>
            <Text style={styles.empty}>{'<no USB devices found>'}</Text>
            <Text style={styles.emptyHint}>
              Only devices this app already has USB permission for are listed.
              {'\n'}Use “Connect new device…” to grant access to a device.
            </Text>
          </View>
        }
        renderItem={({item}) => {
          const info = item.getInfo();
          return (
            <TouchableOpacity
              style={styles.item}
              onPress={() => onSelect(item)}>
              <Text style={styles.text1}>{chipLabel(info.usbVendorId)}</Text>
              <Text style={styles.text2}>
                {`Vendor ${hex4(info.usbVendorId)}, Product ${hex4(
                  info.usbProductId,
                )}`}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.background},
  header: {
    backgroundColor: colors.divider,
    paddingVertical: 12,
    alignItems: 'center',
  },
  headerText: {fontSize: 16, color: colors.text},
  error: {color: '#c62828', padding: 12},
  empty: {
    fontSize: 18,
    textAlign: 'center',
    color: colors.textSecondary,
    marginTop: 24,
  },
  emptyHint: {
    fontSize: 13,
    textAlign: 'center',
    color: colors.textSecondary,
    marginTop: 12,
    paddingHorizontal: 24,
  },
  item: {paddingVertical: 8, paddingHorizontal: 12},
  text1: {fontSize: 16, color: colors.text, marginTop: 4, marginHorizontal: 12},
  text2: {
    fontSize: 13,
    color: colors.textSecondary,
    marginHorizontal: 20,
    marginBottom: 4,
  },
});
