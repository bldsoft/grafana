import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SupportResults } from './SupportResults';
import { AskInsiderProvider } from './askInsider';
import { snapshot } from './fixtures/snapshot';

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
    await userEvent.type(screen.getByPlaceholderText('Account number, or device ID / IP of a guest'), 'ZZ-1');
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
    await userEvent.type(screen.getByPlaceholderText('Account number, or device ID / IP of a guest'), 'aa-549-001');
    expect(screen.getByText('Affected by an ongoing problem')).toBeInTheDocument();
  });
});
