/**
 * @format
 */

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {
  ENCRYPTION_MODE_5,
  WMBusMeter,
} from '../../src/devices/wmbus/WMBusMeter';

const ADDRESS = {
  manufacturerId: 0x1234,
  deviceId: 0x56789abc,
  version: 0x01,
  type: 0x07,
};

describe('WMBusMeter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('falls back to a no-op when detached and ignores zero-interval periodic mode', () => {
    const meter = new WMBusMeter({address: ADDRESS, intervalMs: 0});
    expect(() => meter.sendTelegram()).not.toThrow();
    expect(() => meter.startPeriodic(0)).not.toThrow();
  });

  it('injects telegrams into the hosting gateway with encryption metadata', () => {
    const injectRxPacket = jest.fn();
    const meter = new WMBusMeter({
      address: ADDRESS,
      encryptionKey: new Array(16).fill(0xaa),
      linkMode: 5,
      rssi: -42,
      payloadTemplate: [0x2f, 0x2f, 0x01],
    });
    (meter as any)._attach({injectRxPacket});
    meter.sendTelegram();

    expect(injectRxPacket).toHaveBeenCalledWith(
      expect.arrayContaining([0x44, 0x34, 0x12]),
      expect.objectContaining({
        rssi: -42,
        linkMode: 5,
        encryptionMode: ENCRYPTION_MODE_5,
      }),
    );
  });

  it('updates the payload template and periodic sending uses the latest payload', () => {
    jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    const injectRxPacket = jest.fn();
    const meter = new WMBusMeter({
      address: ADDRESS,
      intervalMs: 1000,
      payloadTemplate: [0x01],
    });
    (meter as any)._attach({injectRxPacket});

    meter.updatePayloadTemplate([0xaa, 0xbb]);
    meter.startPeriodic();
    jest.advanceTimersByTime(1000);

    expect(injectRxPacket).toHaveBeenCalledWith(
      expect.arrayContaining([0xaa, 0xbb]),
      expect.objectContaining({rssi: -50, linkMode: 2}),
    );
    meter.stopPeriodic();
  });

  it('detaches cleanly and stops a running timer', () => {
    jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const meter = new WMBusMeter({
      address: ADDRESS,
      intervalMs: 1000,
    });

    meter._attach({injectRxPacket: jest.fn()});
    meter.startPeriodic();
    meter._detach();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
