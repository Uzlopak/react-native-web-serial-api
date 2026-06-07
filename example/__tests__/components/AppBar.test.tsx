/**
 * @format
 */

import {expect, it, jest} from '@jest/globals';
import {fireEvent, render, screen} from '@testing-library/react-native';
import {AppBar} from '../../src/components/AppBar';

it('renders the title and back button', () => {
  const onBack = jest.fn();
  render(<AppBar title="Devices" onBack={onBack} />);

  expect(screen.getByText('Devices')).toBeTruthy();
  fireEvent.press(screen.getByText('←'));
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('opens the overflow menu when menu items are provided', () => {
  const onBack = jest.fn();
  const onPress = jest.fn();

  render(
    <AppBar
      title="Devices"
      onBack={onBack}
      menu={[{key: 'settings', title: 'Settings', onPress}]}
    />,
  );

  fireEvent.press(screen.getByTestId('appbar-menu'));
  fireEvent.press(screen.getByText('Settings'));

  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onBack).not.toHaveBeenCalled();
});
