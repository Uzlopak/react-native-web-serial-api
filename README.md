# react-native-web-serial-api

> The [W3C Web Serial API](https://wicg.github.io/serial/) (`navigator.serial`) for React Native on Android, backed by a USB-serial TurboModule built on top of [`mik3y/usb-serial-for-android`](https://github.com/mik3y/usb-serial-for-android).

Use the same API you already know from the browser - `serial.requestPort()`, `port.open()`, `port.readable`, `port.writable`, `getPorts()`, `setSignals()`, and `getSignals()` - in a React Native app that talks to USB serial devices.

## At a glance

- Spec-style `Serial` / `SerialPort` implementation
- New Architecture TurboModule
- Native port picker and Android USB permission handling
- Web Streams under the hood (`ReadableStream` / `WritableStream`)
- Works with browser-style code on web by delegating to the native `navigator.serial`

## Platform support

| Platform | Support | Notes |
| --- | --- | --- |
| Android | Yes | Native USB-serial support through the TurboModule. |
| Web | Yes | Delegates to the browser's native `navigator.serial`. |
| iOS | No | Generic USB-serial access is not available, so autolinking is disabled. |

## Quick start

```sh
npm install react-native-web-serial-api
# or
yarn add react-native-web-serial-api
```

This is a New Architecture library. Make sure your app has the New Architecture enabled. No manual linking is required - the module is autolinked.

### Minimal usage

```ts
import {serial} from 'react-native-web-serial-api';

async function run() {
  // Must be called from a user gesture on web.
  const port = await serial.requestPort({
    filters: [{usbVendorId: 0x0403}], // optional, for example FTDI only
  });

  await port.open({baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none'});

  const writer = port.writable.getWriter();
  await writer.write(new TextEncoder().encode('Hello\n'));
  writer.releaseLock();

  const reader = port.readable.getReader();
  const {value} = await reader.read();
  console.log(value);
  reader.releaseLock();

  await port.close();
}
```

## Android setup

The library ships its own `AndroidManifest.xml` that declares the port picker activity, the detach receiver, and the `android.hardware.usb.host` feature, so usually no extra configuration is needed.

If you want your app to launch automatically when a matching device is plugged in, add an intent filter to your launcher activity in `android/app/src/main/AndroidManifest.xml`:

```xml
<activity android:name=".MainActivity" ...>
  <intent-filter>
    <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
  </intent-filter>
  <meta-data
    android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
    android:resource="@xml/device_filter" />
</activity>
```

The bundled `@xml/device_filter` matches common USB-serial chips:

- CDC-ACM
- FTDI `0x0403`
- CP210x `0x10C4`
- CH34x `0x1A86`
- PL2303 `0x067B`

Provide your own `res/xml/device_filter.xml` to override it.

## Which API should I use?

| Use case | Start with | Why |
| --- | --- | --- |
| Real hardware in your app | `Serial` / `SerialPort` | The browser-style Web Serial API you already know. |
| Quick in-memory smoke tests | `InMemorySerialTransport` + `LoopbackDevice` | Fastest way to exercise bytes without hardware. |
| Protocol tests against a simulated peripheral | `SimulatedDevice` + `createDeviceFixture` + `SerialClient` | Gives you both sides of the conversation in one test. |
| App-to-app or emulator-to-host testing | `exposeSimulatedDevice` + `WebSocketSerialTransport` | Runs the same simulated device behind a real WebSocket bridge. |

## Core concepts

### `serial`

The package exports a ready-to-use `serial` singleton, which is the equivalent of `navigator.serial`.

```ts
import {serial} from 'react-native-web-serial-api';

const ports = await serial.getPorts();
```

### Permissions

There are two different permission concepts:

- `serial.requestPort()` is the Web Serial permission flow. In Android mode it shows the native picker and requests Android USB permission for the selected device.
- Android USB permission can also be granted outside the app, for example through the system attach dialog or an `USB_DEVICE_ATTACHED` intent filter.

On Android, `serial.getPorts()` returns the devices the app can currently access through Android USB permission, regardless of how that permission was obtained. On web, `getPorts()` returns ports previously granted by the site in the browser's persistent permission store.

```ts
const ports = await serial.getPorts();
const port = await serial.requestPort();
```

### Connect and disconnect events

```ts
serial.addEventListener('connect', () => console.log('device attached'));
serial.addEventListener('disconnect', () => console.log('device detached'));

port.addEventListener('disconnect', () => console.log('this port went away'));
```

On Android, `serial` fires `connect` when a USB device is attached and when the app is granted USB permission for a device. A common pattern is to re-run `getPorts()` on every `connect` / `disconnect` so your device list stays fresh.

### Control and status signals

```ts
await port.setSignals({dataTerminalReady: true, requestToSend: false});
const {clearToSend, dataCarrierDetect, ringIndicator, dataSetReady} =
  await port.getSignals();
```

### Browser-only option note

In Android USB mode, `allowedBluetoothServiceClassIds` is not supported by `requestPort()` and will throw a `TypeError` if provided.

## API reference

The package exposes:

| Export | Description |
| --- | --- |
| `serial` | A ready-to-use `Serial` instance. |
| `Serial`, `SerialPort` | The Web Serial API classes. |
| `UsbSerial` | Lower-level access to the raw USB-serial TurboModule (Android only). |
| `Event`, `EventTarget` | Polyfill implementations used only when the runtime does not already provide these globals. |
| Types | `SerialOptions`, `SerialOutputSignals`, `SerialInputSignals`, `SerialPortInfo`, `SerialPortFilter`, `SerialPortRequestOptions`. |

## Example app

The [`example/`](./example) app is a React Native port of [SimpleUsbTerminal](https://github.com/kai-morich/SimpleUsbTerminal) built on this package's Web Serial API. It includes:

- a Devices screen with baud-rate selection
- a Terminal screen with colored send / receive logs
- HEX mode
- newline selection
- clear
- control lines with RTS / DTR toggles
- flow control
- Send BREAK

### Run the example on Android

```sh
npm install
cd example
npm install
npm run android
```

Because the example uses the Web Serial API, a few details differ from SimpleUsbTerminal:

- Driver / chip name is not exposed by the Web Serial API. Rows show `Vendor/Product` plus a best-effort chip label from known vendor IDs.
- Flow control is limited to `None` and `Hardware (RTS-CTS)`. XON/XOFF and DTR/DSR are not in the Web Serial spec. Changing it reconnects the port.
- The Android foreground-service notification is omitted because it is service plumbing unrelated to serial I/O.

### Run the example in the browser

The example also runs as a web app via [`react-native-web`](https://necolas.github.io/react-native-web/) and [Vite](https://vite.dev/). On web, the package delegates to the browser's native `navigator.serial`, so the same `App.tsx` talks to real serial hardware through browser permissions.

```sh
cd example
npm install
npm run web
# npm run web:build
```

Web Serial works in Chromium-based browsers over a secure context. `http://localhost` counts. `requestPort()` must be called from a user gesture, and the example's Request port button handles that.

## Testing and simulation

The transport layer lets you test without USB hardware, whether you want a quick loopback check, a stateful simulated peripheral, or a full WebSocket E2E path. The example app also includes a Self Test screen and a Virtual device (demo) mode.

### Fast in-memory test

```ts
import {Serial} from 'react-native-web-serial-api';
import {
  InMemorySerialTransport,
  LoopbackDevice,
} from 'react-native-web-serial-api/testing';

const transport = new InMemorySerialTransport();
transport.addDevice(
  new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
  {hasPermission: true},
);

const serial = new Serial(transport);
```

### Host-side protocol test

```ts
import {createDeviceFixture, SimulatedDevice} from 'react-native-web-serial-api/testing';

class Thermometer extends SimulatedDevice {
  readonly usbVendorId = 0x10c4;
  readonly usbProductId = 0xea60;

  onOpen() {
    this.send('READY\r\n');
  }

  emitTemperature(value: number) {
    this.send(`temp=${value}\r\n`);
  }
}

const {client, simulatedDevice, whenOpened} =
  await createDeviceFixture(new Thermometer());

await client.open({baudRate: 115200});
await whenOpened();
simulatedDevice.emitTemperature(21.5);
expect(await client.readLine()).toBe('temp=21.5');
await client.close();
```

For the full guide to `SerialClient`, `createDeviceFixture`, fault injection, `runTestSuite`, `compareTestResults`, `exposeSimulatedDevice`, and the conformance suites, see [TESTING.md](TESTING.md).

## Remote serial over WebSocket

You can drive a real serial port plugged into another machine. This is useful for developing in a Chromium browser or an Android emulator that cannot see the USB device directly, or for remote debugging.

On the host machine, run the bundled CLI:

```sh
npx -p react-native-web-serial-api expose-serial-websocket \
  --port /dev/ttyUSB0 --baudrate 115200
# add --allow-remote to bind 0.0.0.0
```

In the app:

```ts
import {Serial} from 'react-native-web-serial-api';
import {WebSocketSerialTransport} from 'react-native-web-serial-api/websocket';

const serial = new Serial(new WebSocketSerialTransport('ws://localhost:8080'));
const [port] = await serial.getPorts();
await port.open({baudRate: 115200});
const writer = port.writable!.getWriter();
await writer.write(new TextEncoder().encode('Hello serial!\n'));
```

The example app includes this under Devices -> menu -> Remote serial (WebSocket).

The WebSocket carries raw serial bytes as binary frames and a small JSON control protocol as text frames (`setLineCoding`, `setSignals` / `getSignals`, `startReading` / `stopReading`, `flush`, `break`, and so on). By default the bridge binds to `localhost`. Use `--allow-remote` only on trusted networks.

## Troubleshooting

- If Android never shows your device, confirm USB host support and the device filter.
- If `requestPort()` does nothing on web, make sure it is called from a button tap or other user gesture.
- If the app works on web but not Android, check that New Architecture is enabled and the device has Android USB permission.
- If `getPorts()` is empty on Android, unplug and replug the device, then grant permission again if Android revoked it.

## How it works

The JavaScript layer in `src/` implements the Web Serial API on top of a thin TurboModule (`NativeUsbSerial`) whose native Android implementation in `android/src/main/java/dev/webserialapi/` wraps `usb-serial-for-android`. Reads and writes are bridged to `ReadableStream` / `WritableStream` via [`web-streams-polyfill`](https://github.com/MattiasBuelens/web-streams-polyfill) when the runtime does not already provide Web Streams globals.

## License

MIT © Aras Abbasi
