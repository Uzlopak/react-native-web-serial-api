/**
 * @format
 */

import {expect, it, jest} from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import {ConnectScreen} from '../../src/screens/ConnectScreen';

jest.mock('../../src/components/SingleChoiceDialog', () => {
  const _React = require('react');
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
              <Text>{String(opt.label)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null,
  };
});

const port = {
  getInfo: () => ({usbVendorId: 0x0403, usbProductId: 0x6001}),
} as any;

it('lets the user change settings and start the terminal with them', async () => {
  const onBack = jest.fn();
  const onConnect = jest.fn();

  render(
    <ConnectScreen
      port={port}
      initial={{
        baudRate: 9600,
        dataBits: 7,
        stopBits: 2,
        parity: 'odd',
        flowControl: 'hardware',
      }}
      onBack={onBack}
      onConnect={onConnect}
    />,
  );

  expect(screen.getByText('Vendor 0403  ·  Product 6001')).toBeTruthy();
  expect(screen.getByText('9600')).toBeTruthy();
  expect(screen.getByText('RTS/CTS')).toBeTruthy();

  fireEvent.press(screen.getByText('Baud rate'));
  expect(screen.getByTestId('dialog-Baud rate')).toBeTruthy();
  fireEvent.press(screen.getByTestId('option-57600'));

  await waitFor(() => expect(screen.getByText('57600')).toBeTruthy());

  fireEvent.press(screen.getByText('Connect'));
  expect(onConnect).toHaveBeenCalledWith({
    baudRate: 57600,
    dataBits: 7,
    stopBits: 2,
    parity: 'odd',
    flowControl: 'hardware',
  });
  expect(onBack).not.toHaveBeenCalled();
});

it('covers all setting dialogs and the default initial state', async () => {
  const onBack = jest.fn();
  const onConnect = jest.fn();

  render(<ConnectScreen port={port} onBack={onBack} onConnect={onConnect} />);

  expect(screen.getByText('115200')).toBeTruthy();
  expect(screen.getByText('8')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('none')).toBeTruthy();
  expect(screen.getByText('<none>')).toBeTruthy();

  fireEvent.press(screen.getByText('Data bits'));
  fireEvent.press(screen.getByTestId('option-7'));
  await waitFor(() => expect(screen.getByText('7')).toBeTruthy());

  fireEvent.press(screen.getByText('Stop bits'));
  fireEvent.press(screen.getByTestId('option-2'));
  await waitFor(() => expect(screen.getByText('2')).toBeTruthy());

  fireEvent.press(screen.getByText('Parity'));
  fireEvent.press(screen.getByTestId('option-even'));
  await waitFor(() => expect(screen.getByText('even')).toBeTruthy());

  fireEvent.press(screen.getByText('Flow control'));
  fireEvent.press(screen.getByTestId('option-hardware'));
  await waitFor(() => expect(screen.getByText('RTS/CTS')).toBeTruthy());

  fireEvent.press(screen.getByText('Connect'));
  expect(onConnect).toHaveBeenCalledWith({
    baudRate: 115200,
    dataBits: 7,
    stopBits: 2,
    parity: 'even',
    flowControl: 'hardware',
  });
  expect(onBack).not.toHaveBeenCalled();
});

it('formats missing vendor/product ids as zeros', () => {
  render(
    <ConnectScreen
      port={{getInfo: () => ({})} as any}
      onBack={jest.fn()}
      onConnect={jest.fn()}
    />,
  );

  expect(screen.getByText('Vendor 0000  ·  Product 0000')).toBeTruthy();
});
