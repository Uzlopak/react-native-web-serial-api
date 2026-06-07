/**
 * @format
 */

import {expect, it, jest} from '@jest/globals';
import {fireEvent, render, screen} from '@testing-library/react-native';
import {PromptDialog} from '../../src/components/PromptDialog';

it('submits the trimmed value and closes the dialog', () => {
  const onSubmit = jest.fn();
  const onClose = jest.fn();

  render(
    <PromptDialog
      visible
      title="Remote URL"
      placeholder="ws://host:port"
      initialValue="  ws://example.test  "
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  const input = screen.getByDisplayValue('  ws://example.test  ');
  fireEvent.changeText(input, '  ws://demo.local:9000  ');
  fireEvent.press(screen.getByText('OK'));

  expect(onSubmit).toHaveBeenCalledWith('ws://demo.local:9000');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('resets to the initial value when the dialog is reopened', () => {
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  const {rerender} = render(
    <PromptDialog
      visible
      title="Remote URL"
      initialValue="ws://first.example"
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  fireEvent.changeText(
    screen.getByDisplayValue('ws://first.example'),
    'edited',
  );

  rerender(
    <PromptDialog
      visible={false}
      title="Remote URL"
      initialValue="ws://second.example"
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  rerender(
    <PromptDialog
      visible
      title="Remote URL"
      initialValue="ws://second.example"
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  expect(screen.getByDisplayValue('ws://second.example')).toBeTruthy();
});

it('uses the empty-string default initial value and closes from Cancel', () => {
  const onSubmit = jest.fn();
  const onClose = jest.fn();

  render(
    <PromptDialog
      visible
      title="Remote URL"
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  fireEvent.changeText(screen.getByDisplayValue(''), 'ws://cancel.test');
  fireEvent.press(screen.getByText('CANCEL'));

  expect(onSubmit).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('submits from the keyboard submit action', () => {
  const onSubmit = jest.fn();
  const onClose = jest.fn();

  render(
    <PromptDialog
      visible
      title="Remote URL"
      initialValue="  ws://enter.test  "
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  fireEvent(screen.getByDisplayValue('  ws://enter.test  '), 'submitEditing');

  expect(onSubmit).toHaveBeenCalledWith('ws://enter.test');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('ignores taps on the dialog card itself', () => {
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  render(
    <PromptDialog
      visible
      title="Remote URL"
      initialValue="ws://tap.test"
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  fireEvent.press(screen.getByTestId('prompt-card'));

  expect(onSubmit).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
