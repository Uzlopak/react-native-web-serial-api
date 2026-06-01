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

An in-memory transport backing one or more simulated devices.

```ts
import {VirtualSerialTransport} from 'react-native-web-serial-api/testing';

const transport = new VirtualSerialTransport({
  latencyMs: 0,            // 0 = resolve on a microtask (deterministic for Jest)
  autoGrantPermission: true,
});

const device = transport.addDevice({
  usbVendorId: 0x0403,
  usbProductId: 0x6001,
  serialNumber: 'DEMO-1',
  hasPermission: true,     // false → hidden from getPorts() until requestPort()
  behavior: 'echo',        // 'echo' | 'silent' | (data, ctx) => reply bytes
  loopbackSignals: true,   // DTR→DSR+DCD, RTS→CTS, so getSignals reflects setSignals
});
```

### Device behaviors

| behavior        | effect                                                        |
| --------------- | ------------------------------------------------------------- |
| `'echo'`        | every byte written is sent straight back (default)            |
| `'silent'`      | writes are accepted but nothing is sent back                  |
| responder `fn`  | `(data, ctx) => number[] \| Uint8Array \| frames \| undefined` |

```ts
// Model a real protocol with a responder:
transport.addDevice({
  usbVendorId: 0x10c4,
  usbProductId: 0xea60,
  behavior: data => (data[0] === 0x3f ? [0x21] : undefined), // '?' -> '!'
});
```

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

## On-device testing (example app)

The [example app](example) ships two ways to test on real hardware (or none):

- **Self Test screen** (overflow menu → *Self test…*) runs the conformance suite
  in-app and shows pass/fail, plus a *Run on connected device* smoke test. This
  works on Android, web, and in an emulator with **no device attached**.
- **Virtual device (demo)** toggle (overflow menu) injects a
  `VirtualSerialTransport` (an echo FTDI + a responder "sensor") so the whole
  Devices → Connect → Terminal flow runs hardware-free.

> **Platform note:** demo mode redirects the app's live serial, which only works
> on Android (where `serial` is this library's polyfill). On web `serial` is the
> browser's native `navigator.serial`, which the library cannot inject into — but
> the Self-Test screen still works everywhere because it builds its own
> `new Serial(virtualTransport)`.

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
