# Testing

This library is designed to be testable without USB hardware. The same code can run in Jest, on a real Android device, in the browser, or in an emulator.

The key idea is simple: all hardware access goes through a single transport interface, [`SerialTransport`](src/transport.ts), and you can swap in a pure JavaScript transport when you do not want to talk to real hardware.

## At a glance

- `new Serial(transport)` for isolated unit tests
- `setUsbSerial(transport)` for redirecting the singleton `serial`
- `InMemorySerialTransport` for loopback and simulated devices
- `SimulatedDevice` for authoring a full peripheral model
- `SerialClient` for host-side protocol tests
- `runTestSuite()` for reusable test suites that work in Jest and on real hardware
- `exposeSimulatedDevice()` for WebSocket-based E2E and emulator testing

## Transport layer

`Serial` resolves its transport in three ways, in order:

| Priority | How to use it | Best for |
| --- | --- | --- |
| 1 | `new Serial(transport)` | Isolated tests and explicit control |
| 2 | `setUsbSerial(transport)` | Redirecting the singleton `serial` |
| 3 | Default native transport | Real Android hardware |

```ts
import {Serial, setUsbSerial, resetUsbSerial} from 'react-native-web-serial-api';
import {InMemorySerialTransport} from 'react-native-web-serial-api/testing';

// Best for unit tests: the transport is explicit.
const transport = new InMemorySerialTransport();
const serial = new Serial(transport);

// Best when you want the singleton `serial` to use a virtual transport too.
setUsbSerial(transport);

// Restore the native default after the test.
resetUsbSerial();
```

The testing helpers live under the `react-native-web-serial-api/testing` subpath, so they stay out of your production bundle.

## Which test style should I use?

| Use case | Start with | Why |
| --- | --- | --- |
| Quick byte-level smoke test | `InMemorySerialTransport` + `LoopbackDevice` | Fast and deterministic |
| Stateful peripheral simulation | `SimulatedDevice` | Lets you model a real device protocol |
| Host-side protocol tests | `SerialClient` | Removes reader/writer boilerplate |
| Reusable suite against virtual and real devices | `runTestSuite()` | Same cases, different runtimes |
| App/emulator/browser talking to a simulated device | `exposeSimulatedDevice()` | WebSocket bridge with the same simulator |

## Fast in-memory test

`InMemorySerialTransport` is the core test transport. It can host one or more simulated devices and it does not depend on `react-native`, which is why the same code works in Jest and in browser-style environments.

```ts
import {InMemorySerialTransport, LoopbackDevice} from 'react-native-web-serial-api/testing';

const transport = new InMemorySerialTransport({
  latencyMs: 0, // 0 = resolve on a microtask, which is nice for Jest
  autoGrantPermission: true,
});

const device = transport.addDevice(
  new LoopbackDevice({
    usbVendorId: 0x0403,
    usbProductId: 0x6001,
    serialNumber: 'DEMO-1',
  }),
  {
    hasPermission: true,
    loopbackSignals: true,
  },
);
```

`LoopbackDevice` echoes bytes back to the host. `SinkDevice` accepts writes and produces no output.

### Driving a device from a test

```ts
device.push([0x01, 0x02]);       // device sends bytes to the host
device.emitError('cable fault'); // readable stream error
device.attach();                 // attach again and fire connect
device.detach();                 // detach and fire disconnect
device.loseDevice();             // unplug while open
device.failNext('open');         // make the next open() reject once
device.written;                  // everything the host wrote
```

You can also script the next permission prompt:

```ts
transport.selectNextPort(device);
transport.rejectNextPortPicker();
```

## Host-side protocol test

For a more realistic peripheral, extend `SimulatedDevice` and override lifecycle hooks.

