/**
 * Tests for the SerialDevice authoring model: a class you extend to simulate a
 * whole peripheral. Driven through the real Serial/SerialPort polyfill.
 */
import {describe, expect, it} from '@jest/globals';
import {
  EchoDevice,
  LineDevice,
  readBytes,
  SerialDevice,
  VirtualSerialTransport,
} from '../testing';
import {Serial} from '../WebSerial';

const enc = (s: string): Uint8Array => Uint8Array.from(s, c => c.charCodeAt(0));
const dec = (b: ArrayLike<number>): string =>
  String.fromCharCode(...Array.from(b));

async function mount(device: SerialDevice) {
  const transport = new VirtualSerialTransport();
  transport.addDevice(device, {hasPermission: true});
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) throw new Error('expected one port');
  return {transport, serial, port};
}

describe('SerialDevice', () => {
  it('returns fallback values from protected getters before binding', () => {
    class Probe extends SerialDevice {
      readonly usbVendorId = 1;
      readonly usbProductId = 2;
      inspect() {
        return {
          openOptions: this.openOptions,
          deviceId: this.deviceId,
          portNumber: this.portNumber,
        };
      }
    }

    const probe = new Probe();
    expect(probe.inspect()).toEqual({
      openOptions: null,
      deviceId: -1,
      portNumber: 0,
    });
  });

  it('EchoDevice round-trips bytes', async () => {
    const {port} = await mount(new EchoDevice());
    await port.open({baudRate: 115200});
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();
    await writer.write(enc('hello'));
    expect(dec(await readBytes(reader, 5))).toBe('hello');
    reader.releaseLock();
    writer.releaseLock();
    await port.close();
  });

  it('addDevice(SerialDevice) enumerates with the device identity', async () => {
    class MyDevice extends SerialDevice {
      readonly usbVendorId = 0x1234;
      readonly usbProductId = 0x5678;
      readonly serialNumber = 'SN-1';
    }
    const {port} = await mount(new MyDevice());
    expect(port.getInfo()).toEqual({usbVendorId: 0x1234, usbProductId: 0x5678});
  });

  it('fires onOpen (with options) and onClose', async () => {
    const events: string[] = [];
    let seen: {baudRate: number; dataBits: number} | undefined;
    class D extends SerialDevice {
      readonly usbVendorId = 1;
      readonly usbProductId = 1;
      onOpen(options: {baudRate: number; dataBits: number}) {
        seen = options;
        events.push('open');
      }
      onClose() {
        events.push('close');
      }
    }
    const {port} = await mount(new D());
    await port.open({baudRate: 19200, dataBits: 7});
    expect(events).toEqual(['open']);
    expect(seen).toMatchObject({baudRate: 19200, dataBits: 7});
    await port.close();
    expect(events).toEqual(['open', 'close']);
  });

  it('models a line-based command/response device (string payloads)', async () => {
    class Modem extends LineDevice {
      readonly usbVendorId = 0x2341;
      readonly usbProductId = 0x0043;
      onLine(line: string) {
        this.send(line === 'PING' ? 'PONG\r\n' : `ERR ${line}\r\n`);
      }
    }
    const {port} = await mount(new Modem());
    await port.open({baudRate: 9600});
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();

    await writer.write(enc('PING\n'));
    expect(dec(await readBytes(reader, 6))).toBe('PONG\r\n');

    await writer.write(enc('NOPE\n'));
    expect(dec(await readBytes(reader, 10))).toBe('ERR NOPE\r\n');

    reader.releaseLock();
    writer.releaseLock();
    await port.close();
  });

  it('lets the device assert input signals the host can read', async () => {
    class Gps extends SerialDevice {
      readonly usbVendorId = 0x067b;
      readonly usbProductId = 0x2303;
      onOpen() {
        this.setSignals({dataCarrierDetect: true, dataSetReady: true});
      }
    }
    const {port} = await mount(new Gps());
    await port.open({baudRate: 9600});
    const signals = await port.getSignals();
    expect(signals.dataCarrierDetect).toBe(true);
    expect(signals.dataSetReady).toBe(true);
    expect(signals.ringIndicator).toBe(false);
    await port.close();
  });

  it('delivers host control-signal changes to the device', async () => {
    const seen: Array<{rts: boolean; dtr: boolean}> = [];
    class D extends SerialDevice {
      readonly usbVendorId = 1;
      readonly usbProductId = 1;
      onHostSignals(s: {requestToSend: boolean; dataTerminalReady: boolean}) {
        seen.push({rts: s.requestToSend, dtr: s.dataTerminalReady});
      }
    }
    const {port} = await mount(new D());
    await port.open({baudRate: 9600});
    await port.setSignals({requestToSend: true});
    await port.setSignals({dataTerminalReady: true});
    expect(seen).toContainEqual({rts: true, dtr: false});
    expect(seen).toContainEqual({rts: true, dtr: true});
    await port.close();
  });

  it('surfaces a device-raised typed error on the readable', async () => {
    class Flaky extends SerialDevice {
      readonly usbVendorId = 1;
      readonly usbProductId = 1;
      onData() {
        this.raiseError('framing problem', 'FramingError');
      }
    }
    const {port} = await mount(new Flaky());
    await port.open({baudRate: 9600});
    const reader = port.readable!.getReader();
    const writer = port.writable!.getWriter();
    await writer.write(enc('x'));
    await expect(reader.read()).rejects.toMatchObject({name: 'FramingError'});
  });
});
