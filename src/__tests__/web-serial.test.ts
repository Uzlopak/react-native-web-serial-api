/**
 * Direct unit tests for the Serial/SerialPort polyfill, driven entirely through
 * an injected VirtualSerialTransport (no native module, no NativeModules mocks).
 * These complement the shared conformance suite with finer-grained assertions.
 */
import {describe, expect, it, jest} from '@jest/globals';
import {VirtualSerialTransport} from '../testing/virtual-serial';
import {Serial, SerialPort} from '../WebSerial';

const FTDI = {usbVendorId: 0x0403, usbProductId: 0x6001} as const;

function setup(behavior?: 'echo' | 'silent') {
  const transport = new VirtualSerialTransport();
  const device = transport.addDevice({
    ...FTDI,
    hasPermission: true,
    behavior: behavior ?? 'echo',
  });
  const serial = new Serial(transport);
  return {transport, device, serial};
}

describe('Serial.getPorts()', () => {
  it('returns SerialPort instances for permitted devices', async () => {
    const {serial} = setup();
    const ports = await serial.getPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0]).toBeInstanceOf(SerialPort);
    expect(ports[0].getInfo()).toEqual({
      usbVendorId: FTDI.usbVendorId,
      usbProductId: FTDI.usbProductId,
    });
  });

  it('caches and reuses the same SerialPort instance across calls', async () => {
    const {serial} = setup();
    const [first] = await serial.getPorts();
    const [second] = await serial.getPorts();
    expect(second).toBe(first);
  });
});

describe('SerialPort.open()', () => {
  it('passes the resolved connection parameters down to the device', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();
    await port.open({
      baudRate: 19200,
      dataBits: 7,
      stopBits: 2,
      parity: 'even',
    });
    expect(device.openOptions).toEqual({
      baudRate: 19200,
      dataBits: 7,
      stopBits: 2,
      parity: 2, // 'even' -> native parity code
    });
    await port.close();
  });

  it('enables hardware flow control when requested', async () => {
    const {serial, device} = setup();
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600, flowControl: 'hardware'});
    expect(device.flowControl).toBe('RTS_CTS');
    await port.close();
  });
});

describe('SerialPort streams', () => {
  it('preserves byte order across multiple writes', async () => {
    const {serial, device} = setup('silent');
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const writer = port.writable!.getWriter();
    await writer.write(Uint8Array.from([1, 2]));
    await writer.write(Uint8Array.from([3]));
    await writer.write(Uint8Array.from([4, 5]));
    writer.releaseLock();
    expect(device.written.flat()).toEqual([1, 2, 3, 4, 5]);
    await port.close();
  });

  it('delivers device-pushed bytes to the readable stream', async () => {
    const {serial, device} = setup('silent');
    const [port] = await serial.getPorts();
    await port.open({baudRate: 9600});
    const reader = port.readable!.getReader();
    device.push([0xde, 0xad, 0xbe, 0xef]);
    const {value} = await reader.read();
    expect(Array.from(value ?? new Uint8Array())).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
    reader.releaseLock();
    await port.close();
  });
});

describe('Serial connect/disconnect events', () => {
  it('fires the onconnect property handler when a device is (re)attached', () => {
    const {serial, transport, device} = setup();
    const onconnect = jest.fn();
    serial.onconnect = onconnect;
    transport.detach(device);
    transport.attach(device);
    expect(onconnect).toHaveBeenCalled();
  });

  it('fires the ondisconnect property handler when a device is detached', () => {
    const {serial, transport, device} = setup();
    const ondisconnect = jest.fn();
    serial.ondisconnect = ondisconnect;
    transport.detach(device);
    expect(ondisconnect).toHaveBeenCalled();
  });
});