```ts
import {Serial} from 'react-native-web-serial-api';
import {InMemorySerialTransport, SimulatedDevice} from 'react-native-web-serial-api/testing';

class Thermometer extends SimulatedDevice {
  usbVendorId = 0x0403;
  usbProductId = 0x6001;
  #timer?: ReturnType<typeof setInterval>;

  onOpen() {
    this.send('READY\r\n');
    this.#timer = setInterval(() => this.send(`temp=${20 + Math.random()}C\r\n`), 1000);
  }

  onData(bytes: Uint8Array) {
    if (String.fromCharCode(...bytes).trim() === 'ID?') {
      this.send('ACME-TEMP\r\n');
    }
  }

  onHostSignals() {
    // DTR/RTS/break changed
  }

  onClose() {
    clearInterval(this.#timer);
  }
}

const transport = new InMemorySerialTransport();
transport.addDevice(new Thermometer(), {hasPermission: true});
const serial = new Serial(transport);
```

Available hooks:

- `onOpen(options)`
- `onData(data)`
- `onHostSignals(signals)`
- `onClose()`

Helpers on `SimulatedDevice`:

- `this.send(bytesOrString)`
- `this.raiseError(message, name?)`
- `this.setSignals({dataCarrierDetect, clearToSend, ringIndicator, dataSetReady})`
- `this.openOptions`

## Writing unit tests

Inject the transport and exercise the real `Serial` / `SerialPort` logic.

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

The library tests themselves live under [`src/__tests__/`](src/__tests__). Because the transport layer imports `react-native`, Jest needs the React Native preset. See [`jest.config.js`](jest.config.js).

## Testing as the host: `SerialClient`

`SerialClient` is a timeout-aware wrapper around any `SerialPort`. It removes the boilerplate of managing `ReadableStream` readers and `WritableStream` writers in test code.

```ts
import {SerialClient} from 'react-native-web-serial-api/testing';

const client = new SerialClient(port);
await client.open({baudRate: 115200});

await client.write([0x01, 0x02, 0x03]);

const echo = await client.readBytes(3);
const frame = await client.readUntil([0xC0]);
const line = await client.readLine();
const chunk = await client.readAvailable();

await client.expectIdle(100);
await client.close();
```

All read methods accept `{timeout?: number}` and default to 5 seconds.

### Building a protocol client

`readAvailable()` is useful when you want to feed a framing decoder.

```ts
import {SerialClient} from 'react-native-web-serial-api/testing';
import {SlipDecoder} from './slip';

class MyProtocolClient {
  #client: SerialClient;
  #pending: MyMessage[] = [];

  static async open(port: SerialPort, baudRate = 115200) {
    const client = new MyProtocolClient(new SerialClient(port));
    await client.#client.open({baudRate});
    return client;
  }

  private constructor(client: SerialClient) {
    this.#client = client;
  }

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

  async close() {
    await this.#client.close();
  }
}
```

## One-call fixture: `createDeviceFixture`

`createDeviceFixture()` wires up a `SimulatedDevice` and returns the handles you usually need in a test.

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

const opened = whenOpened();
await client.open({baudRate: 115200});
await opened;

const meter = new WMBusMeter({address: ADDRESS, payloadTemplate: [0x01]});
simulatedDevice.addMeter(meter);
meter.sendTelegram();
const frame = await client.readAvailable();

await whenClosed();
await client.close();
```

Multiple devices at once:

```ts
const {ports, transport} = await createDeviceFixture([
  new WMBusGateway('iU891A-XL'),
  new NmeaGpsDevice(),
]);
```

If you pass `opts.installGlobally = true`, `createDeviceFixture()` calls `setUsbSerial(transport)` so the singleton `serial` also uses the virtual transport. Remember to call `resetUsbSerial()` in teardown.

## Lifecycle awaiting: `whenOpened` / `whenClosed`

`whenOpened()` and `whenClosed()` are available on both `createDeviceFixture()` and the lower-level `DeviceHandle`.

```ts
const device = transport.addDevice(new MyDevice(), {hasPermission: true});

