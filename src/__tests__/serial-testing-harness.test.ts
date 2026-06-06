/**
 * Tests for the shipped consumer testing API: `mountSerialDevice`, the fluent
 * `SerialClient`, and `whenOpened/whenClosed`.
 */
import {describe, expect, it} from '@jest/globals';
import {
  EchoDevice,
  LineDevice,
  mountSerialDevice,
  SerialDevice,
  SilentDevice,
} from '../testing';

/** A line device that answers PING→PONG and echoes other lines uppercased. */
class CommandDevice extends LineDevice {
  readonly usbVendorId = 0x0403;
  readonly usbProductId = 0x6001;
  onLine(line: string): void {
    this.send(line === 'PING' ? 'PONG\r\n' : `${line.toUpperCase()}\r\n`);
  }
}

/** A device the test drives unprompted (e.g. a sensor pushing readings). */
class PushDevice extends SerialDevice {
  readonly usbVendorId = 0x10c4;
  readonly usbProductId = 0xea60;
  emit(data: number[] | Uint8Array | string): void {
    this.send(data);
  }
}

describe('mountSerialDevice + SerialClient', () => {
  it('round-trips a line protocol (test-as-host)', async () => {
    const {client} = await mountSerialDevice(new CommandDevice());
    await client.open({baudRate: 115200});
    await client.write('PING\n');
    expect(await client.readLine()).toBe('PONG');
    await client.write('hi\n');
    expect(await client.readLine()).toBe('HI');
    await client.close();
  });

  it('readBytes accumulates across chunkSize splits', async () => {
    const {client} = await mountSerialDevice(new EchoDevice(), {
      transport: {chunkSize: 2},
    });
    await client.open();
    await client.write([1, 2, 3, 4, 5]);
    expect(Array.from(await client.readBytes(5))).toEqual([1, 2, 3, 4, 5]);
    await client.close();
  });

  it('readMatching frames a length-prefixed message', async () => {
    const {client, serialDevice} = await mountSerialDevice(new PushDevice());
    await client.open();
    // [len, ...payload]; push in two chunks to prove buffering.
    serialDevice.emit([3, 0xaa]);
    serialDevice.emit([0xbb, 0xcc, 0x99]); // trailing 0x99 stays buffered
    const frame = await client.readMatching(buf =>
      buf.length >= 1 && buf.length >= buf[0] + 1 ? buf[0] + 1 : false,
    );
    expect(Array.from(frame)).toEqual([3, 0xaa, 0xbb, 0xcc]);
    await client.close();
  });

  it('expectIdle resolves for a silent device and rejects when data arrives', async () => {
    const {client, device} = await mountSerialDevice(new SilentDevice());
    await client.open();
    await expect(client.expectIdle(50)).resolves.toBeUndefined();
    device.push([0x42]);
    await expect(client.expectIdle(50)).rejects.toThrow(
      /already buffered|received/,
    );
    await client.close();
  });

  it('readAvailable yields chunks for a decoder, and ended flips on close', async () => {
    const {client, serialDevice, device} = await mountSerialDevice(
      new PushDevice(),
    );
    await client.open();
    serialDevice.emit([1, 2, 3]);
    expect(Array.from(await client.readAvailable())).toEqual([1, 2, 3]);
    expect(client.ended).toBe(false);
    device.detach(); // device goes away → stream ends
    expect(Array.from(await client.readAvailable())).toEqual([]);
    expect(client.ended).toBe(true);
    await client.close();
  });

  it('close() is idempotent and releases the port for reopen', async () => {
    const {client, port} = await mountSerialDevice(new EchoDevice());
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
    const {port, whenOpened} = await mountSerialDevice(new EchoDevice());
    const opened = whenOpened();
    await port.open({baudRate: 57600});
    const options = await opened;
    expect(options.baudRate).toBe(57600);
  });

  it('whenOpened resolves immediately when already open', async () => {
    const {port, whenOpened} = await mountSerialDevice(new EchoDevice());
    await port.open({baudRate: 9600});
    await expect(whenOpened()).resolves.toMatchObject({baudRate: 9600});
  });

  it('whenClosed resolves on close and on detach (unplug while open)', async () => {
    const a = await mountSerialDevice(new EchoDevice());
    await a.port.open({baudRate: 9600});
    const closed = a.whenClosed();
    await a.port.close();
    await expect(closed).resolves.toBeUndefined();

    const b = await mountSerialDevice(new EchoDevice());
    await b.port.open({baudRate: 9600});
    const lost = b.whenClosed();
    b.device.detach(); // unplugged while open
    await expect(lost).resolves.toBeUndefined();
  });

  it('exposes the concrete device type and the fault-injection handle', async () => {
    const {serialDevice, device} = await mountSerialDevice(new PushDevice());
    // serialDevice is typed as PushDevice (no cast needed):
    serialDevice.emit([1]);
    // device is the VirtualSerialDevice handle:
    expect(device.written).toEqual([]);
    expect(typeof device.failNext).toBe('function');
  });
});

describe('mountSerialDevice (multiple devices)', () => {
  it('enumerates several ports and resolves whenOpened(index)', async () => {
    const {ports, whenOpened} = await mountSerialDevice([
      new EchoDevice({usbVendorId: 0x0403, usbProductId: 0x6001}),
      new EchoDevice({usbVendorId: 0x10c4, usbProductId: 0xea60}),
    ]);
    expect(ports).toHaveLength(2);
    const opened = whenOpened(1);
    await ports[1].open({baudRate: 9600});
    await expect(opened).resolves.toMatchObject({baudRate: 9600});
    await ports[1].close();
  });
});
