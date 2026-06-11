import { KBarProvider } from 'kbar';
import { render, screen } from 'test/test-utils';

import { setPluginLinksHook } from '@grafana/runtime';
import { setGetObservablePluginLinks } from '@grafana/runtime/internal';

import { getObservablePluginLinks } from '../plugins/extensions/getPluginExtensions';

import { CommandPalette } from './CommandPalette';

setPluginLinksHook(() => ({
  links: [],
  isLoading: false,
}));
setGetObservablePluginLinks(getObservablePluginLinks);

jest.mock('kbar', () => ({
  ...jest.requireActual('kbar'),
  KBarPortal: jest.fn().mockImplementation(({ children }) => <div>{children}</div>),
  KBarAnimator: jest.fn().mockImplementation(({ children }) => <div>{children}</div>),
}));

const setup = () => {
  return render(
    <KBarProvider>
      <CommandPalette />
    </KBarProvider>
  );
};

describe('CommandPalette', () => {
  it('should render a plain empty state when no results', async () => {
    setup();

    // Check if empty state message is rendered
    expect(await screen.findByText('No results found')).toBeInTheDocument();
    // The Grafana Assistant upsell button was removed from the empty state
    expect(screen.queryByRole('button', { name: 'Search with Grafana Assistant' })).not.toBeInTheDocument();
  });
});
