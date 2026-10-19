import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AlertsResults } from './AlertsResults';
import { MIN, T0, snapshot } from './fixtures/snapshot';

describe('AlertsResults', () => {
  it('shows the summary, the incidents and their classes', () => {
    render(<AlertsResults snapshot={snapshot()} />);

    expect(screen.getByText('Incidents', { selector: 'div' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('Top Channel')).toBeInTheDocument();
    expect(within(rows[1]).getByText('In player')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Sport 1')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Push')).toBeInTheDocument();
    expect(within(rows[2]).getByText('222 NimiTV')).toBeInTheDocument();
  });

  it('expands an incident into its viewers and their decisions', async () => {
    render(<AlertsResults snapshot={snapshot()} />);

    await userEvent.click(screen.getByText('Sport 1'));
    expect(screen.getByText('AA-549-001')).toBeInTheDocument();
    expect(screen.getByText(/1 down · 1 back · 1 apology/)).toBeInTheDocument();
  });

  it('lists app-level incidents on the Service & data tab', async () => {
    const sample = (bucket: number) => ({
      bucket,
      sessions: 200,
      plays: 40,
      errEvents: 0,
      events: 2000,
      baseSessions: 40,
      basePlays: 400,
      baseErrEvents: 6,
      baseEvents: 2000,
      providers: 1,
    });
    render(
      <AlertsResults
        snapshot={{
          ...snapshot(),
          activity: [
            {
              id: 'act-1',
              kind: 'service_down',
              pid: '326',
              provider: '',
              pids: { '326': 3 },
              start: T0,
              detectedAt: T0 + 15 * MIN,
              lastSeen: T0 + 10 * MIN,
              closedAt: T0 + 15 * MIN,
              series: [sample(T0), sample(T0 + 5 * MIN), sample(T0 + 10 * MIN)],
            },
          ],
        }}
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: /Service & data/ }));
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('Service down')).toBeInTheDocument();
    expect(within(rows[1]).getByText('App starts 5.0× usual · playback 10% of usual')).toBeInTheDocument();
    await userEvent.click(within(rows[1]).getByText('326'));
    expect(screen.getByText(/Bars: playback starts per 5 min/)).toBeInTheDocument();
  });

  it('filters the message log by kind', async () => {
    render(<AlertsResults snapshot={snapshot()} />);

    await userEvent.click(screen.getByRole('tab', { name: /Messages/ }));
    await userEvent.click(screen.getByRole('radio', { name: 'Outage' }));
    const rows = screen.getAllByRole('row');
    // Header + the one apology (Sport 1 viewer watched 20 min before).
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText(/Watched 20 min/)).toBeInTheDocument();
  });

  describe('test pushes', () => {
    const TOKEN = 'fA1b2c3d4e5f:APA91b' + 'a'.repeat(120);
    const originalFetch = global.fetch;
    const originalTimeout = AbortSignal.timeout;

    beforeEach(() => {
      window.localStorage.clear();
      // jsdom lacks AbortSignal.timeout (browsers have it).
      AbortSignal.timeout = () => new AbortController().signal;
    });
    afterEach(() => {
      global.fetch = originalFetch;
      AbortSignal.timeout = originalTimeout;
    });

    it('sends an edited push to the token pasted for a viewer', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'on', ok: 1, failed: 0, results: [{ ok: true }] }),
      });
      global.fetch = fetchMock;
      render(<AlertsResults snapshot={snapshot()} />);

      await userEvent.click(screen.getByRole('tab', { name: /Messages/ }));
      await userEvent.click(screen.getByRole('radio', { name: 'Channel down' }));
      const row = screen.getAllByRole('row')[1];
      expect(within(row).getByRole('button', { name: /No push token/ })).toBeDisabled();

      await userEvent.click(screen.getByPlaceholderText(/fcm-token-iphone/));
      await userEvent.paste(`aa-549-001 ${TOKEN}`);
      expect(screen.getByText('1 accounts · 1 tokens')).toBeInTheDocument();
      expect(window.localStorage.getItem('analytix.aiAlerts.pushTokens.v1')).toContain(TOKEN);

      await userEvent.click(within(row).getByRole('button', { name: 'Test push to this viewer' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Sport 1 is unavailable')).toBeInTheDocument();
      const text = within(dialog).getByRole('textbox', { name: /Text/ });
      await userEvent.clear(text);
      await userEvent.type(text, 'Down on {{channel}');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Send to 1 devices' }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/api\/notify\/push$/);
      expect(JSON.parse(init.body)).toEqual({
        validateOnly: false,
        messages: [
          {
            pid: '222',
            account: 'AA-549-001',
            token: TOKEN,
            title: 'Sport 1 is unavailable',
            text: 'Down on Sport 1',
            enabled: true,
            kind: 'down',
          },
        ],
      });
      expect(await within(dialog).findByText('1 sent, 0 failed')).toBeInTheDocument();
    });
  });
});
