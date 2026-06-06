import React from 'react';
import {
  AppState,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type {
  Serial,
  SerialPort,
  SerialTransport,
} from 'react-native-web-serial-api';
import {AppBar} from '../components/AppBar';
import {PromptDialog} from '../components/PromptDialog';
import {colors} from '../theme';

type Props = {
  // The active Web Serial entry point: the platform `serial` in real mode, or a
  // InMemorySerialTransport-backed Serial in demo mode.
  serial: Serial;
  // Low-level enumerator (lists unpermitted devices too). Native USB on Android,
  // the virtual transport in demo mode, or null on web (fall back to getPorts).
  transport: SerialTransport | null;
  demoMode: boolean;
  onToggleDemo: () => void;
  onOpenSelfTest: () => void;
  onSelect: (port: SerialPort) => void;
  /** WebSocket bridge URL when remote-serial mode is active, else null. */
  remoteUrl: string | null;
  onSetRemote: (url: string | null) => void;
};

// One row in the device list: a probed USB-serial port, which may or may not be
// accessible yet (Android USB permission).
type DeviceRow = {
  deviceId: number;
  portNumber: number;
  usbVendorId: number;
  usbProductId: number;
  hasPermission: boolean;
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
    case 0x04b4:
      return 'Cypress';
    case 0x1a86:
      return 'CH34x';
    case 0x067b:
      return 'Prolific';
    default:
      return 'USB serial';
  }
}