const opts = await device.whenOpened(); // resolves on the next open
await device.whenClosed();             // resolves on the next close
```

Each call returns a fresh promise for the next transition, so you can use them in reconnect loops.

## Fault injection

`DeviceHandle` includes helpers for protocol and lifecycle failures.

```ts
device.push([0x01, 0x02]);
device.emitError('cable fault');

device.failNext('open');
device.failNext('write');
device.failNext('startReading');
device.overrunAfter(16);

device.loseDevice();
device.detach();
device.attach();

device.written;
device.isOpen;
```

These are useful for asserting protocol-level behavior:

```ts
device.failNext('write');
await expect(client.write([1, 2])).rejects.toThrow();
expect(device.written).toHaveLength(0);
```

## Writing a test suite: `runTestSuite` + `compareTestResults`

`runTestSuite()` lets you define a list of named serial tests and run them against different ports.

```ts
import {runTestSuite, compareTestResults, type SerialTest}
  from 'react-native-web-serial-api/testing';

const suite: SerialTest[] = [
  {
    name: 'echoes 4 bytes',
    async run(client) {
      await client.write([1, 2, 3, 4]);
      const echo = await client.readBytes(4);
      if (!echo.every((b, i) => b === [1, 2, 3, 4][i])) {
        throw new Error(`echo mismatch: got ${Array.from(echo)}`);
      }
    },
  },
];

const {port} = await createDeviceFixture(new LoopbackDevice());
const ref = await runTestSuite(suite, port, {open: {baudRate: 115200}});
const real = await runTestSuite(suite, realPort, {open: {baudRate: 115200}});
const agreed = compareTestResults(ref, real);
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `open` | `{baudRate: 9600}` | Forwarded to `port.open()` |
| `shared` | `true` | Reuse one client for all tests |
| `client` | - | Custom protocol client factory |
| `progress` | - | Live `onStart` / `onResult` callbacks |

### Custom protocol client

```ts
import {runTestSuite, type TestClient}
  from 'react-native-web-serial-api/testing';
import {HciHost} from './HciHost';

const results = await runTestSuite(hciSuite, port, {
  open: {baudRate: 115200},
  client: {
    connect: (p) => HciHost.open(p),
    disconnect: (host) => host.close(),
  } satisfies TestClient<HciHost>,
});
```

## WebSocket E2E: `exposeSimulatedDevice`

`exposeSimulatedDevice()` runs a simulator behind a WebSocket server so a real app, emulator, or browser can connect to it.

```ts
import {createDeviceFixture, runTestSuite} from 'react-native-web-serial-api/testing';

const {port} = await createDeviceFixture(new WMBusGateway('iU891A-XL'));
const results = await runTestSuite(wmbusSuite, port, {open: {baudRate: 115200}});
```

```ts
import {exposeSimulatedDevice} from 'react-native-web-serial-api/testing';
import {WebSocketServer} from 'ws'; // optional dependency

const ex = exposeSimulatedDevice(new WMBusGateway('iU891A-XL'), {
  port: 8090,
  WebSocketServer,
  // host: '0.0.0.0', // use this for a physical device or emulator
});

await ex.whenOpened();
await ex.close();
```

`ExposedDevice` gives you:

| Field | Type | Description |
| --- | --- | --- |
| `url` | `string` | URL for `WebSocketSerialTransport` |
| `simulatedDevice` | `D` | The concrete simulator |
| `device` | `DeviceHandle` | Low-level device handle |
| `whenOpened()` | `Promise<SimulatedDeviceOpenOptions>` | Resolves when the app opens the port |
| `whenClosed()` | `Promise<void>` | Resolves when the app closes the port |
| `close()` | `Promise<void>` | Stops the WebSocket server |

`ws` is loaded lazily, so importing from `react-native-web-serial-api/testing` is safe in React Native. The dependency is only needed when `exposeSimulatedDevice()` is called in Node.

