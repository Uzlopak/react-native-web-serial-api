/**
 * @format
 */

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {SensorDevice} from '../../src/devices/SensorDevice';

class ProbeSensorDevice extends SensorDevice {
  sent: string[] = [];

  protected override send(data: number[] | Uint8Array | string): void {
    this.sent.push(
      typeof data === 'string' ? data : String.fromCharCode(...data),
    );
  }
}

describe('SensorDevice', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('greets on open, responds to ID? and clears its timer on close', () => {
    const setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(123 as any);
    const clearIntervalSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);

    const device = new ProbeSensorDevice();

    device.onOpen();
    expect(device.sent).toContain('SENSOR READY\r\n');
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    device.onLine('ID?');
    expect(device.sent).toContain('ACME-TEMP-100\r\n');

    device.onClose();
    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
  });

  it('returns a fresh reading for non-ID commands and tolerates close without open', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const clearIntervalSpy = jest
      .spyOn(global, 'clearInterval')
      .mockImplementation(() => undefined);

    const device = new ProbeSensorDevice();
    device.onLine('TEMP');

    expect(device.sent).toEqual(['temp=22.5C\r\n']);
    device.onClose();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(randomSpy).toHaveBeenCalled();
  });
});
