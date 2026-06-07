/**
 * @format
 */

import {expect, it, jest} from '@jest/globals';
import {fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
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

  fireEvent.changeText(screen.getByDisplayValue('ws://first.example'), 'edited');

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
