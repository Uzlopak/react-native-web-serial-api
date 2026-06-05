/**
 * Verifies the dependency-injection seam: the global `setUsbSerial` override and
 * `Serial`'s constructor injection, plus their precedence.
 */
import {afterEach, expect, it} from '@jest/globals';
import {EchoDevice} from '../testing/serial-device';
import {VirtualSerialTransport} from '../testing/virtual-serial-device';
import {getUsbSerial, resetUsbSerial, setUsbSerial} from '../UsbSerial';
import {Serial} from '../WebSerial';

afterEach(() => {
  resetUsbSerial();
});

it('getUsbSerial() returns the override set via setUsbSerial()', () => {
  const fake = new VirtualSerialTransport();
  setUsbSerial(fake);
  expect(getUsbSerial()).toBe(fake);
});

it('a Serial() with no explicit transport honours the global override', async () => {
  const fake = new VirtualSerialTransport();
  fake.addDevice(new EchoDevice({usbVendorId: 0x0403, usbProductId: 0x6001}), {
    hasPermission: true,
  });
  setUsbSerial(fake);

  const serial = new Serial();
  await expect(serial.getPorts()).resolves.toHaveLength(1);
});

it('resetUsbSerial() clears the override', () => {
  setUsbSerial(new VirtualSerialTransport());
  resetUsbSerial();
  // No override + no real native module in the Jest environment -> throws.
  expect(() => getUsbSerial()).toThrow();
});

it('an explicit transport takes precedence over the global override', async () => {
  const explicit = new VirtualSerialTransport();
  explicit.addDevice(new EchoDevice({usbVendorId: 1, usbProductId: 1}), {
    hasPermission: true,
  });

  const globalEmpty = new VirtualSerialTransport();
  setUsbSerial(globalEmpty);

  const serial = new Serial(explicit);
  // Ports come from the explicit transport, not the (empty) global override.
  await expect(serial.getPorts()).resolves.toHaveLength(1);
});
