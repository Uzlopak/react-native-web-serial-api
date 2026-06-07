/**
 * @format
 */

import {afterEach, expect, it, jest} from '@jest/globals';
import {fireEvent, render, screen, waitFor, act} from '@testing-library/react-native';
import React from 'react';
import {TerminalScreen} from '../../src/screens/TerminalScreen';

jest.mock('../../src/components/AppBar', () => {
  const React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    AppBar: ({title, onBack, menu}: any) => (
      <View>
        {onBack ? (
          <Pressable testID="back" onPress={onBack}>
            <Text>back</Text>
          </Pressable>
        ) : null}
        <Text>{title}</Text>
        {menu?.map((item: any) => (
          <Pressable
            key={item.key}
            testID={`menu-${item.key}`}
            onPress={item.onPress}>
            <Text>{item.title}</Text>
          </Pressable>
        ))}
      </View>
    ),
  };
});

jest.mock('../../src/components/SingleChoiceDialog', () => {
  const React = require('react');
  const {Pressable, Text, View} = require('react-native');
  return {
    SingleChoiceDialog: ({visible, title, options, onSelect, onClose}: any) =>
      visible ? (
        <View testID={`dialog-${title}`}>
          <Text>{title}</Text>
          {options.map((opt: any) => (
            <Pressable
              key={String(opt.value)}
              testID={`option-${String(opt.value)}`}
              onPress={() => {
                onSelect(opt.value);
                onClose();
              }}>
              <Text>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null,
  };
});

type TerminalPort = {
  open: jest.Mock;
  close: jest.Mock;
  getSignals: jest.Mock;
  setSignals: jest.Mock;
  readable: {getReader: jest.Mock};
  writable: {getWriter: jest.Mock};
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  emit: (event: 'connect' | 'disconnect') => Promise<void>;
};

function createTerminalPort(options: {
  openReject?: Error;
  readerChunks?: Uint8Array[];
  readerChunksAfterReconnect?: Uint8Array[];
  writeReject?: Error;
  setSignalsReject?: Error;
} = {}): TerminalPort {
  const listeners: Record<'connect' | 'disconnect', Set<() => unknown>> = {
    connect: new Set(),
    disconnect: new Set(),
  };
  const writes: number[][] = [];
  const makeReader = (chunks: Uint8Array[]) => {
    const queue = [...chunks];
    return {
      read: jest.fn(async () => {
        if (queue.length > 0) {
          return {value: queue.shift(), done: false};
        }
        return {value: undefined, done: true};
      }),
      cancel: jest.fn(async () => undefined),
      releaseLock: jest.fn(),
    };
  };
  const makeWriter = () => ({
    write: jest.fn(async (chunk: Uint8Array) => {
      if (options.writeReject) {
        throw options.writeReject;
      }
      writes.push(Array.from(chunk));
    }),
    close: jest.fn(async () => undefined),
    releaseLock: jest.fn(),
  });

  let readerFactoryCount = 0;
  let writerFactoryCount = 0;
  const last = {
    writes,
    getReader: jest.fn(() => {
      const first = readerFactoryCount === 0;
      readerFactoryCount += 1;
      return makeReader(
        first
          ? options.readerChunks ?? []
          : options.readerChunksAfterReconnect ?? [],
      );
    }),
    getWriter: jest.fn(() => {
      writerFactoryCount += 1;
      return makeWriter();
    }),
  };

  return {
    open: jest.fn(async () => {
      if (options.openReject) {
        throw options.openReject;
      }
    }),
    close: jest.fn(async () => undefined),
    getSignals: jest.fn(async () => ({
      clearToSend: false,
      dataSetReady: true,
      dataCarrierDetect: false,
      ringIndicator: false,
    })),
    setSignals: jest.fn(async () => {
      if (options.setSignalsReject) {
        throw options.setSignalsReject;
      }
      return undefined;
    }),
    readable: {getReader: last.getReader},
    writable: {getWriter: last.getWriter},
    addEventListener: jest.fn((event: 'connect' | 'disconnect', cb: () => unknown) => {
      listeners[event].add(cb);
    }),
    removeEventListener: jest.fn((event: 'connect' | 'disconnect', cb: () => unknown) => {
      listeners[event].delete(cb);
    }),
    emit: async (event: 'connect' | 'disconnect') => {
      for (const cb of listeners[event]) {
        await cb();
      }
    },
    _writes: writes,
    _writerFactoryCount: () => writerFactoryCount,
  } as TerminalPort & {_writes: number[][]; _writerFactoryCount: () => number};
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('connects, sends data in hex/plaintext, updates newline, and handles control lines', async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']});
  const port = createTerminalPort({
    readerChunks: [Uint8Array.from([0x48, 0x69])],
  }) as TerminalPort & {
    _writes: number[][];
    _writerFactoryCount: () => number;
  };

  render(
    <TerminalScreen
      port={port as any}
      settings={{
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      }}
      onBack={jest.fn()}
    />,
  );

  await waitFor(() => expect(port.open).toHaveBeenCalledTimes(1));
  await act(async () => {
    jest.advanceTimersByTime(60);
  });

  fireEvent.changeText(screen.getByTestId('terminal-input'), 'aabb');
  fireEvent.press(screen.getByTestId('terminal-send'));
  expect(port._writes[0]).toEqual([0xaa, 0xbb, 0x0d, 0x0a]);

  fireEvent.press(screen.getByTestId('menu-hex'));
  fireEvent.changeText(screen.getByTestId('terminal-input'), 'hi');
  fireEvent.press(screen.getByTestId('terminal-send'));
  expect(port._writes[1]).toEqual([0x68, 0x69, 0x0d, 0x0a]);

  fireEvent.press(screen.getByTestId('menu-newline'));
  fireEvent.press(screen.getByText('LF'));
  fireEvent.changeText(screen.getByTestId('terminal-input'), 'ok');
  fireEvent.press(screen.getByTestId('terminal-send'));
  expect(port._writes[2]).toEqual([0x6f, 0x6b, 0x0a]);

  fireEvent.press(screen.getByTestId('menu-controlLines'));
  expect(screen.getByText('RTS')).toBeTruthy();
  fireEvent.press(screen.getByText('RTS'));
  fireEvent.press(screen.getByText('DTR'));
  expect(port.setSignals).toHaveBeenCalledWith({requestToSend: true});
  expect(port.setSignals).toHaveBeenCalledWith({dataTerminalReady: true});

  await act(async () => {
    jest.advanceTimersByTime(200);
  });
  expect(port.getSignals).toHaveBeenCalled();

  fireEvent.press(screen.getByTestId('menu-sendBreak'));
  expect(port.setSignals).toHaveBeenCalledWith({break: true});
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  await waitFor(() => expect(port.setSignals).toHaveBeenCalledWith({break: false}));

  await act(async () => {
    await port.emit('disconnect');
    await port.emit('connect');
  });
  await waitFor(() => expect(port.open).toHaveBeenCalledTimes(2));
});

it('reports a connection failure when open() rejects', async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']});
  const port = createTerminalPort({openReject: new Error('no serial port')});

  render(
    <TerminalScreen
      port={port as any}
      settings={{
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      }}
      onBack={jest.fn()}
    />,
  );

  await waitFor(() => expect(port.open).toHaveBeenCalledTimes(1));
  await act(async () => {
    jest.advanceTimersByTime(60);
  });
  expect(screen.getByText(/connection failed: no serial port/)).toBeTruthy();
});

it('shows the jump-to-bottom affordance and can clear the log', async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']});
  const port = createTerminalPort({
    readerChunks: [Uint8Array.from([0x48, 0x69, 0x0d, 0x0a])],
  });

  render(
    <TerminalScreen
      port={port as any}
      settings={{
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      }}
      onBack={jest.fn()}
    />,
  );

  await waitFor(() => expect(port.open).toHaveBeenCalledTimes(1));
  await act(async () => {
    jest.advanceTimersByTime(60);
  });

  expect(screen.getByText('48 69 0D 0A')).toBeTruthy();
  fireEvent.scroll(screen.getByTestId('terminal-log'), {
    nativeEvent: {
      contentOffset: {x: 0, y: 0},
      contentSize: {width: 100, height: 1000},
      layoutMeasurement: {width: 100, height: 100},
    },
  });
  expect(screen.getByLabelText('Jump to bottom')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Jump to bottom'));

  fireEvent.press(screen.getByTestId('menu-clear'));
  await act(async () => {
    jest.advanceTimersByTime(60);
  });
  expect(screen.queryByText('48 69 0D 0A')).toBeNull();
});

it('disables sending when hardware flow control reports CTS low', async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']});
  const port = createTerminalPort();

  render(
    <TerminalScreen
      port={port as any}
      settings={{
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'hardware',
      }}
      onBack={jest.fn()}
    />,
  );

  await waitFor(() => expect(port.open).toHaveBeenCalledTimes(1));
  await act(async () => {
    jest.advanceTimersByTime(220);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('⊘')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByTestId('terminal-send').props.accessibilityState.disabled).toBe(true),
  );
});

it('renders plain text input, receives CRLF chunks, and surfaces write/control failures', async () => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']});
  const port = createTerminalPort({
    readerChunks: [],
    readerChunksAfterReconnect: [
      Uint8Array.from([0x48, 0x69, 0x0d]),
      Uint8Array.from([0x0a, 0x57, 0x6f, 0x72, 0x6c, 0x64]),
    ],
    writeReject: new Error('write boom'),
    setSignalsReject: new Error('signals boom'),
  });

  render(
    <TerminalScreen
      port={port as any}
      settings={{
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      }}
      onBack={jest.fn()}
    />,
  );

  await waitFor(() => expect(port.open).toHaveBeenCalledTimes(1));
  await act(async () => {
    jest.advanceTimersByTime(60);
  });

  fireEvent.press(screen.getByTestId('menu-hex'));
  expect(screen.getByTestId('terminal-input').props.placeholder).toBe('');
  await act(async () => {
    await port.emit('disconnect');
    await port.emit('connect');
  });
  await act(async () => {
    jest.advanceTimersByTime(60);
  });
  fireEvent.changeText(screen.getByTestId('terminal-input'), 'plain');
  fireEvent.press(screen.getByTestId('terminal-send'));
  await waitFor(() => expect(screen.getByText(/write failed: write boom/)).toBeTruthy());

  await waitFor(() => expect(screen.getByText('Hi')).toBeTruthy());
  await waitFor(() => expect(screen.getByText('World')).toBeTruthy());

  fireEvent.press(screen.getByTestId('menu-controlLines'));
  fireEvent.press(screen.getByText('RTS'));
  fireEvent.press(screen.getByText('DTR'));
  fireEvent.press(screen.getByTestId('menu-sendBreak'));

  await waitFor(() => expect(screen.getByText(/setRTS failed: signals boom/)).toBeTruthy());
  expect(screen.getByText(/setDTR failed: signals boom/)).toBeTruthy();
  expect(screen.getByText(/send BREAK failed: signals boom/)).toBeTruthy();
});
