/**
 * @format
 */

import {expect, it, jest} from '@jest/globals';
import {fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Menu} from '../../src/components/Menu';

it('renders checkable items and runs the selected action after closing', () => {
  const onClose = jest.fn();
  const onPress = jest.fn();

  render(
    <Menu
      visible
      onClose={onClose}
      items={[
        {
          key: 'demo',
          title: 'Demo mode',
          checkable: true,
          checked: true,
          onPress,
        },
      ]}
    />,
  );

  expect(screen.getByText('☑')).toBeTruthy();
  fireEvent.press(screen.getByText('Demo mode'));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('invokes onClose when the backdrop is pressed', () => {
  const onClose = jest.fn();

  render(
    <Menu
      visible
      onClose={onClose}
      items={[{key: 'settings', title: 'Settings', onPress: jest.fn()}]}
    />,
  );

  fireEvent.press(screen.getByText('Settings').parent?.parent ?? screen.getByText('Settings'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('renders disabled items with muted text and does not invoke their action', () => {
  const onClose = jest.fn();
  const onPress = jest.fn();

  render(
    <Menu
      visible
      onClose={onClose}
      items={[
        {
          key: 'disabled',
          title: 'Disabled item',
          disabled: true,
          onPress,
        },
      ]}
    />,
  );

  const text = screen.getByText('Disabled item');
  expect(text.props.style).toEqual(
    expect.arrayContaining([expect.objectContaining({opacity: 0.5})]),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(onPress).not.toHaveBeenCalled();
});
