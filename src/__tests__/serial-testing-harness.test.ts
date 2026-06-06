/**
 * Tests for the shipped consumer testing API: `createDeviceFixture`, the fluent
 * `SerialClient`, and `whenOpened/whenClosed`.
 */
import {describe, expect, it, jest} from '@jest/globals';
import {
  assertRejects,
  createDeviceFixture,
  createSerialClient,
  LineBufferedDevice,
  LoopbackDevice,
  resetUsbSerial,
  SerialClient,
  SimulatedDevice,
  SinkDevice,
} from '../testing';

/** A line device that answers PING→PONG and echoes other lines uppercased. */
class CommandDevice extends LineBufferedDevice {
  readonly usbVendorId = 0x0403;
  readonly usbProductId = 0x6001;
  onLine(line: string): void {
    this.send(line === 'PING' ? 'PONG\r\n' : `${line.toUpperCase()}\r\n`);
  }
}

/** A device the test drives unprompted (e.g. a sensor pushing readings). */
class PushDevice extends SimulatedDevice {
  readonly usbVendorId = 0x10c4;
  readonly usbProductId = 0xea60;
  emit(data: number[] | Uint8Array | string): void {
    this.send(data);
  }
}

describe('createDeviceFixture + SerialClient', () => {
  it('round-trips a line protocol (test-as-host)', async () => {
    const {client} = await createDeviceFixture(new CommandDevice());
    await client.open({baudRate: 115200});
    await client.write('PING\n');
    expect(await client.readLine()).toBe('PONG');
    await client.write('hi\n');
    expect(await client.readLine()).toBe('HI');
    await client.close();
  });

  it('readBytes accumulates across chunkSize splits', async () => {
    const {client} = await createDeviceFixture(new LoopbackDevice(), {
      transport: {chunkSize: 2},
    });
    await client.open();
    await client.write([1, 2, 3, 4, 5]);
    expect(Array.from(await client.readBytes(5))).toEqual([1, 2, 3, 4, 5]);
    await client.close();
  });

  it('readUntil with empty delimiter consumes zero bytes and leaves buffer intact', async () => {
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([1, 2, 3]);
    const got = await client.readUntil([]);
    expect(Array.from(got)).toEqual([]); // 0 bytes consumed
    const rest = await client.readBytes(3);
    expect(Array.from(rest)).toEqual([1, 2, 3]); // buffer untouched
    await client.close();
  });

  it('readUntil finds a multi-byte delimiter at the very end of the buffer', async () => {
    // Guards the i + needle.length <= haystack.length boundary condition
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([0x01, 0x02, 0xc0, 0xc0]);
    const got = await client.readUntil([0xc0, 0xc0]);
    expect(Array.from(got)).toEqual([0x01, 0x02, 0xc0, 0xc0]);
    await client.close();
  });

  it('readMatching frames a length-prefixed message', async () => {
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    // [len, ...payload]; push in two chunks to prove buffering.
    SimulatedDevice.emit([3, 0xaa]);
    SimulatedDevice.emit([0xbb, 0xcc, 0x99]); // trailing 0x99 stays buffered
    const frame = await client.readMatching(buf =>
      buf.length >= 1 && buf.length >= buf[0] + 1 ? buf[0] + 1 : false,
    );
    expect(Array.from(frame)).toEqual([3, 0xaa, 0xbb, 0xcc]);
    await client.close();
  });

  it('expectIdle resolves for a silent device and rejects when data arrives', async () => {
    const {client, device} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await expect(client.expectIdle(50)).resolves.toBeUndefined();
    device.push([0x42]);
    await expect(client.expectIdle(50)).rejects.toThrow(
      /already buffered|received/,
    );
    await client.close();
  });

  it('readAvailable yields chunks for a decoder, and ended flips on close', async () => {
    const {
      client,
      simulatedDevice: SimulatedDevice,
      device,
    } = await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([1, 2, 3]);
    expect(Array.from(await client.readAvailable())).toEqual([1, 2, 3]);
    expect(client.ended).toBe(false);
    device.detach(); // device goes away → stream ends
    expect(Array.from(await client.readAvailable())).toEqual([]);
    expect(client.ended).toBe(true);
    await client.close();
  });

  it('close() is idempotent and releases the port for reopen', async () => {
    const {client, port} = await createDeviceFixture(new LoopbackDevice());
    await client.open();
    await client.close();
    await client.close(); // no throw
    // The stream locks are released, so the port can be opened again.
    await port.open({baudRate: 9600});
    expect(port.readable).not.toBeNull();
    await port.close();
  });
});

