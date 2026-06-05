/**
 * @format
 */

// Note: import explicitly to use the types shipped with jest.
import {expect, it} from '@jest/globals';
import {render, screen, waitFor} from '@testing-library/react-native';
import App from '../App';

it('renders the devices screen', async () => {
  render(<App />);
  expect(screen.getByText('USB Devices')).toBeTruthy();
  // DevicesScreen kicks off an async serial.getPorts() refresh on mount; let it
  // settle so the state update is wrapped in act() (avoids a console warning).
  await waitFor(() =>
    expect(screen.getByText('<no USB devices found>')).toBeTruthy(),
  );
});