export function DevicesScreen({
  serial,
  transport,
  demoMode,
  onToggleDemo,
  onOpenSelfTest,
  onSelect,
  remoteUrl,
  onSetRemote,
}: Props) {
  const [rows, setRows] = React.useState<DeviceRow[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [showRemotePrompt, setShowRemotePrompt] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setError(null);
    try {
      // Native (Android) / virtual transport gives us every probed port plus its
      // permission state, so we can show plugged-in-but-unpermitted devices too.
      if (transport) {
        setRows((await transport.findAllDrivers()) as DeviceRow[]);
        return;
      }
      if (!serial) {
        setError('Web Serial API is not available on this platform.');
        return;
      }
      // Web: only already-granted ports are visible; all are permitted.
      const ports = await serial.getPorts();
      setRows(
        ports.map(p => {
          const info = p.getInfo();
          return {
            deviceId: -1,
            portNumber: 0,
            usbVendorId: info.usbVendorId ?? 0,
            usbProductId: info.usbProductId ?? 0,
            hasPermission: true,
          };
        }),
      );
    } catch (e: any) {
      setRows([]);
      setError(e?.message ?? String(e));
    }
  }, [serial, transport]);

  React.useEffect(() => {
    refresh();
    if (!serial) {
      return;
    }
    // Auto-refresh on attach, detach, AND permission-grant (the library emits
    // "connect" for all three), so the list stays current without manual taps.
    serial.addEventListener('connect', refresh);
    serial.addEventListener('disconnect', refresh);
    return () => {
      serial.removeEventListener('connect', refresh);
      serial.removeEventListener('disconnect', refresh);
    };
  }, [serial, refresh]);

  // Resolve the SerialPort for an already-permitted row and proceed.
  const openPermitted = React.useCallback(
    async (row: DeviceRow) => {
      setError(null);
      try {
        const ports = await serial.getPorts();
        const match =
          ports.find(p => {
            const info = p.getInfo();
            return (
              info.usbVendorId === row.usbVendorId &&
              info.usbProductId === row.usbProductId
            );
          }) ?? ports[0];
        if (match) {
          onSelect(match);
        } else {
          setError('Device is no longer available.');
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [serial, onSelect],
  );

  // Tap on an unpermitted row: request USB permission. On grant, refresh.
  const grantPermission = React.useCallback(
    async (row: DeviceRow) => {
      setError(null);
      if (!transport) {
        return;
      }
      try {
        await transport.requestPermission(row.deviceId);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
      refresh();
    },
    [transport, refresh],
  );

  const requestNew = React.useCallback(async () => {
    setError(null);
    try {
      const port = await serial.requestPort();
      onSelect(port);
    } catch (e: any) {
      // user cancelled the picker, or no device
      setError(e?.message ?? String(e));
    }
  }, [serial, onSelect]);

  // Refresh device list when app returns to foreground (covers system dialog grants)
  React.useEffect(() => {
    const handleAppStateChange = (state: string) => {
      if (state === 'active') {
        refresh();
      }
    };
    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );
    return () => {
      subscription.remove();
    };
  }, [refresh]);

  // Remote WebSocket mode has no native attach/detach events; poll lightly so
  // the list reflects server availability changes without manual refresh.
  React.useEffect(() => {
    if (!remoteUrl) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      clearInterval(timer);
    };
  }, [remoteUrl, refresh]);

  return (
    <View style={styles.container}>
      <AppBar
        title="Simple USB Terminal"
        menu={[
          {key: 'refresh', title: 'Refresh Devices', onPress: refresh},
          {key: 'request', title: 'Connect new device…', onPress: requestNew},
          {
            key: 'demo',
            title: 'Virtual device (demo)',
            checkable: true,
            checked: demoMode,
            onPress: onToggleDemo,
          },
          {
            key: 'remote',
            title: 'Remote serial (WebSocket)',
            checkable: true,
            checked: remoteUrl !== null,
            onPress: () =>
              remoteUrl !== null
                ? onSetRemote(null)
                : setShowRemotePrompt(true),
          },
          {key: 'selftest', title: 'Self test…', onPress: onOpenSelfTest},
        ]}
      />

      <View style={styles.header}>
        <Text style={styles.headerText}>USB Devices</Text>
      </View>

      {demoMode ? (
        <Text style={styles.demoBanner}>
          Virtual device mode — no hardware required
        </Text>
      ) : null}

      {remoteUrl ? (
        <Text style={styles.demoBanner}>Remote serial — {remoteUrl}</Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={rows}
        keyExtractor={(r, i) => `${r.deviceId}:${r.portNumber}:${i}`}
        ListEmptyComponent={
          <Text style={styles.empty}>{'<no USB devices found>'}</Text>
        }
        renderItem={({item}) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() =>
              item.hasPermission ? openPermitted(item) : grantPermission(item)
            }>
            <Text style={[styles.text1, !item.hasPermission && styles.dimmed]}>
              {chipLabel(item.usbVendorId)}
              {item.hasPermission ? '' : '  🔒 tap to allow'}
            </Text>
            <Text style={[styles.text2, !item.hasPermission && styles.dimmed]}>
              {`Vendor ${hex4(item.usbVendorId)}, Product ${hex4(
                item.usbProductId,
              )}`}
            </Text>
          </TouchableOpacity>
        )}
      />

      <PromptDialog
        visible={showRemotePrompt}
        title="Remote serial (WebSocket)"
        placeholder="ws://localhost:8080"
        initialValue={remoteUrl ?? 'ws://localhost:8080'}
        onSubmit={url => {
          if (url) {
            onSetRemote(url);
          }
        }}
        onClose={() => setShowRemotePrompt(false)}
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
  demoBanner: {
    backgroundColor: colors.accent,
    color: colors.onPrimary,
    textAlign: 'center',
    paddingVertical: 6,
    fontSize: 13,
  },
  error: {color: '#c62828', padding: 12},
  empty: {
    fontSize: 18,
    textAlign: 'center',
    color: colors.textSecondary,
    marginTop: 24,
  },
  item: {paddingVertical: 8, paddingHorizontal: 12},
  text1: {fontSize: 16, color: colors.text, marginTop: 4, marginHorizontal: 12},
  text2: {
    fontSize: 13,
    color: colors.textSecondary,
    marginHorizontal: 20,
    marginBottom: 4,
  },
  dimmed: {opacity: 0.5},
});