describe('whenOpened / whenClosed', () => {
  it('whenOpened resolves after the app opens, with the negotiated options', async () => {
    const {port, whenOpened} = await createDeviceFixture(new LoopbackDevice());
    const opened = whenOpened();
    await port.open({baudRate: 57600});
    const options = await opened;
    expect(options.baudRate).toBe(57600);
  });

  it('whenOpened resolves immediately when already open', async () => {
    const {port, whenOpened} = await createDeviceFixture(new LoopbackDevice());
    await port.open({baudRate: 9600});
    await expect(whenOpened()).resolves.toMatchObject({baudRate: 9600});
  });

  it('whenClosed resolves on close and on detach (unplug while open)', async () => {
    const a = await createDeviceFixture(new LoopbackDevice());
    await a.port.open({baudRate: 9600});
    const closed = a.whenClosed();
    await a.port.close();
    await expect(closed).resolves.toBeUndefined();

    const b = await createDeviceFixture(new LoopbackDevice());
    await b.port.open({baudRate: 9600});
    const lost = b.whenClosed();
    b.device.detach(); // unplugged while open
    await expect(lost).resolves.toBeUndefined();
  });

  it('exposes the concrete device type and the fault-injection handle', async () => {
    const {simulatedDevice: SimulatedDevice, device} =
      await createDeviceFixture(new PushDevice());
    // SimulatedDevice is typed as PushDevice (no cast needed):
    SimulatedDevice.emit([1]);
    // device is the VirtualSimulatedDevice handle:
    expect(device.written).toEqual([]);
    expect(typeof device.failNext).toBe('function');
  });
});

describe('createDeviceFixture (multiple devices)', () => {
  it('enumerates several ports and resolves whenOpened(index)', async () => {
    const {ports, whenOpened} = await createDeviceFixture([
      new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
      new LoopbackDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
    ]);
    expect(ports).toHaveLength(2);
    const opened = whenOpened(1);
    await ports[1].open({baudRate: 9600});
    await expect(opened).resolves.toMatchObject({baudRate: 9600});
    await ports[1].close();
  });

  it('whenOpened(index) resolves immediately when the port is already open', async () => {
    const {ports, whenOpened} = await createDeviceFixture([
      new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
      new LoopbackDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
    ]);
    await ports[0].open({baudRate: 9600});
    // Called AFTER open — fast-return path in mount.ts
    await expect(whenOpened(0)).resolves.toMatchObject({baudRate: 9600});
    await ports[0].close();
  });
});

