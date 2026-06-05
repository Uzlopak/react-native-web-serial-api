import React from 'react';
import {StatusBar, StyleSheet, View} from 'react-native';
import type {SerialPort, SerialTransport} from 'react-native-web-serial-api';
import {Serial, serial, UsbSerial} from 'react-native-web-serial-api';
import {WebSocketSerialTransport} from 'react-native-web-serial-api/websocket';
import {ConnectScreen} from './src/screens/ConnectScreen';
import {DevicesScreen} from './src/screens/DevicesScreen';
import {SelfTestScreen} from './src/screens/SelfTestScreen';
import {TerminalScreen} from './src/screens/TerminalScreen';
import {type ConnectionSettings, DEFAULT_SETTINGS} from './src/settings';
import {colors} from './src/theme';
import {createDemoTransport} from './src/virtual';

type Screen = 'devices' | 'connect' | 'terminal' | 'selftest';

// In real mode the low-level enumerator is the native USB module (Android) or
// nothing (web, where DevicesScreen falls back to serial.getPorts()).
function nativeTransport(): SerialTransport | null {
  try {
    return UsbSerial.getUsbSerial();
  } catch {
    return null;
  }
}

/**
 * A React Native clone of Kai Morich's SimpleUsbTerminal, built on the
 * react-native-web-serial-api Web Serial API. Runs on Android and (Chromium) web.
 */
function App(): React.JSX.Element {
  const [screen, setScreen] = React.useState<Screen>('devices');
  const [port, setPort] = React.useState<SerialPort | null>(null);
  const [settings, setSettings] =
    React.useState<ConnectionSettings>(DEFAULT_SETTINGS);
  const [demoMode, setDemoMode] = React.useState(false);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);

  // In demo mode the whole app talks to an in-memory VirtualSerialTransport via
  // a dedicated Serial instance — no USB hardware required. A fresh transport is
  // built whenever demo mode is (re)enabled.
  const demo = React.useMemo(() => {
    if (!demoMode) return null;
    const transport = createDemoTransport();
    return {transport, serial: new Serial(transport)};
  }, [demoMode]);

  // Remote mode bridges to a real serial port on another machine over a
  // WebSocket (run `expose-serial-websocket` there). Same SerialTransport seam,
  // so the rest of the app is unchanged.
  const remote = React.useMemo(() => {
    if (!remoteUrl) return null;
    try {
      const transport = new WebSocketSerialTransport(remoteUrl);
      return {transport, serial: new Serial(transport)};
    } catch {
      return null;
    }
  }, [remoteUrl]);

  // Tear the remote socket down when leaving remote mode (or switching URL) so
  // it never outlives its use and hold the bridge's single serial session open.
  React.useEffect(() => {
    return () => {
      remote?.transport.disconnect();
    };
  }, [remote]);

  const activeSerial = remote ? remote.serial : demo ? demo.serial : serial;
  const activeTransport = remote
    ? remote.transport
    : demo
      ? demo.transport
      : nativeTransport();

  // Devices -> Connect form
  const selectPort = (p: SerialPort) => {
    setPort(p);
    setScreen('connect');
  };

  // Connect form -> Terminal
  const startTerminal = (s: ConnectionSettings) => {
    setSettings(s);
    setScreen('terminal');
  };

  const backToDevices = () => {
    setScreen('devices');
    setPort(null);
  };

  const backToConnect = () => setScreen('connect');

  const toggleDemo = () => {
    setPort(null);
    setScreen('devices');
    setRemoteUrl(null);
    setDemoMode(d => !d);
  };

  // Demo and remote modes are mutually exclusive.
  const setRemote = (url: string | null) => {
    setPort(null);
    setScreen('devices');
    setDemoMode(false);
    setRemoteUrl(url);
  };

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={colors.primaryDark}
      />
      {screen === 'selftest' ? (
        <SelfTestScreen serial={activeSerial} onBack={backToDevices} />
      ) : screen === 'terminal' && port ? (
        <TerminalScreen
          port={port}
          settings={settings}
          onBack={backToConnect}
        />
      ) : screen === 'connect' && port ? (
        <ConnectScreen
          port={port}
          initial={settings}
          onBack={backToDevices}
          onConnect={startTerminal}
        />
      ) : (
        <DevicesScreen
          serial={activeSerial}
          transport={activeTransport}
          demoMode={demoMode}
          onToggleDemo={toggleDemo}
          onOpenSelfTest={() => setScreen('selftest')}
          onSelect={selectPort}
          remoteUrl={remoteUrl}
          onSetRemote={setRemote}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
});

export default App;
