# react-native-web-serial-api

> The [W3C Web Serial API](https://wicg.github.io/serial/) (`navigator.serial`) for **React Native on Android**, backed by a USB-serial TurboModule built on top of [`mik3y/usb-serial-for-android`](https://github.com/mik3y/usb-serial-for-android).

Talk to USB serial devices (FTDI, CP210x, CH340/CH341, PL2303, CDC-ACM …) from React Native using the **exact same API you already know from the browser** — `serial.requestPort()`, `port.open()`, `port.readable`, `port.writable`, and so on.

- Spec-compliant `Serial` / `SerialPort` implementation (`getPorts`, `requestPort`, `open`, `close`, `readable`, `writable`, `setSignals`, `getSignals`, `forget`, `connect`/`disconnect` events)
- New Architecture **TurboModule**
- Native port-picker dialog + USB permission handling
- Backed by Web Streams (`ReadableStream` / `WritableStream`)
- Drop-in for code written against the browser Web Serial API (on web it transparently uses the native `navigator.serial`)

> **Platform support:** Android only. On web (`react-native-web`) the package delegates to the browser's native Web Serial API. There is no iOS implementation (iOS does not allow generic USB-serial access), so iOS autolinking is disabled.

## Installation

```sh
npm install react-native-web-serial-api
# or
yarn add react-native-web-serial-api
```

This is a New Architecture library, so make sure your app has the New Architecture enabled (default in recent React Native). No manual linking is required — the module is autolinked.

### Android setup

The library ships its own `AndroidManifest.xml` that declares the port-picker activity, the detach receiver, and the `android.hardware.usb.host` feature, so usually **no extra configuration is needed**.

If you want your app to be **launched automatically when a matching device is plugged in**, add an intent filter to your launcher activity in `android/app/src/main/AndroidManifest.xml`:

```xml
<activity android:name=".MainActivity" ...>
  <intent-filter>
    <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
  </intent-filter>
  <!-- The device_filter resource is provided by the library -->
  <meta-data
    android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
    android:resource="@xml/device_filter" />
</activity>
```

The bundled `@xml/device_filter` matches the common USB-serial chips (CDC-ACM, FTDI `0x0403`, CP210x `0x10C4`, CH34x `0x1A86`, PL2303 `0x067B`). Provide your own `res/xml/device_filter.xml` to override it.

## Usage

```ts
import {serial} from 'react-native-web-serial-api';

async function run() {
  // Shows a native dialog to pick a port, then requests USB permission.
  const port = await serial.requestPort({
    filters: [{usbVendorId: 0x0403}], // optional — e.g. only FTDI devices
  });

  await port.open({baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none'});

  // Write
  const writer = port.writable.getWriter();
  await writer.write(new TextEncoder().encode('Hello\n'));
  writer.releaseLock();

  // Read
  const reader = port.readable.getReader();
  const {value} = await reader.read(); // value is a Uint8Array
  console.log(value);
  reader.releaseLock();

  await port.close();
}
```

In Android USB mode, `allowedBluetoothServiceClassIds` is not supported by
`requestPort()` and will throw a `TypeError` if provided.

### Control & status signals

```ts
await port.setSignals({dataTerminalReady: true, requestToSend: false});
const {clearToSend, dataCarrierDetect, ringIndicator, dataSetReady} =
  await port.getSignals();
```

### Connect / disconnect events

```ts
serial.addEventListener('connect', () => console.log('device attached'));
serial.addEventListener('disconnect', () => console.log('device detached'));

port.addEventListener('disconnect', () => console.log('this port went away'));
```

On Android, `serial` fires `connect` when a USB device is **attached** _and_ when
the app is **granted USB permission** for a device (the latter matters because
Android revokes permission on unplug, so a re-attached device only becomes
accessible — and shows up in `getPorts()` — once permission is re-granted).
Simply subscribing with `serial.addEventListener('connect', …)` is enough to
receive these; you don't need to call `getPorts()` first. A common pattern is to
re-run `getPorts()` on every `connect`/`disconnect` to keep a device list fresh.

### Listing already-permitted ports

```ts
const ports = await serial.getPorts();
```

## Permission model (Android vs. Web Serial)

There are two distinct notions of "permission" in play, and they behave
differently on Android than in the browser:

- **Web Serial permission grant** — `serial.requestPort()`. In the browser this
  records a site-level grant for the chosen port; on Android it shows a native
  picker and requests the Android USB permission for the selected device. This
  is the mechanism for gaining access to a device you don't have access to yet,
  and it is **unchanged** by anything below.
- **Native Android USB permission** — `UsbManager` permission for a device.
  This can be granted **outside** the app entirely: when you plug a device in,
  Android may show its own _"Open <app> to handle this USB device? / use by
  default for this device"_ dialog, or the app may have been launched via a
  `USB_DEVICE_ATTACHED` intent filter. In those cases the app already holds USB
  permission without ever calling `requestPort()`.

**`serial.getPorts()` in Android/native mode** returns **every probed
USB-serial port the app can currently access through Android USB permission** —
regardless of how that permission was obtained. So a device granted via the
system attach dialog appears in `getPorts()` even though `requestPort()` was
never called for it. Probed devices the app does **not** yet have permission for
are excluded; use `requestPort()` to gain access to those.

```ts
// All devices accessible right now (natively-granted OR previously requested):
const ports = await serial.getPorts();

// Gain access to a device you don't have permission for yet:
const port = await serial.requestPort();
```

On the **web**, `getPorts()` returns the ports the user has previously granted
the site via `requestPort()` (the browser's persistent permission store) — the
native "attach dialog" notion does not apply.

> Note: this is a deliberate, Android-appropriate reading of the Web Serial
> spec's `getPorts()` ("ports the site has been granted access to"). On Android
> the unit of access is the OS-level USB permission, so a device the OS has
> already authorized for the app is, by definition, one the app has been
> granted access to.

## API

The package exposes:

| Export | Description |
| --- | --- |
| `serial` | A ready-to-use `Serial` instance (`navigator.serial` equivalent). |
| `Serial`, `SerialPort` | The Web Serial API classes. |
| `UsbSerial` | Lower-level access to the raw USB-serial TurboModule (Android only). |
| `Event`, `EventTarget` | The event primitives used by the polyfill. |
| Types | `SerialOptions`, `SerialOutputSignals`, `SerialInputSignals`, `SerialPortInfo`, `SerialPortFilter`, `SerialPortRequestOptions`. |

## Example app

The [`example/`](./example) app is a React Native port of [SimpleUsbTerminal](https://github.com/kai-morich/SimpleUsbTerminal) built entirely on this package's Web Serial API — a **Devices** list (with baud-rate selection) and a **Terminal** (colored receive/send log, HEX mode, newline selection, clear, control-lines row with RTS/DTR toggles, flow control, and Send BREAK).

```sh
# install the library's build tooling
npm install

# install and run the example on Android
cd example
npm install
npm run android
```

Because it uses the Web Serial API, a few SimpleUsbTerminal details map differently:

- **Driver/chip name** isn't exposed by the Web Serial API (`getInfo()` returns only VID/PID), so rows show `Vendor/Product` plus a best-effort chip label from known vendor IDs.
- **Flow control** is limited to *None* / *Hardware (RTS-CTS)* — XON/XOFF and DTR/DSR aren't in the Web Serial spec. Changing it reconnects the port.
- The Android background **foreground-service notification** is omitted (it's service plumbing unrelated to serial I/O).

### Run the example in the browser

The example also runs as a web app via [`react-native-web`](https://necolas.github.io/react-native-web/) + [Vite](https://vite.dev/). On web, the package delegates to the browser's native `navigator.serial`, so the exact same `App.tsx` talks to real serial hardware over WebUSB-style permissions.

```sh
cd example
npm install
npm run web          # dev server at http://localhost:5173
# npm run web:build  # production build into example/dist
```

> Web Serial only works in **Chromium-based browsers** (Chrome / Edge / Opera) over a **secure context** (`http://localhost` counts), and `requestPort()` must be called from a user gesture — the demo's "Request port" button handles that.

## How it works

The JavaScript layer (`src/`) implements the Web Serial API on top of a thin TurboModule (`NativeUsbSerial`) whose native Android implementation (`android/src/main/java/dev/webserialapi/`) wraps `usb-serial-for-android`. Reads/writes are bridged to `ReadableStream`/`WritableStream` via [`web-streams-polyfill`](https://github.com/MattiasBuelens/web-streams-polyfill).

## Testing

The hardware layer sits behind a single injectable `SerialTransport` interface, so you can test against a pure-JS **virtual serial device** instead of real USB hardware — in Jest *and* live on a device/emulator/browser. The same conformance suite runs in both places, and the example app has a **Self Test** screen plus a **Virtual device (demo)** mode.

```ts
import {Serial} from 'react-native-web-serial-api';
import {InMemorySerialTransport, LoopbackDevice} from 'react-native-web-serial-api/testing';

const transport = new InMemorySerialTransport();
transport.addDevice(new LoopbackDevice(), {hasPermission: true});
const serial = new Serial(transport); // no native module, no hardware
```

### Writing a virtual serial device

You author a peripheral by extending **`SimulatedDevice`** and overriding the lifecycle hooks (`onOpen`, `onData`, `onClose`); `this.send(...)` streams bytes back to the host. Registering it with `transport.addDevice()` hands you back a **`DeviceHandle`** — the handle a test or demo uses to drive it, like a human plugging in cables.

```ts
import {SimulatedDevice} from 'react-native-web-serial-api/testing';

// The peripheral's "firmware": greet on open, answer "ID?", stream readings.
class Thermometer extends SimulatedDevice {
  readonly usbVendorId = 0x10c4; // CP210x
  readonly usbProductId = 0xea60;
  #timer?: ReturnType<typeof setInterval>;

  onOpen() {
    this.send('READY\r\n');
    this.#timer = setInterval(() => this.send(`temp=${20 + Math.random() * 5}\r\n`), 1000);
  }
  onData(bytes: Uint8Array) {
    if (String.fromCharCode(...bytes).trim() === 'ID?') this.send('ACME-TEMP\r\n');
  }
  onClose() {
    clearInterval(this.#timer);
  }
}
```

`SimulatedDevice` is what *you* write (the device behaviour); `DeviceHandle` is the transport-side handle `addDevice` returns, so you can drive and inspect the device without putting any bytes on the wire:

```ts
const transport = new InMemorySerialTransport();
const device = transport.addDevice(new Thermometer(), {hasPermission: true});

device.push([0x48, 0x69]); // device emits bytes to the host, unprompted
device.loseDevice();       // simulate an unplug (errors any open stream)
device.attach();           // plug it back in (fires "connect" with a fresh id)
device.written;            // frames the host has written to the device (for assertions)
```

For a fuller, **DRY** worked example see the example app's **NMEA 0183 GPS emulator** in [`example/src/devices/gps/`](example/src/devices/gps/): it streams `$GPGGA`/`$GPRMC`/… for a configurable position (default: the Greenwich Royal Observatory) and exposes an `update()` method to change position, satellites, and signal strength at runtime — no serial round-trip. It also ships a **conformance suite** ([`gps/conformance.ts`](example/src/devices/gps/conformance.ts)) of talker-agnostic NMEA 0183 checks that run against the emulator under Jest and against a real receiver (e.g. a u-blox) from the example app's **Self Test** screen.

```sh
npm test               # unit + WPT conformance suites
npm run test:coverage  # coverage report (HTML in coverage/lcov-report)
```

See **[TESTING.md](TESTING.md)** for the full guide: authoring a `SimulatedDevice`, `SerialClient` (fluent test driver), `createDeviceFixture` (one-call fixture with `whenOpened`/`whenClosed`), fault injection, `runTestSuite` + `compareTestResults` (one suite, two runtimes), `exposeSerialDevice` (WebSocket E2E against a real app), the conformance/WPT suites, and coverage.

## Remote serial over WebSocket

Drive a **real** serial port that's plugged into another machine — handy for developing in a Chromium browser or an Android emulator that can't see the USB device, or for remote debugging. A small Node bridge exposes the host's serial port over a WebSocket; the app talks to it through `WebSocketSerialTransport`, which is just another `SerialTransport` — so the whole Web Serial API works on top of it unchanged.

**On the host** (where the device is plugged in), run the bundled CLI (needs the optional `serialport` + `ws` deps, installed automatically on Node hosts):

```sh
npx -p react-native-web-serial-api expose-serial-websocket \
  --port /dev/ttyUSB0 --baudrate 115200          # → ws://127.0.0.1:8080
# add --allow-remote to bind 0.0.0.0 (⚠ exposes the port to the network)
```

**In the app** (browser / React Native), point a `Serial` at it:

```ts
import {Serial} from 'react-native-web-serial-api';
import {WebSocketSerialTransport} from 'react-native-web-serial-api/websocket';

const serial = new Serial(new WebSocketSerialTransport('ws://localhost:8080'));
const [port] = await serial.getPorts();
await port.open({baudRate: 115200});
const writer = port.writable!.getWriter();
await writer.write(new TextEncoder().encode('Hello serial!\n'));
```

The example app has this built in: **Devices → menu → “Remote serial (WebSocket)”** (enter the bridge URL).

The WebSocket carries raw serial bytes as **binary** frames and a small JSON **control** protocol as text frames (`setLineCoding`, `setSignals`/`getSignals`, `startReading`/`stopReading`, `flush`, `break`, …). Note: the bridge binds to **localhost by default**; `--allow-remote` makes your serial port reachable from the network — only do that on trusted networks.

## License

MIT © Aras Abbasi