describe('SerialClient — coverage gaps', () => {
  it('close() during a blocked readBytes() resolves with whatever was buffered', async () => {
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([1, 2]);
    // Let the pump deliver the 2 bytes before starting the blocked read.
    await new Promise(r => setTimeout(r, 0));
    const readPromise = client.readBytes(10); // needs 10, only 2 available
    await client.close(); // must unblock the read
    expect(Array.from(await readPromise)).toEqual([1, 2]);
  });

  it('readBytes timeout message includes the byte count', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await expect(client.readBytes(5, {timeout: 50})).rejects.toThrow(
      /timed out reading 5 bytes/,
    );
    await client.close();
  });

  it('readBytes hits the immediate timeout path when the deadline is already expired', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    const now = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await expect(client.readBytes(1, {timeout: 0})).rejects.toThrow(
        /timed out reading 1 bytes/,
      );
    } finally {
      dateNow.mockRestore();
      await client.close();
    }
  });

  it('readUntil timeout message is descriptive', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await expect(client.readUntil([0x00], {timeout: 50})).rejects.toThrow(
      /timed out reading until/,
    );
    await client.close();
  });

  it('readLine timeout message is descriptive', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await expect(client.readLine({timeout: 50})).rejects.toThrow(
      /timed out reading until/,
    );
    await client.close();
  });

  it('readMatching timeout message is descriptive', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await expect(
      client.readMatching(() => false, {timeout: 50}),
    ).rejects.toThrow(/timed out waiting for a frame/);
    await client.close();
  });

  it('readAvailable timeout message is descriptive', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await expect(client.readAvailable({timeout: 50})).rejects.toThrow(
      /timed out waiting for data/,
    );
    await client.close();
  });

  it('expectIdle resolves when the stream ends with no data during the window', async () => {
    const {client, device} = await createDeviceFixture(new SinkDevice());
    await client.open();
    device.detach(); // stream ends, nothing buffered
    await expect(client.expectIdle(100)).resolves.toBeUndefined();
  });

  it('readAvailable returns an empty chunk when the stream ends with no buffered data', async () => {
    const {client, device} = await createDeviceFixture(new SinkDevice());
    await client.open();
    device.detach(); // stream ends, nothing buffered
    expect(Array.from(await client.readAvailable({timeout: 100}))).toEqual([]);
  });

  it('readAvailable returns an empty chunk after client.close()', async () => {
    const {client} = await createDeviceFixture(new SinkDevice());
    await client.open();
    await client.close();
    expect(Array.from(await client.readAvailable({timeout: 100}))).toEqual([]);
  });

  it('isOpen is false before open() and true after', async () => {
    const {port} = await createDeviceFixture(new LoopbackDevice());
    const client = new SerialClient(port);
    expect(client.isOpen).toBe(false);
    await client.open();
    expect(client.isOpen).toBe(true);
    // Second open() is idempotent — no throw, still open
    await client.open();
    expect(client.isOpen).toBe(true);
    await client.close();
    expect(client.isOpen).toBe(false);
  });

  it('createSerialClient returns a SerialClient instance', async () => {
    const {port} = await createDeviceFixture(new LoopbackDevice());
    const client = createSerialClient(port);
    expect(client).toBeInstanceOf(SerialClient);
    await client.open();
    await client.close();
  });

  it('.port getter returns the underlying SerialPort', async () => {
    // Covers serial-test-harness.ts line 59: return this.#port
    const {port} = await createDeviceFixture(new LoopbackDevice());
    const client = new SerialClient(port);
    expect(client.port).toBe(port);
  });

  it('write() throws when the harness is not open', async () => {
    const {port} = await createDeviceFixture(new LoopbackDevice());
    const client = new SerialClient(port);
    await expect(client.write([1])).rejects.toThrow(
      'SerialClient is not open.',
    );
  });

  it('installGlobally sets the transport as the global USB serial', async () => {
    await createDeviceFixture(new LoopbackDevice(), {installGlobally: true});
    resetUsbSerial();
  });

  it('expectIdle throws immediately when bytes are already buffered', async () => {
    // Covers serial-test-harness.ts line 231: throw new Error(...buffered...)
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([1, 2, 3]);
    await new Promise(r => setTimeout(r, 0)); // let bytes arrive
    await expect(client.expectIdle(50)).rejects.toThrow(/already buffered/);
    await client.close();
  });

  it('close() before open() succeeds without error', async () => {
    const {port} = await createDeviceFixture(new LoopbackDevice());
    const client = new SerialClient(port);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('readLine strips LF but not absent CR (line ending is \\n only)', async () => {
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([0x48, 0x69, 0x0a]); // 'Hi\n' — LF only, no CR
    expect(await client.readLine()).toBe('Hi');
    await client.close();
  });

  it('readLine returns buffered text when stream ends without \\n', async () => {
    const {
      client,
      simulatedDevice: SimulatedDevice,
      device,
    } = await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([0x48, 0x69]); // 'Hi' — no trailing newline
    const linePromise = client.readLine({timeout: 500});
    device.detach(); // end the stream before \n arrives
    expect(await linePromise).toBe('Hi');
  });

  it('readLine still drains bytes that land in the end-of-stream race window', async () => {
    const {
      client,
      simulatedDevice: SimulatedDevice,
      device,
    } = await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([0x48, 0x69]);
    device.detach(); // end the stream before the microtask-delivered bytes land
    expect(await client.readLine({timeout: 500})).toBe('Hi');
  });

  it('drain() clears buffered bytes', async () => {
    // Covers serial-test-harness.ts line 250: this.#pending.length = 0
    const {client, simulatedDevice: SimulatedDevice} =
      await createDeviceFixture(new PushDevice());
    await client.open();
    SimulatedDevice.emit([1, 2, 3]);
    await new Promise(r => setTimeout(r, 0)); // let bytes arrive
    client.drain();
    // After drain, readBytes should block (nothing buffered)
    const readPromise = client.readBytes(1, {timeout: 50});
    await expect(readPromise).rejects.toThrow(/timed out/);
    await client.close();
  });
});

