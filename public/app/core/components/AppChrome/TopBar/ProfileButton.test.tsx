import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from 'test/test-utils';

import { config } from '@grafana/runtime';

import { ProfileButton } from './ProfileButton';

describe('ProfileButton', () => {
  let user: ReturnType<typeof userEvent.setup>;
  const defaultProps = {
    profileNode: {
      id: 'profile',
      text: 'Test User',
      url: '/profile',
      children: [],
    },
    onToggleKioskMode: jest.fn(),
  };

  beforeEach(() => {
    user = userEvent.setup();
    config.newsFeedEnabled = true;
  });

  // Analytix: kiosk mode and news feed entries are hidden from the profile menu
  it('should not render kiosk mode and news feed menu items', async () => {
    render(<ProfileButton {...defaultProps} />);

    const profileButton = screen.getByRole('button', { name: /profile/i });
    await user.click(profileButton);

    expect(await screen.findByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /latest from the blog/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /kiosk/i })).not.toBeInTheDocument();
  });
});
