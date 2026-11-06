import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SupportResults } from './SupportResults';
import { AskInsiderProvider } from './askInsider';
import { snapshot } from './fixtures/snapshot';
import type { AffectedUserRow, CustomerSideRow, ProviderIncident } from './types';

jest.mock('app/features/dashboard-scene/ai-panel/GenPanelChat', () => ({
  GenPanelChat: ({ initialPrompt }: { initialPrompt?: string }) => <div role="dialog">{initialPrompt}</div>,
}));

describe('SupportResults', () => {
  it('opens the AI Insider chat with a question about the problem', async () => {
    render(
      <AskInsiderProvider>
        <SupportResults snapshot={snapshot()} />
      </AskInsiderProvider>
    );

    await userEvent.click(screen.getByText('Sport 1'));
    await userEvent.click(screen.getByRole('button', { name: /Ask AI Insider/ }));

    expect(await screen.findByRole('dialog')).toHaveTextContent(
      /^Channel Sport 1 \(id 20002549\) of provider 222 \(NimiTV\) failed on 2026-09-29 17:00–/
    );
  });

  it('has no chat button without the chat on the page', async () => {
    render(<SupportResults snapshot={snapshot()} />);

    await userEvent.click(screen.getByText('Sport 1'));
    expect(screen.queryByRole('button', { name: /Ask AI Insider/ })).not.toBeInTheDocument();
  });

  it('shows three tiles and the problems in plain words', () => {
    render(<SupportResults snapshot={snapshot()} />);

    expect(screen.getByText('Ongoing problems')).toBeInTheDocument();
    expect(screen.getByText('Viewers hit', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('Top Channel')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Sport 1')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Back')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Channel down')).toBeInTheDocument();
  });

  it('opens a problem into its viewers and what they were told, then the viewer', async () => {
    render(<SupportResults snapshot={snapshot()} />);

    await userEvent.click(screen.getByText('Sport 1'));
    expect(screen.getAllByText('Push: channel down').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'AA-549-001' }));

    expect(screen.getByRole('tab', { name: /Viewer lookup/, selected: true })).toBeInTheDocument();
    expect(screen.getByDisplayValue('AA-549-001')).toBeInTheDocument();
    expect(screen.getByText('All resolved')).toBeInTheDocument();
  });

  it('marks a guest, whose id is the device', async () => {
    const snap = snapshot();
    const sport = snap.incidents.find((i) => i.title === 'Sport 1')!;
    const guest = {
      ...snap.affected(sport.id)[0],
      userId: 'BD2D089111D4262A0CA1FBFAB1BCB18F',
      userKind: 'guest' as const,
      platform: 'Android',
    };
    render(
      <SupportResults
        snapshot={{ ...snap, affected: (id) => [...snap.affected(id), ...(id === sport.id ? [guest] : [])] }}
      />
    );

    await userEvent.click(screen.getByText('Sport 1'));
    const id = screen.getByRole('button', { name: 'BD2D089111D4262A0CA1FBFAB1BCB18F' });
    expect(within(id.closest('tr')!).getByText('Guest · device ID')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'AA-549-001' }).closest('tr')!).queryByText(/Guest/)).toBeNull();

    await userEvent.click(id);
    expect(screen.getByText('Guest · device ID')).toBeInTheDocument();
  });

  it('says so when an account was not hit by anything', async () => {
    render(<SupportResults snapshot={snapshot()} />);

    await userEvent.click(screen.getByRole('tab', { name: /Viewer lookup/ }));
    await userEvent.type(screen.getByPlaceholderText('Account number, device serial, device ID or IP'), 'ZZ-1');
    expect(screen.getByText('No problems found for ZZ-1')).toBeInTheDocument();
  });

  it('tells support when the viewer is in an ongoing problem', async () => {
    const snap = snapshot();
    render(
      <SupportResults
        snapshot={{
          ...snap,
          incidents: snap.incidents.map((i) =>
            i.title === 'Sport 1' ? { ...i, closedAt: undefined, recovered: undefined } : i
          ),
        }}
      />
    );

    expect(within(screen.getAllByRole('row')[1]).getByText('Ongoing')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Viewer lookup/ }));
    await userEvent.type(screen.getByPlaceholderText('Account number, device serial, device ID or IP'), 'aa-549-001');
    expect(screen.getByText('Affected by an ongoing problem')).toBeInTheDocument();
  });

  it('shows a viewer whose errors are only on their side in the same table, with IP and error', async () => {
    const snap = snapshot();
    const side: CustomerSideRow = {
      pid: '222',
      provider: 'NimiTV',
      userId: 'HU-627-368',
      platform: 'Android',
      network: 'Wi-Fi',
      isp: 'Spectrum',
      city: 'Smyrna',
      channels: 4,
      minutes: 5,
      errEvents: 9,
      firstMinute: snap.from + 600,
      lastMinute: snap.from + 840,
      topCode: '1002',
      ips: '35.151.157.73',
      channelTitles: 'News 24 | Sport 2',
    };
    render(
      <SupportResults
        snapshot={{
          ...snap,
          customer: [side],
          decisions: [
            ...snap.decisions,
            {
              kind: 'diagnosis',
              at: side.lastMinute + 60,
              userId: side.userId,
              pid: '222',
              provider: 'NimiTV',
              cid: '',
              title: '4 channels',
              reason: '',
              platform: 'Android',
            },
          ],
        }}
      />
    );

    await userEvent.click(screen.getByRole('tab', { name: /Viewer lookup/ }));
    await userEvent.type(screen.getByPlaceholderText('Account number, device serial, device ID or IP'), 'HU-627-368');
    const row = screen.getByText('Errors only on their side').closest('tr')!;
    expect(within(row).getByText('35.151.157.73')).toBeInTheDocument();
    expect(within(row).getByText('1002')).toBeInTheDocument();
    // The kind of the row and the personal message about it.
    expect(within(row).getAllByText('Their side')).toHaveLength(2);
    expect(within(row).getByText(/4 channels over 5 min: News 24, Sport 2/)).toBeInTheDocument();
    // One table: no second one for the messages.
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('names the channels of a provider-wide problem, overall and per viewer', async () => {
    const snap = snapshot();
    const incident: ProviderIncident = {
      id: 'prov-1',
      pid: '222',
      provider: 'NimiTV',
      start: snap.from,
      detectedAt: snap.from + 1800,
      lastSurge: snap.from + 1800,
      surgeBuckets: 2,
      series: [],
      peakErrUsers: 40,
      peakBaselineErr: 10,
      peakRatio: 4,
      codes: { '403/1001': 40 },
      platforms: { Android: 40 },
    };
    const viewer = (userId: string, channelTitles: string, channelCount: number): AffectedUserRow => ({
      ...snap.affected(snap.incidents[0].id)[0],
      incidentId: 'prov-1',
      userId,
      channelTitles,
      channelCount,
    });
    render(
      <SupportResults
        snapshot={{
          ...snap,
          providers: [incident],
          providerAffected: (id) =>
            id === 'prov-1' ? [viewer('BB-1', 'Sport 1 | News 24', 2), viewer('BB-2', 'Sport 1 | Kids | Docs', 5)] : [],
        }}
      />
    );

    expect(screen.getByText('on Sport 1, News 24, Kids +1 more')).toBeInTheDocument();
    await userEvent.click(screen.getAllByText('NimiTV', { selector: 'strong' })[0]);
    expect(screen.getByText('Channels: Sport 1 (2), News 24 (1), Kids (1), Docs (1)')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'BB-2' }).closest('tr')!;
    expect(within(row).getByText('Sport 1, Kids, Docs')).toBeInTheDocument();
    expect(within(row).getByText('+2 more')).toBeInTheDocument();
  });
});
