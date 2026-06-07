/**
 * @format
 */

import {afterEach, expect, it, jest} from '@jest/globals';
import {Alert} from 'react-native';
import {fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {SingleChoiceDialog} from '../../src/components/SingleChoiceDialog';

afterEach(() => {
  jest.restoreAllMocks();
});

it('selects an option, closes the dialog, and shows the selected radio', () => {
  const onClose = jest.fn();
  const onSelect = jest.fn();

  render(
    <SingleChoiceDialog
      visible
      title="Choose port"
      selected="b"
      onSelect={onSelect}
      onClose={onClose}
      options={[
        {label: 'Option A', value: 'a'},
        {label: 'Option B', value: 'b'},
      ]}
    />,
  );

  expect(screen.getByText('◉')).toBeTruthy();
  fireEvent.press(screen.getByText('Option A'));

  expect(onSelect).toHaveBeenCalledWith('a');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('shows info text through Alert.alert when requested', () => {
  const onClose = jest.fn();
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

  render(
    <SingleChoiceDialog
      visible
      title="Baud rate"
      selected={9600}
      onSelect={jest.fn()}
      onClose={onClose}
      infoMessage="Common baud rates on this device."
      options={[{label: '9600', value: 9600}]}
    />,
  );

  fireEvent.press(screen.getByText('INFO'));

  expect(alertSpy).toHaveBeenCalledWith(
    'Baud rate',
    'Common baud rates on this device.',
  );
  expect(onClose).not.toHaveBeenCalled();
});

it('closes when cancel is pressed or the backdrop is tapped', () => {
  const onClose = jest.fn();

  render(
    <SingleChoiceDialog
      visible
      title="Choose port"
      selected="a"
      onSelect={jest.fn()}
      onClose={onClose}
      options={[{label: 'Option A', value: 'a'}]}
    />,
  );

  fireEvent.press(screen.getByText('CANCEL'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
