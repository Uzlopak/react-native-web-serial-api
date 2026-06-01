# Testing

This library is designed to be testable **without USB hardware** — both in a
test runner (Jest, Vitest, …) and live on a device, an emulator, or in the
browser. One idea makes that possible: every path to the hardware goes through a
single interface, [`SerialTransport`](src/transport.ts), and you can swap in a
pure-JavaScript implementation.

```
 Serial / SerialPort ──depends on──► SerialTransport
                                          ▲           ▲
                          UsbSerialModule │           │ VirtualSerialTransport
                          (real, native)              (in-memory, no native deps)
```

Because `VirtualSerialTransport` has **no `react-native` dependency**, the same
code runs under Node/Jest, on a real Android device, and on the web.

---

## The transport seam

`Serial` resolves its transport in three ways, in order of precedence:

1. **Constructor injection** — `new Serial(transport)` (best for isolated tests).
2. **Global override** — `setUsbSerial(transport)` affects the singleton `serial`
   and any `new Serial()` created without an explicit transport.
3. **Default** — the real `UsbSerialModule` backed by the native TurboModule.

```ts
import {Serial, setUsbSerial, resetUsbSerial} from 'react-native-web-serial-api';
import {VirtualSerialTransport} from 'react-native-web-serial-api/testing';

// (1) explicit — recommended in unit tests
const transport = new VirtualSerialTransport();
const serial = new Serial(transport);

// (2) global — redirects the singleton `serial` too. Call it before the first
// getPorts()/requestPort()/addEventListener(). resetUsbSerial() restores default.
setUsbSerial(transport);
```

The testing utilities live in the **`react-native-web-serial-api/testing`**
subpath, so they stay out of your production bundle.

---

## VirtualSerialTransport

