# Testing

This library is designed to be testable **without USB hardware** — both in a
test runner (Jest, Vitest, …) and live on a device, an emulator, or in the
browser. One idea makes that possible: every path to the hardware goes through a
single interface, [`SerialTransport`](src/transport.ts), and you can swap in a
pure-JavaScript implementation.

```
 Serial / SerialPort ──depends on──► SerialTransport
                                          ▲           ▲
                          UsbSerialModule │           │ InMemorySerialTransport
                          (real, native)              (in-memory, no native deps)
```

Because `InMemorySerialTransport` has **no `react-native` dependency**, the same
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
import {InMemorySerialTransport} from 'react-native-web-serial-api/testing';

// (1) explicit — recommended in unit tests
const transport = new InMemorySerialTransport();
const serial = new Serial(transport);

// (2) global — redirects the singleton `serial` too. Call it before the first
// getPorts()/requestPort()/addEventListener(). resetUsbSerial() restores default.
setUsbSerial(transport);
```

The testing utilities live in the **`react-native-web-serial-api/testing`**
subpath, so they stay out of your production bundle.

---

## InMemorySerialTransport

An in-memory transport backing one or more simulated devices. You register a
[`SimulatedDevice`](#simulating-a-whole-device-SimulatedDevice) and the transport
reads its USB identity; `options` carries the transport-side knobs.

```ts
import {InMemorySerialTransport, LoopbackDevice} from 'react-native-web-serial-api/testing';

const transport = new InMemorySerialTransport({
  latencyMs: 0,            // 0 = resolve on a microtask (deterministic for Jest)
  autoGrantPermission: true,
});

const device = transport.addDevice(
  new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001, serialNumber: 'DEMO-1'}),
  {
    hasPermission: true,   // false → hidden from getPorts() until requestPort()
    loopbackSignals: true, // DTR→DSR+DCD, RTS→CTS, so getSignals reflects setSignals
  },
);
```

`LoopbackDevice` (loopback) and `SinkDevice` (accepts writes, sends nothing) are
built in; for anything richer, write a `SimulatedDevice` (next section).

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

## Simulating a whole device (`SimulatedDevice`)

To model a *whole* peripheral — a stateful protocol that greets on open, streams
over time, reacts to control signals, and raises typed errors — extend
**`SimulatedDevice`** and override the lifecycle hooks:

```ts
import {SimulatedDevice, InMemorySerialTransport} from 'react-native-web-serial-api/testing';
import {Serial} from 'react-native-web-serial-api';