describe('assertRejects — coverage gaps', () => {
  it('accepts a RegExp as the expected message matcher', async () => {
    // Covers harness.ts lines 59-63: expected.message instanceof RegExp path
    await assertRejects(
      () => Promise.reject(new Error('connection refused')),
      'should throw',
      {message: /refused/},
    );
  });

  it('accepts a plain string as the expected message matcher', async () => {
    await assertRejects(
      () => Promise.reject(new Error('connection refused')),
      'should throw',
      {message: 'refused'},
    );
  });

  it('throws when the error message does not match the RegExp', async () => {
    await expect(
      assertRejects(() => Promise.reject(new Error('timeout')), 'label', {
        message: /refused/,
      }),
    ).rejects.toThrow(/label.*expected the error message to match/);
  });
});

describe('createDeviceFixture (whenClosed with index)', () => {
  it('whenClosed(index) resolves when the specified device closes', async () => {
    const {ports, whenClosed} = await createDeviceFixture([
      new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
      new LoopbackDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
    ]);
    await ports[0].open({baudRate: 9600});
    const closed = whenClosed(0);
    await ports[0].close();
    await expect(closed).resolves.toBeUndefined();
  });
});

describe('createDeviceFixture (race paths)', () => {
  it('whenOpened() without index resolves when any device opens', async () => {
    // Covers mount.ts line 139: Promise.race path
    const {ports, whenOpened} = await createDeviceFixture([
      new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
      new LoopbackDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
    ]);
    const raceOpened = whenOpened(); // no index → Promise.race
    await ports[1].open({baudRate: 9600});
    await expect(raceOpened).resolves.toMatchObject({baudRate: 9600});
    await ports[1].close();
  });

  it('whenClosed() without index resolves when any device closes', async () => {
    // Covers mount.ts line 143: Promise.race path
    const {ports, whenClosed} = await createDeviceFixture([
      new LoopbackDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
      new LoopbackDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
    ]);
    await ports[0].open({baudRate: 9600});
    const raceClosed = whenClosed(); // no index → Promise.race
    await ports[0].close();
    await expect(raceClosed).resolves.toBeUndefined();
  });
});

describe('VirtualSimulatedDevice.whenClosed', () => {
  it('resolves immediately when the device is not open', async () => {
    // Covers virtual-serial-device.ts line 262: return Promise.resolve()
    const {device} = await createDeviceFixture(new LoopbackDevice());
    // Port was never opened, so whenClosed() should resolve immediately
    await expect(device.whenClosed()).resolves.toBeUndefined();
  });
});