## Fake-timer gotcha

`InMemorySerialTransport` delivers data via `queueMicrotask()` at the default `latencyMs: 0`. If your suite uses `jest.useFakeTimers()`, microtasks still run, but `SerialClient` read timeouts use `setTimeout`, so fake timers will stall reads unless you advance them.

```ts
beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: ['queueMicrotask'],
  });
});

it('streams data periodically', async () => {
  // start the device timer...
  jest.advanceTimersByTime(5000);
  const line = await client.readLine();
});
```

If your suite does not use periodic timers, real timers are usually simpler.

## The conformance suite

[`src/__tests__/conformance-suite.ts`](src/__tests__/conformance-suite.ts) exports `serialConformanceTests`, a set of self-contained cases that each build their own `Serial` and `InMemorySerialTransport`.

The suite is test-only code. It is excluded from the build and from the published package, and the same cases can run in both Jest and on-device.

```ts
import {serialConformanceTests} from './conformance-suite';

for (const test of serialConformanceTests) {
  it(test.name, () => test.run());
}
```

The same suite can also run through `runSerialConformance()`, which returns structured pass/fail results for use in the example app's Self Test screen.

```ts
import {runSerialConformance, runRealDeviceSmokeTest} from './conformance-suite';

const results = await runSerialConformance();
const smoke = await runRealDeviceSmokeTest(serial);
```

### Web Platform Tests

The `WPT ...` cases at the end of the conformance suite are ports of the official Web Platform Tests for the Web Serial API. They run against the virtual loopback device so the spec logic is exercised under Jest and on-device.

These cases cover things like:

- loopback read/write
- `readable.cancel()` behavior
- hardware flow-control back-pressure
- typed read errors such as `BreakError` and `BufferOverrunError`
- disconnect handling during pending operations
- the IDL shape of the interface

The browser-specific WPT cases around permission prompts and secure-context gating are intentionally not ported because they do not map to a React Native runtime.

## On-device testing (example app)

The [example app](example) includes two ways to test without hardware:

- **Self Test** screen: runs the conformance suite in-app and shows pass/fail
- **Virtual device (demo)** mode: injects an `InMemorySerialTransport` with simulated devices so the Devices -> Connect -> Terminal flow works without hardware

> Demo mode redirects the app's live serial transport, which only works on Android. On web, `serial` is the browser's native `navigator.serial`, so the library cannot override it. The Self Test screen still works everywhere because it creates its own `new Serial(new InMemorySerialTransport())`.

## E2E in the emulator

You can also run UI E2E tests against an app with no USB hardware by installing the mock transport at startup behind your own flag.

```ts
import {
  LoopbackDevice,
  installInMemorySerialTransport,
} from 'react-native-web-serial-api/testing';
import {MyThermometer} from './devices/MyThermometer';

installInMemorySerialTransport({
  enabled: process.env.RNWS_SERIAL_MOCK === '1',
  devices: [new LoopbackDevice(), new MyThermometer()],
});
```

`installInMemorySerialTransport()` builds an `InMemorySerialTransport` and calls `setUsbSerial()`, so `navigator.serial` now talks to your simulated devices.

The example app ships Maestro tests in [`example/.maestro/`](example/.maestro):

```sh
npm --prefix example run android
npm --prefix example run e2e

# or run host Jest first, then emulator E2E
npm run test:host+emulator
```

- `demo-echo.yaml` enables demo mode, connects to the echo device, sends a line, and checks that it round-trips.
- `self-test.yaml` opens Self Test, runs the conformance suite, and asserts success.

## Running the tests

```sh
npm test
npm run test:watch
npm run typecheck
npm run lint

npm test --prefix example
```

CI runs these checks plus a build step on every push or pull request.

## Coverage

```sh
npm run test:coverage
```

This prints a summary and writes an HTML report to `coverage/lcov-report/index.html`.
