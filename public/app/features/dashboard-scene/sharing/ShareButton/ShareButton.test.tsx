import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { selectors as e2eSelectors } from '@grafana/e2e-selectors';
import { locationService } from '@grafana/runtime';
import { SceneTimeRange, VizPanel } from '@grafana/scenes';

import { DashboardScene } from '../../scene/DashboardScene';
import { DefaultGridLayoutManager } from '../../scene/layout-default/DefaultGridLayoutManager';

import ShareButton from './ShareButton';

const createAndCopyDashboardShortLinkMock = jest.fn();
jest.mock('app/core/utils/shortLinks', () => ({
  ...jest.requireActual('app/core/utils/shortLinks'),
  createAndCopyDashboardShortLink: () => createAndCopyDashboardShortLinkMock(),
}));

const selector = e2eSelectors.pages.Dashboard.DashNav.newShareButton;

// Analytix: ShareButton is a single icon button that opens the share drawer
describe('ShareButton', () => {
  it('should render share icon button', async () => {
    setup();

    expect(await screen.findByTestId(selector.shareLink)).toBeInTheDocument();
  });

  it('should open the share drawer on click', async () => {
    setup();

    const partialSpy = jest.spyOn(locationService, 'partial');
    await userEvent.click(await screen.findByTestId(selector.shareLink));

    expect(partialSpy).toHaveBeenCalledWith({ shareView: 'link' });
    partialSpy.mockRestore();
  });
});

function setup() {
  const panel = new VizPanel({
    title: 'Panel A',
    pluginId: 'table',
    key: 'panel-12',
  });

  const dashboard = new DashboardScene({
    title: 'hello',
    uid: 'dash-1',
    $timeRange: new SceneTimeRange({}),
    body: DefaultGridLayoutManager.fromVizPanels([panel]),
  });

  render(<ShareButton dashboard={dashboard} />);
}
