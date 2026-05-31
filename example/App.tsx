import React from 'react';
import {StatusBar, StyleSheet, View} from 'react-native';
import type {SerialPort} from 'react-native-web-serial-api';
import {ConnectScreen} from './src/screens/ConnectScreen';
import {DevicesScreen} from './src/screens/DevicesScreen';
import {TerminalScreen} from './src/screens/TerminalScreen';
import {type ConnectionSettings, DEFAULT_SETTINGS} from './src/settings';
import {colors} from './src/theme';

type Screen = 'devices' | 'connect' | 'terminal';

/**
 * A React Native clone of Kai Morich's SimpleUsbTerminal, built on the
 * react-native-web-serial-api Web Serial API. Runs on Android and (Chromium) web.
 */
function App(): React.JSX.Element {
  const [screen, setScreen] = React.useState<Screen>('devices');
  const [port, setPort] = React.useState<SerialPort | null>(null);
  const [settings, setSettings] =
    React.useState<ConnectionSettings>(DEFAULT_SETTINGS);

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

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={colors.primaryDark}
      />
      {screen === 'terminal' && port ? (
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
        <DevicesScreen onSelect={selectPort} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
});

export default App;
