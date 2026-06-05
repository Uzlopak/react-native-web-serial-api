import {describe, expect, it} from '@jest/globals';
import {EchoDevice} from '../testing/serial-device';
import {VirtualSerialTransport} from '../testing/virtual-serial-device';
import {Serial, SerialPort} from '../WebSerial';
import {
  runRealDeviceSmokeTest,
  runSerialConformance,
  serialConformanceTests,
} from './conformance-suite';

describe('conformance runners and helper branches', () => {
  it('runSerialConformance returns passing results for the default suite', async () => {
    const results = await runSerialConformance();

    expect(results).toHaveLength(serialConformanceTests.length);
    for (let i = 0; i < results.length; i++) {
      expect(results[i].name).toBe(serialConformanceTests[i].name);
      expect(results[i].passed).toBe(true);
      expect(Number.isFinite(results[i].durationMs)).toBe(true);
      expect(results[i].durationMs).toBeGreaterThanOrEqual(0);
      expect(results[i].error).toBeUndefined();
    }
  });

  it('runSerialConformance captures thrown non-Error values as strings', async () => {
    const original = [...serialConformanceTests];
    serialConformanceTests.push({
      name: 'throws string sentinel',
      async run() {
        throw 'boom-string';
      },
    });

    try {
      const results = await runSerialConformance();
      const failed = results.find(r => r.name === 'throws string sentinel');
      expect(failed?.passed).toBe(false);
      expect(failed?.error).toContain('boom-string');
    } finally {
      serialConformanceTests.splice(
        0,
        serialConformanceTests.length,
        ...original,
      );
    }
  });

  it('runSerialConformance captures assertion mismatches from suite tests', async () => {
    const original = VirtualSerialTransport.prototype.findAllDrivers;
    VirtualSerialTransport.prototype.findAllDrivers = async () => [];

    try {
      const results = await runSerialConformance();
      const failed = results.find(r =>
        r.name.includes(
          'getPorts() lists only devices the app has permission for',
        ),
      );

      expect(failed?.passed).toBe(false);
      expect(failed?.error).toContain('expected 1, got 0');
    } finally {
      VirtualSerialTransport.prototype.findAllDrivers = original;
    }
  });

  it('runSerialConformance captures readable rejection paths', async () => {
    const original = EchoDevice.prototype.onData;
    EchoDevice.prototype.onData = function onDataForcedError() {
      (this as unknown as {raiseError(message: string): void}).raiseError(
        'forced read failure',
      );
    };

    try {
      const results = await runSerialConformance();
      const failed = results.find(r =>
        r.name.includes('readable receives the bytes the device sends'),
      );

      expect(failed?.passed).toBe(false);
      expect(failed?.error).toContain('forced read failure');
    } finally {
      EchoDevice.prototype.onData = original;
    }
  });

  it('runSerialConformance captures assertRejects name/type mismatch branches', async () => {
    const originalGetSignals = SerialPort.prototype.getSignals;
    const originalOpen = SerialPort.prototype.open;

    SerialPort.prototype.getSignals = async function getSignalsWrongError() {
      throw new TypeError('wrong error name');
    };
    SerialPort.prototype.open = async function openWrongType() {
      throw new Error('wrong error type');
    };

    try {
      const results = await runSerialConformance();
      const nameMismatch = results.find(r =>
        r.name.includes('getSignals()/setSignals() reject before open()'),
      );
      const typeMismatch = results.find(r =>
        r.name.includes('open() rejects invalid connection parameters'),
      );

      expect(nameMismatch?.passed).toBe(false);
      expect(nameMismatch?.error).toContain(
        'expected error "InvalidStateError"',
      );

      expect(typeMismatch?.passed).toBe(false);
      expect(typeMismatch?.error).toContain('expected a TypeError');
    } finally {
      SerialPort.prototype.getSignals = originalGetSignals;
      SerialPort.prototype.open = originalOpen;
    }
  });

  it('runSerialConformance captures assertRejects no-rejection and readBytes done/value branches', async () => {
    const originalRequestPort = SerialPort.prototype.constructor;
    const originalGetter = Object.getOwnPropertyDescriptor(
      SerialPort.prototype,
      'readable',
    );

    const serialProto =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('../WebSerial') as {Serial: {prototype: {requestPort: unknown}}})
        .Serial.prototype as {requestPort: () => Promise<unknown>};
    const originalRequestPortFn = serialProto.requestPort;

    serialProto.requestPort = async () => ({fake: true});
    Object.defineProperty(SerialPort.prototype, 'readable', {
      configurable: true,
      get() {
        return {
          getReader() {
            return {
              async read() {
                return {done: true};
              },
              releaseLock() {},
            };
          },
        };
      },
    });

    try {
      const results = await runSerialConformance();
      const noReject = results.find(r =>
        r.name.includes(
          'requestPort() rejects with NotFoundError when cancelled',
        ),
      );
      const readDone = results.find(r =>
        r.name.includes('readable receives the bytes the device sends'),
      );

      expect(noReject?.passed).toBe(false);
      expect(noReject?.error).toContain(
        'expected a rejection but none occurred',
      );

      expect(readDone?.passed).toBe(false);
      expect(readDone?.error).toContain('echo mismatch');
    } finally {
      serialProto.requestPort = originalRequestPortFn;
      if (originalGetter) {
        Object.defineProperty(SerialPort.prototype, 'readable', originalGetter);
      }
      void originalRequestPort;
    }
  });

  it('runSerialConformance captures same-length byte mismatch and value-falsy reads', async () => {
    const originalEcho = EchoDevice.prototype.onData;
    const originalGetter = Object.getOwnPropertyDescriptor(
      SerialPort.prototype,
      'readable',
    );

    EchoDevice.prototype.onData = function onDataWrongBytes(data: Uint8Array) {
      const bytes = Array.from(data);
      bytes[0] = (bytes[0] + 1) & 0xff;
      (this as unknown as {send(data: number[]): void}).send(bytes);
    };

    Object.defineProperty(SerialPort.prototype, 'readable', {
      configurable: true,
      get() {
        let calls = 0;
        return {
          getReader() {
            return {
              async read() {
                calls += 1;
                if (calls === 1) return {done: false};
                return {done: true};
              },
              releaseLock() {},
            };
          },
        };
      },
    });

    try {
      const results = await runSerialConformance();
      const failed = results.find(r =>
        r.name.includes('readable receives the bytes the device sends'),
      );

      expect(failed?.passed).toBe(false);
      expect(failed?.error).toContain('echo mismatch');
    } finally {
      EchoDevice.prototype.onData = originalEcho;
      if (originalGetter) {
        Object.defineProperty(SerialPort.prototype, 'readable', originalGetter);
      }
    }
  });

  it('runSerialConformance captures same-length byte mismatch in bytesEqual loop', async () => {
    const originalEcho = EchoDevice.prototype.onData;
    EchoDevice.prototype.onData = function onDataWrongBytes(data: Uint8Array) {
      const bytes = Array.from(data);
      bytes[0] = (bytes[0] + 1) & 0xff;
      (this as unknown as {send(data: number[]): void}).send(bytes);
    };

    try {
      const results = await runSerialConformance();
      const failed = results.find(r =>
        r.name.includes('readable receives the bytes the device sends'),
      );

      expect(failed?.passed).toBe(false);
      expect(failed?.error).toContain('echo mismatch');
    } finally {
      EchoDevice.prototype.onData = originalEcho;
    }
  });

  it('conformance readable test can hit timeout path', async () => {
    const originalGetter = Object.getOwnPropertyDescriptor(
      SerialPort.prototype,
      'readable',
    );
    const originalSetTimeout = global.setTimeout;

    Object.defineProperty(SerialPort.prototype, 'readable', {
      configurable: true,
      get() {
        return {
          getReader() {
            return {
              async read() {
                return await new Promise<never>(() => {});
              },
              releaseLock() {},
            };
          },
        };
      },
    });

    global.setTimeout = ((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const target = serialConformanceTests.find(t =>
        t.name.includes('readable receives the bytes the device sends'),
      );
      expect(target).toBeDefined();
      await expect(target!.run()).rejects.toThrow('timed out');
    } finally {
      global.setTimeout = originalSetTimeout;
      if (originalGetter) {
        Object.defineProperty(SerialPort.prototype, 'readable', originalGetter);
      }
    }
  });

  it('runRealDeviceSmokeTest reports missing device without throwing', async () => {
    const serial = new Serial(new VirtualSerialTransport());

    const results = await runRealDeviceSmokeTest(serial);

    expect(results[0].name).toBe('getPorts() returns a list');
    expect(results[0].passed).toBe(true);
    expect(results[1].name).toBe('a device is connected and permitted');
    expect(results[1].passed).toBe(false);
    expect(results[1].error).toContain('No ports');
  });

  it('runRealDeviceSmokeTest records a failed open/close round-trip', async () => {
    const transport = new VirtualSerialTransport();
    const device = transport.addDevice(new EchoDevice(), {hasPermission: true});
    device.failNext('open');
    const serial = new Serial(transport);

    const results = await runRealDeviceSmokeTest(serial);

    const infoResult = results.find(r =>
      r.name.includes('getInfo() exposes USB identifiers'),
    );
    const openCloseResult = results.find(r =>
      r.name.includes('open() then close() round-trips'),
    );

    expect(infoResult?.passed).toBe(true);
    expect(openCloseResult?.passed).toBe(false);
    expect(openCloseResult?.error).toContain('NetworkError');
  });

  it('runRealDeviceSmokeTest passes when open/close toggles connected', async () => {
    let connected = false;
    const goodPort = {
      getInfo: () => ({usbVendorId: 0x1234}),
      get connected() {
        return connected;
      },
      open: async () => {
        connected = true;
      },
      close: async () => {
        connected = false;
      },
    };

    const fakeSerial = {
      getPorts: async () => [goodPort],
    } as unknown as Serial;

    const results = await runRealDeviceSmokeTest(fakeSerial);
    const openCloseResult = results.find(r =>
      r.name.includes('open() then close() round-trips'),
    );

    expect(openCloseResult?.passed).toBe(true);
  });

  it('runRealDeviceSmokeTest records a failed info assertion for malformed ports', async () => {
    const malformedPort = {
      getInfo: () => ({}),
      open: async () => {},
      close: async () => {},
      connected: false,
    };

    const fakeSerial = {
      getPorts: async () => [malformedPort],
    } as unknown as Serial;

    const results = await runRealDeviceSmokeTest(fakeSerial);
    const infoResult = results.find(r =>
      r.name.includes('getInfo() exposes USB identifiers'),
    );

    expect(infoResult?.passed).toBe(false);
    expect(infoResult?.error).toContain('getInfo() returned no usbVendorId');
  });
});
