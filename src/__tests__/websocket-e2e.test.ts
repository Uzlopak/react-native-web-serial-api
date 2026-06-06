/**
 * End-to-end proof that a device simulator exposed with `exposeSerialDevice`
 * over a REAL `ws` server can be driven by the REAL `WebSocketSerialTransport`
 * client — in one Node process, no emulator. This is the on-device E2E path
 * (app ⇄ ws ⇄ simulator) exercised without a device: the SAME `SerialClient`
 * code and `runSerialTests` suite that run in-memory also run over the socket.
 */

import {createServer} from 'node:net';
import {afterEach, describe, expect, it} from '@jest/globals';
import {WebSocket, WebSocketServer} from 'ws';
import {
  EchoDevice,
  type ExposedSerialDevice,
  exposeSerialDevice,
  runSerialTests,
  SerialClient,
  type SerialTest,
} from '../testing';
import {Serial} from '../WebSerial';
import {
  type WebSocketCtor,
  WebSocketSerialTransport,
} from '../websocket/WebSocketSerialTransport';

const FTDI = {usbVendorId: 0x0403, usbProductId: 0x6001} as const;

/** Grab a free TCP port so parallel test runs don't collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let exposed: ExposedSerialDevice | null = null;

afterEach(async () => {
  await exposed?.close();
  exposed = null;
});

/** Expose `device` over a real ws server and return an opened client port. */
async function connect(exposedDevice: ExposedSerialDevice) {
  exposed = exposedDevice;
  const transport = new WebSocketSerialTransport(exposedDevice.url, {
    WebSocket: WebSocket as unknown as WebSocketCtor,
    reconnect: false,
  });
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) throw new Error('the WebSocket transport exposed no port');
  return port;
}

describe('exposeSerialDevice ⇄ WebSocketSerialTransport (real sockets)', () => {
  it('round-trips host writes and test-driven device pushes over the socket', async () => {
    const port = await freePort();
    const ex = exposeSerialDevice(new EchoDevice(FTDI), {
      port,
      WebSocketServer,
    });
    const serialPort = await connect(ex);

    const client = new SerialClient(serialPort);
    const opened = ex.whenOpened();
    await client.open({baudRate: 115200});
    await expect(opened).resolves.toMatchObject({baudRate: 115200});

    // app → socket → device → echo → socket → app
    await client.write([1, 2, 3, 4]);
    expect(Array.from(await client.readBytes(4))).toEqual([1, 2, 3, 4]);

    // the test drives the device; the bytes arrive at the app over the socket
    ex.device.push([0xaa, 0xbb]);
    expect(Array.from(await client.readBytes(2))).toEqual([0xaa, 0xbb]);

    await client.close();
  }, 15000);

  it('runs a runSerialTests suite unchanged over the WebSocket port', async () => {
    const port = await freePort();
    const ex = exposeSerialDevice(new EchoDevice(FTDI), {
      port,
      WebSocketServer,
    });
    const serialPort = await connect(ex);

    const suite: SerialTest[] = [
      {
        name: 'echo round-trips over WebSocket',
        async run(c) {
          await c.write([9, 8, 7]);
          const got = Array.from(await c.readBytes(3));
          if (got.join(',') !== '9,8,7') throw new Error(`got [${got}]`);
        },
      },
    ];
    const results = await runSerialTests(suite, serialPort, {
      open: {baudRate: 115200},
    });
    expect(results.map(r => [r.name, r.passed])).toEqual([
      ['echo round-trips over WebSocket', true],
    ]);
  }, 15000);
});