An in-memory transport backing one or more simulated devices. You register a
[`SerialDevice`](#simulating-a-whole-device-serialdevice) and the transport
reads its USB identity; `options` carries the transport-side knobs.

```ts
import {VirtualSerialTransport, EchoDevice} from 'react-native-web-serial-api/testing';

const transport = new VirtualSerialTransport({
  latencyMs: 0,            // 0 = resolve on a microtask (deterministic for Jest)
  autoGrantPermission: true,
});

const device = transport.addDevice(
  new EchoDevice({usbVendorId: 0x0403, usbProductId: 0x6001, serialNumber: 'DEMO-1'}),
  {
    hasPermission: true,   // false → hidden from getPorts() until requestPort()
    loopbackSignals: true, // DTR→DSR+DCD, RTS→CTS, so getSignals reflects setSignals
  },
);
```

`EchoDevice` (loopback) and `SilentDevice` (accepts writes, sends nothing) are
built in; for anything richer, write a `SerialDevice` (next section).

### Driving a device from a test/UI

```ts
device.push([0x01, 0x02]);        // inbound bytes as if the device sent them
device.emitError('cable fault');  // raise a read error on the readable stream
device.attach();                  // (re)attach → fires "connect" (new deviceId)
device.detach();                  // detach → fires "disconnect"
device.loseDevice();              // unplug while open: errors the stream, disconnects
device.failNext('open');          // make the next open()/write()/… reject once
device.written;                   // number[][] — everything the host wrote
```

`transport.selectNextPort(device)` / `transport.rejectNextPortPicker()` script
what the next `requestPort()` returns.

---

## Simulating a whole device (`SerialDevice`)

To model a *whole* peripheral — a stateful protocol that greets on open, streams
over time, reacts to control signals, and raises typed errors — extend
**`SerialDevice`** and override the lifecycle hooks:

```ts
import {SerialDevice, VirtualSerialTransport} from 'react-native-web-serial-api/testing';
import {Serial} from 'react-native-web-serial-api';

class Thermometer extends SerialDevice {
  usbVendorId = 0x0403;
  usbProductId = 0x6001;
  #timer?: ReturnType<typeof setInterval>;

  onOpen() {                          // host opened the port
    this.send('READY\r\n');
    this.#timer = setInterval(() => this.send(`temp=${20 + Math.random()}C\r\n`), 1000);
  }
  onData(bytes: Uint8Array) {         // host wrote to the device
    if (String.fromCharCode(...bytes).trim() === 'ID?') this.send('ACME-TEMP\r\n');
  }
  onHostSignals(s) { /* DTR/RTS/break changed */ }
  onClose() { clearInterval(this.#timer); }
}

const transport = new VirtualSerialTransport();
transport.addDevice(new Thermometer(), {hasPermission: true});
const serial = new Serial(transport);
```

Hooks: `onOpen(options)`, `onData(data)`, `onHostSignals(signals)`, `onClose()`
(all optional, may be async). Helpers: `this.send(bytes|string)`,
`this.raiseError(message, name?)` (e.g. `'BreakError'`),
`this.setSignals({dataCarrierDetect, clearToSend, ringIndicator, dataSetReady})`,
`this.openOptions`. **`EchoDevice`** (loopback), **`SilentDevice`**, and
**`LineDevice`** (buffers to `\n`, calls `onLine(line)`) are built in.
`addDevice(device, options?)` reads the device's
`usbVendorId`/`usbProductId`/`serialNumber`; `options` carries the transport
knobs (`hasPermission`, `portNumber`, …).

---

## Writing unit tests (Jest)

No native mocks required — inject the transport and exercise the real
`Serial`/`SerialPort` logic and streams:

```ts
import {Serial} from 'react-native-web-serial-api';
import {VirtualSerialTransport} from 'react-native-web-serial-api/testing';

it('echoes bytes through the streams', async () => {
  const transport = new VirtualSerialTransport();
  transport.addDevice({usbVendorId: 0x0403, usbProductId: 0x6001, hasPermission: true});
  const serial = new Serial(transport);

  const [port] = await serial.getPorts();
  await port.open({baudRate: 115200});

  const reader = port.readable!.getReader();
  const writer = port.writable!.getWriter();
  await writer.write(Uint8Array.from([1, 2, 3]));
  expect(Array.from((await reader.read()).value!)).toEqual([1, 2, 3]);
});
```

See [`src/__tests__/`](src/__tests__) for the library's own suites. Note: the
seam imports `react-native`, so a Jest setup needs the RN preset — see this
repo's [`jest.config.js`](jest.config.js).

---

## The conformance suite (one suite, two runtimes)

[`src/testing/conformance.ts`](src/testing/conformance.ts) exports
`serialConformanceTests` — self-contained cases (each builds its own
`Serial` + `VirtualSerialTransport`) with built-in assertions and **no
test-runner dependency**. The very same array runs:

- **under Jest** — [`src/__tests__/conformance.test.ts`](src/__tests__/conformance.test.ts):
  ```ts
  import {serialConformanceTests} from 'react-native-web-serial-api/testing';
  for (const t of serialConformanceTests) it(t.name, () => t.run());
  ```
- **on a device** — via `runSerialConformance()`, which returns a structured
  pass/fail result per test (it never throws).

```ts
import {runSerialConformance, runRealDeviceSmokeTest} from 'react-native-web-serial-api/testing';

const results = await runSerialConformance();           // virtual, full suite
const smoke = await runRealDeviceSmokeTest(serial);     // small, safe, real device
```

---

## WPT spec compliance

[`src/__tests__/wpt/`](src/__tests__/wpt) ports the **official Web Platform
Tests** for the Web Serial API (vendored in `tmp/serial/`) so the spec's own test
logic runs against our polyfill via the virtual loopback device — proof of W3C
compliance, not just our own assertions. It covers loopback read/write, flow
control, large-stream throughput, disconnect, typed read errors, and the
interface (IDL) shape.

Porting the spec faithfully originally surfaced five real gaps in the polyfill
(typed `BreakError`/`BufferOverrunError` on the readable; disconnect rejecting
the pending read/write with `NetworkError`; the `disconnect` event `target`; and
a leaked subscription on `readable.cancel()`). All are now **fixed** in
`WebSerial.ts`, and these tests pass as regression guards. See
[`src/__tests__/wpt/README.md`](src/__tests__/wpt/README.md) for the fix table
and the list of browser-security WPT files that don't apply to a non-browser
polyfill.

---

## On-device testing (example app)

The [example app](example) ships two ways to test on real hardware (or none):

- **Self Test screen** (overflow menu → *Self test…*) runs the conformance suite
  in-app and shows pass/fail, plus a *Run on connected device* smoke test. This
  works on Android, web, and in an emulator with **no device attached**.
- **Virtual device (demo)** toggle (overflow menu) injects a
  `VirtualSerialTransport` (an FTDI `EchoDevice` + a CP210x `SensorDevice`, both
  authored as `SerialDevice`s — see [example/src/devices/](example/src/devices))
  so the whole Devices → Connect → Terminal flow runs hardware-free.

> **Platform note:** demo mode redirects the app's live serial, which only works
> on Android (where `serial` is this library's polyfill). On web `serial` is the
> browser's native `navigator.serial`, which the library cannot inject into — but
> the Self-Test screen still works everywhere because it builds its own
> `new Serial(virtualTransport)`.

---

## E2E in the emulator

The same `SerialDevice` mocks let you run **UI E2E tests** against an app with no
USB hardware. Install the mock once at startup behind your own flag:

```ts
// index.js — debug/E2E build only
import {installSerialMock, EchoDevice} from 'react-native-web-serial-api/testing';
import {MyThermometer} from './devices/MyThermometer';

installSerialMock({
  enabled: process.env.RNWS_SERIAL_MOCK === '1',   // your own gate
  devices: [new EchoDevice(), new MyThermometer()],
});
```

`installSerialMock` builds a `VirtualSerialTransport` and calls `setUsbSerial`, so
`navigator.serial` now talks to your simulated devices.

The example app ships a **Maestro** suite ([example/.maestro/](example/.maestro))
that drives the real UI against the in-app mock (via the demo toggle):

```sh
# start an Android emulator, then:
npm --prefix example run android   # build + install the debug app (Metro)
npm --prefix example run e2e       # maestro test .maestro
```

- `demo-echo.yaml` — enable demo mode → connect to the FTDI echo device → send a
  line in the Terminal → assert it round-trips.
- `self-test.yaml` — open *Self test* → run the conformance suite → assert green.

This isn't wired into GitHub CI (it needs an emulator); run it locally or in an
emulator-equipped job. [Detox](https://wix.github.io/Detox/) works the same way —
the mock is what makes either runner hardware-free.

---

## Running the tests

```sh
npm test           # library unit + conformance suite
npm run typecheck
npm run lint

npm test --prefix example   # example app tests
```

CI runs all of the above plus a build check on every push/PR — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).