class Thermometer extends SimulatedDevice {
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

const transport = new InMemorySerialTransport();
transport.addDevice(new Thermometer(), {hasPermission: true});
const serial = new Serial(transport);
```

Hooks: `onOpen(options)`, `onData(data)`, `onHostSignals(signals)`, `onClose()`
(all optional, may be async). Helpers: `this.send(bytes|string)`,
`this.raiseError(message, name?)` (e.g. `'BreakError'`),
`this.setSignals({dataCarrierDetect, clearToSend, ringIndicator, dataSetReady})`,
`this.openOptions`. **`LoopbackDevice`** (loopback), **`SinkDevice`**, and
**`LineBufferedDevice`** (buffers to `\n`, calls `onLine(line)`) are built in.
`addDevice(device, options?)` reads the device's
`usbVendorId`/`usbProductId`/`serialNumber`; `options` carries the transport
knobs (`hasPermission`, `portNumber`, …).

---

## Writing unit tests (Jest)

No native mocks required — inject the transport and exercise the real
`Serial`/`SerialPort` logic and streams:

```ts
import {Serial} from 'react-native-web-serial-api';
import {
  InMemorySerialTransport,
  LoopbackDevice,
} from 'react-native-web-serial-api/testing';

it('echoes bytes through the streams', async () => {
  const transport = new InMemorySerialTransport();
  transport.addDevice(
    new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
    {hasPermission: true},
  );
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

## Testing as the host: `SerialClient`

`SerialClient` is a fluent, timeout-aware wrapper around any `SerialPort` (virtual,
real-USB, or WebSocket-backed). It eliminates the boilerplate of managing
`ReadableStream` readers/writers in test code.

```ts
import {SerialClient} from 'react-native-web-serial-api/testing';

const client = new SerialClient(port);
await client.open({baudRate: 115200});

await client.write([0x01, 0x02, 0x03]);

// Read exactly N bytes (waits for partial chunks to arrive):
const echo = await client.readBytes(3);           // Uint8Array

// Read until a byte sequence appears (returns all bytes up to and including it):
const frame = await client.readUntil([0xC0]);     // SLIP/COBS frame end

// Read a line terminated by \n (strips \r):
const line = await client.readLine();             // string

// Feed a custom framing decoder (returns when predicate returns a byte count):
const msg = await client.readMatching(buf => {
  if (buf.length < 4) return false;               // need header first
  const len = (buf[2] << 8) | buf[3];
  return buf.length >= 4 + len ? 4 + len : false; // full frame
});

// Read whatever bytes have arrived (useful to feed SLIP/HCI/COBS decoders):
const chunk = await client.readAvailable();       // Uint8Array; waits for ≥1 byte

// Assert silence for a window:
await client.expectIdle(100);                     // rejects if bytes arrive

await client.close(); // idempotent; releases locks
```

All read methods accept `{timeout?: number}` (default 5 s).

### Building a protocol client on `SerialClient`

`readAvailable` is the right primitive for a framing decoder that accumulates
bytes until a complete message appears:

```ts
import {SerialClient} from 'react-native-web-serial-api/testing';
import {SlipDecoder} from './slip';

class MyProtocolClient {
  #client: SerialClient;
  #pending: MyMessage[] = [];

  static async open(port: SerialPort, baudRate = 115200) {
    const c = new MyProtocolClient(new SerialClient(port));
    await c.#client.open({baudRate});
    return c;
  }
  private constructor(client: SerialClient) { this.#client = client; }

  async recv(timeoutMs = 5000): Promise<MyMessage> {
    if (this.#pending.length) return this.#pending.shift()!;
    const decoder = new SlipDecoder();
    while (!this.#client.ended) {
      const chunk = await this.#client.readAvailable({timeout: timeoutMs});
      for (const frame of decoder.feed(chunk)) {
        this.#pending.push(parseHci(frame));
      }
      if (this.#pending.length) return this.#pending.shift()!;
    }
    throw new Error('port closed before message arrived');
  }

  async close() { await this.#client.close(); }
}
```

---

## One-call fixture: `createDeviceFixture`

`createDeviceFixture` wires up a `SimulatedDevice` in a single call and returns every
handle you need in a test:

```ts
import {createDeviceFixture} from 'react-native-web-serial-api/testing';
import {WMBusGateway} from './devices/wmbus/WMBusGateway';
import {WMBusMeter} from './devices/wmbus/WMBusMeter';

const ADDRESS = {
  manufacturerId: 0x1234,
  deviceId: 0x56789abc,
  version: 0x01,
  type: 0x07,
};

const {client, simulatedDevice, whenOpened, whenClosed} =
  await createDeviceFixture(new WMBusGateway('iU891A-XL'));

// host side — open the port and start talking
const opened = whenOpened();     // capture the promise before open()
await client.open({baudRate: 115200});
await opened;                    // resolves once the device processes onOpen()

// device side — drive the simulator
const meter = new WMBusMeter({address: ADDRESS, payloadTemplate: [0x01]});
simulatedDevice.addMeter(meter);
meter.sendTelegram();            // device emits a 0x20 frame
const frame = await client.readAvailable();

// close
await whenClosed();
await client.close();
```

Multiple devices at once:

```ts
const {ports, transport} = await createDeviceFixture([
  new WMBusGateway('iU891A-XL'),
  new NmeaGpsDevice(),
]);
// ports[0] → gateway, ports[1] → GPS
```

`opts.installGlobally = true` calls `setUsbSerial(transport)` so the singleton
`serial` also uses the virtual transport (call `resetUsbSerial()` in teardown).

---

## Lifecycle awaiting: `whenOpened` / `whenClosed`

Both `createDeviceFixture` and the lower-level `DeviceHandle` expose
`whenOpened()` / `whenClosed()` so a test can synchronise with the app rather
than polling:

```ts
const device = transport.addDevice(new MyDevice(), {hasPermission: true});

// Resolves the next time (or immediately if already open):
const opts = await device.whenOpened(); // {baudRate, dataBits, …}

// Resolves the next time the port is closed (or detached while open):
await device.whenClosed();
```

The promises are one-shot per call — each `whenOpened()`/`whenClosed()` call
returns a fresh promise for the *next* transition, so you can chain them:

```ts
await device.whenOpened();
device.push([0x20, 0x01, 0x02]);
await device.whenClosed();
// Reconnect cycle:
await device.whenOpened();
```

---

## Fault injection

`DeviceHandle` has a rich set of fault-injection handles:

```ts
device.push([0x01, 0x02]);         // device sends bytes to the host unprompted
device.emitError('cable fault');   // raises an error on the readable stream

device.failNext('open');           // next open() rejects once, then returns to normal
device.failNext('write');          // next write rejects
device.failNext('startReading');   // next startReading rejects
device.overrunAfter(16);           // after 16 bytes a BufferOverrunError fires
device.loseDevice();               // simulate unplug while open
device.detach();                   // fires "disconnect" (closes open port first)
device.attach();                   // re-attach (new deviceId, fires "connect")

device.written;                    // number[][] — every frame the host wrote
device.isOpen;                     // whether the port is currently open
```

Combine with `expect` for protocol-level assertions:

```ts
device.failNext('write');
await expect(client.write([1, 2])).rejects.toThrow();
expect(device.written).toHaveLength(0); // nothing got through
```

---

## Writing a test suite: `runTestSuite` + `compareTestResults`

`runTestSuite` runs an array of named tests against a port and returns
structured results — no test-runner dependency, so the same suite runs in Jest
(virtual port) **and on a real device** (USB or WebSocket):

```ts
import {runTestSuite, compareTestResults, type SerialTest}
  from 'react-native-web-serial-api/testing';

const suite: SerialTest[] = [
  {
    name: 'echoes 4 bytes',
    async run(client) {
      await client.write([1, 2, 3, 4]);
      const echo = await client.readBytes(4);
      if (!echo.every((b, i) => b === [1, 2, 3, 4][i]))
        throw new Error(`echo mismatch: got ${Array.from(echo)}`);
    },
  },
];

// Run against the virtual device:
const {port} = await createDeviceFixture(new LoopbackDevice());
const ref = await runTestSuite(suite, port, {open: {baudRate: 115200}});

// Run against the real device:
const real = await runTestSuite(suite, realPort, {open: {baudRate: 115200}});

// Pass only tests where BOTH runtimes agree (both passed or both failed):
const agreed = compareTestResults(ref, real);
```

`runTestSuite` options:

| Option | Default | Meaning |
|--------|---------|---------|
| `open` | `{baudRate:9600}` | Options forwarded to `port.open()` |
| `shared` | `true` | One `SerialClient` for all tests; `false` opens/closes per test |
| `client` | — | Custom `{connect, disconnect}` pair for protocol clients (see below) |
| `progress` | — | `{onStart?, onResult?}` callbacks for live UI updates |

### Custom protocol client

Pass `options.client` to use a custom client type with your suite (the same
client is passed to every `run` function):

```ts
import {runTestSuite, type TestClient}
  from 'react-native-web-serial-api/testing';
import {HciHost} from './HciHost';

const results = await runTestSuite(hciSuite, port, {
  open: {baudRate: 115200},
  client: {
    connect: (p) => HciHost.open(p),
    disconnect: (h) => h.close(),
  } satisfies TestClient<HciHost>,
});
```

---

## WebSocket E2E: `exposeSimulatedDevice`

`exposeSimulatedDevice` runs a `SimulatedDevice` simulator behind a real `ws`
WebSocket server, so a real app (on a device, an emulator, or the browser) can
connect to it with `new Serial(new WebSocketSerialTransport(url))` and exercise
the *same* simulated peripheral your Jest tests drive.

The test process keeps both handles: the `SimulatedDevice` (to drive the device
side) and the server URL (for the app to connect to). The same device-specific
suite can therefore run in two modes without any code changes:

```ts
// Jest (in-memory) ────────────────────────────────────────────────────────
import {createDeviceFixture, runTestSuite} from 'react-native-web-serial-api/testing';

const {port} = await createDeviceFixture(new WMBusGateway('iU891A-XL'));
const results = await runTestSuite(wmbusSuite, port, {open: {baudRate: 115200}});

// On-device / emulator (real WebSocket) ──────────────────────────────────
import {exposeSimulatedDevice} from 'react-native-web-serial-api/testing';
import {WebSocketServer} from 'ws';   // optional dep: npm i -D ws

const ex = exposeSimulatedDevice(new WMBusGateway('iU891A-XL'), {
  port: 8090,
  WebSocketServer,
  // host: '0.0.0.0',  // use this for a physical device or emulator
});
// app connects with: new Serial(new WebSocketSerialTransport('ws://10.0.2.2:8090'))
await ex.whenOpened();
const results = await runTestSuite(wmbusSuite, appPort, {open: {baudRate: 115200}});
await ex.close();
```

`ExposedDevice` fields:

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | `ws://host:port` — pass to `WebSocketSerialTransport` |
| `simulatedDevice` | `D` | The concrete simulator (typed — call `gateway.addMeter`, etc.) |
| `device` | `DeviceHandle` | Low-level handle (push/emitError/whenOpened/…) |
| `whenOpened()` | `Promise<SimulatedDeviceOpenOptions>` | Resolves when the app opens the port |
| `whenClosed()` | `Promise<void>` | Resolves when the app closes the port |
| `close()` | `Promise<void>` | Stops the WebSocket server |

`ws` is loaded lazily (via an indirect `require` the bundler cannot trace), so
importing from `react-native-web-serial-api/testing` is safe in a React Native
app — `ws` is only pulled in when `exposeSimulatedDevice` is actually called in
a Node process. Pass `options.WebSocketServer` to skip the lazy load entirely
(recommended in tests, since you control the import at the top of the file).

---

## Fake-timer gotcha

`InMemorySerialTransport` delivers data via `queueMicrotask` (at `latencyMs:0`,
the default). If your test uses `jest.useFakeTimers()`, microtasks still run
fine — but `SerialClient`'s read timeouts use `setTimeout`, so **fake timers
will stall reads unless you advance them**.

If your suite uses `setInterval` for periodic streaming, always opt out of
faking `queueMicrotask`:

```ts
beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['queueMicrotask'],
  });
});

it('streams data periodically', async () => {
  // ...start the device timer...
  jest.advanceTimersByTime(5000);  // fire the interval
  const line = await client.readLine();
  // ...
});
```

If your tests don't use `setInterval` or per-second streaming, you typically
don't need fake timers at all — real `setTimeout` in `SerialClient` ensures
that timeouts resolve (or reject) without any manual advancing.

---

## The conformance suite (one suite, two runtimes)

[`src/__tests__/conformance-suite.ts`](src/__tests__/conformance-suite.ts) exports
`serialConformanceTests` — self-contained cases (each builds its own
`Serial` + `InMemorySerialTransport`) with built-in assertions and **no
test-runner dependency**. It is **test-only code**: it is excluded from the
build and from the published npm package (it imports the shipped testing
utilities, not the other way round), so it adds nothing to consumers' bundles.
The very same array runs:

- **under Jest** — [`src/__tests__/conformance.test.ts`](src/__tests__/conformance.test.ts):
  ```ts
  import {serialConformanceTests} from './conformance-suite';
  for (const t of serialConformanceTests) it(t.name, () => t.run());
  ```
- **on a device** — via `runSerialConformance()`, which returns a structured
  pass/fail result per test (it never throws). The example app's Self-Test
  screen imports it directly from the test folder (a dev-only import — see
  [`example/src/screens/SelfTestScreen.tsx`](example/src/screens/SelfTestScreen.tsx)).

```ts
import {runSerialConformance, runRealDeviceSmokeTest} from './conformance-suite';

const results = await runSerialConformance();           // virtual, full suite
const smoke = await runRealDeviceSmokeTest(serial);     // small, safe, real device
```

---

## WPT spec compliance

The `WPT …` cases **at the end of the conformance suite**
([`src/__tests__/conformance-suite.ts`](src/__tests__/conformance-suite.ts)) are ports of the
**official Web Platform Tests** for the Web Serial API (vendored in
`tmp/serial/`), so the spec's own test logic runs against our polyfill via the
virtual loopback device — proof of W3C compliance, not just our own assertions.
They live in the conformance suite rather than a separate Jest-only file, so the
same spec tests run **under Jest *and* on-device** (Self Test screen), not just
in a browser. They cover loopback read/write (small + large, repeated),
`readable.cancel()` discarding buffered data, hardware flow-control
back-pressure, typed `BreakError`/`BufferOverrunError`, large PRNG-stream
integrity, disconnect during a pending read/write, and the interface (IDL) shape.

Porting the spec faithfully originally surfaced five real gaps in the polyfill
(typed `BreakError`/`BufferOverrunError` on the readable; disconnect rejecting
the pending read/write with `NetworkError`; the `disconnect` event `target`; and
a leaked subscription on `readable.cancel()`). All are now **fixed** in
`WebSerial.ts`, and these cases pass as regression guards. The browser-security
WPT files (permission prompts, secure-context, `requestPort()` user-gesture
gating) don't apply to a React Native polyfill and are intentionally not ported;
the PRNG-stream length is scaled down from the upstream 10 MB so the on-device
Self Test stays fast.

---

## On-device testing (example app)

The [example app](example) ships two ways to test on real hardware (or none):

- **Self Test screen** (overflow menu → *Self test…*) runs the conformance suite
  in-app and shows pass/fail, plus a *Run on connected device* smoke test. This
  works on Android, web, and in an emulator with **no device attached**.
- **Virtual device (demo)** toggle (overflow menu) injects an
  `InMemorySerialTransport` with simulated devices (for example an FTDI
  `LoopbackDevice` plus a CP210x `SensorDevice`, both authored as
  `SimulatedDevice`s — see [example/src/devices/](example/src/devices)) so the
  whole Devices → Connect → Terminal flow runs hardware-free.

> **Platform note:** demo mode redirects the app's live serial, which only works
> on Android (where `serial` is this library's polyfill). On web `serial` is the
> browser's native `navigator.serial`, which the library cannot inject into — but
> the Self-Test screen still works everywhere because it builds its own
> `new Serial(new InMemorySerialTransport())`.

---

## E2E in the emulator

The same `SimulatedDevice` mocks let you run **UI E2E tests** against an app with no
USB hardware. Install the mock once at startup behind your own flag:

```ts
// index.js — debug/E2E build only
import {
  LoopbackDevice,
  installInMemorySerialTransport,
} from 'react-native-web-serial-api/testing';
import {MyThermometer} from './devices/MyThermometer';

installInMemorySerialTransport({
  enabled: process.env.RNWS_SERIAL_MOCK === '1',   // your own gate
  devices: [new LoopbackDevice(), new MyThermometer()],
});
```

`installInMemorySerialTransport` builds an `InMemorySerialTransport` and calls
`setUsbSerial`, so `navigator.serial` now talks to your simulated devices.

The example app ships a **Maestro** suite ([example/.maestro/](example/.maestro))
that drives the real UI against the in-app mock (via the demo toggle):

```sh
# start an Android emulator, then:
npm --prefix example run android   # build + install the debug app (Metro)
npm --prefix example run e2e       # maestro test .maestro

# from the repo root: run host Jest first, then emulator E2E
npm run test:host+emulator
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
npm test            # library unit + conformance suite
npm run test:watch  # watch mode
npm run typecheck
npm run lint

npm test --prefix example   # example app tests
```

CI runs all of the above plus a build check on every push/PR — see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Coverage

```sh
npm run test:coverage
```

Prints a per-file table + summary and writes a browsable HTML report to
`coverage/lcov-report/index.html` (config in [`jest.config.js`](jest.config.js)).
