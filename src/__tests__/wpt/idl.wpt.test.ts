/**
 * Adapted from WPT tmp/serial/idlharness.https.any.js.
 *
 * The upstream test runs the full WebIDL harness (WebIDLParser.js + the serial
 * IDL) against `navigator.serial`. We can't fetch the IDL or use a browser, so
 * this asserts the same interface *shape* our `Serial`/`SerialPort` must expose
 * per the W3C Web Serial IDL — methods, readonly attributes, event handlers,
 * and the dictionary shapes returned by getInfo()/getSignals().
 */
import {describe, expect, it} from '@jest/globals';
import {EventTarget} from '../../lib/event-target';
import {Serial, SerialPort} from '../../WebSerial';
import {loopbackHarness} from './wpt-helpers';

function isFunction(obj: object, name: string): boolean {
  return typeof (obj as Record<string, unknown>)[name] === 'function';
}

describe('WPT: Web Serial IDL surface', () => {
  it('Serial exposes the spec interface', () => {
    const serial = new Serial();
    expect(serial).toBeInstanceOf(EventTarget);
    for (const method of ['getPorts', 'requestPort']) {
      expect(isFunction(serial, method)).toBe(true);
    }
    // EventHandler IDL attributes.
    expect('onconnect' in serial).toBe(true);
    expect('ondisconnect' in serial).toBe(true);
    // EventTarget methods.
    expect(isFunction(serial, 'addEventListener')).toBe(true);
    expect(isFunction(serial, 'removeEventListener')).toBe(true);
  });

  it('SerialPort exposes the spec interface', async () => {
    const {port} = await loopbackHarness();
    expect(port).toBeInstanceOf(SerialPort);
    expect(port).toBeInstanceOf(EventTarget);

    for (const method of [
      'open',
      'close',
      'forget',
      'getInfo',
      'getSignals',
      'setSignals',
    ]) {
      expect(isFunction(port, method)).toBe(true);
    }
    // readonly attributes / event handlers.
    for (const attr of [
      'connected',
      'readable',
      'writable',
      'onconnect',
      'ondisconnect',
    ]) {
      expect(attr in port).toBe(true);
    }

    // connected is a boolean; readable/writable are null until opened.
    expect(typeof port.connected).toBe('boolean');
    expect(port.readable).toBeNull();
    expect(port.writable).toBeNull();
  });

  it('getInfo() returns a SerialPortInfo with USB ids', async () => {
    const {port} = await loopbackHarness();
    const info = port.getInfo();
    expect(typeof info.usbVendorId).toBe('number');
    expect(typeof info.usbProductId).toBe('number');
  });

  it('getSignals() returns a SerialInputSignals of booleans', async () => {
    const {port} = await loopbackHarness();
    await port.open({baudRate: 9600});
    const signals = await port.getSignals();
    for (const key of [
      'dataCarrierDetect',
      'clearToSend',
      'ringIndicator',
      'dataSetReady',
    ] as const) {
      expect(typeof signals[key]).toBe('boolean');
    }
    await port.close();
  });

  it('getPorts() resolves to SerialPort instances', async () => {
    const {serial} = await loopbackHarness();
    const ports = await serial.getPorts();
    expect(Array.isArray(ports)).toBe(true);
    for (const p of ports) expect(p).toBeInstanceOf(SerialPort);
  });
});
