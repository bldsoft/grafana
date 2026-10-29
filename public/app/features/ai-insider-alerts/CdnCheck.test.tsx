import { render, screen } from '@testing-library/react';

import { AlertsDatasourceContext, CdnConfirmation } from './CdnCheck';
import { CDN_BUCKET_SEC, CdnTarget } from './cdn';
import { queryRows } from './query';

jest.mock('./query', () => ({ queryRows: jest.fn() }));

const T0 = Date.UTC(2026, 9, 28, 14, 0) / 1000;
const mockQuery = jest.mocked(queryRows);

function target(streams = ['televentrx']): CdnTarget {
  return { pid: 255, streams, start: T0, end: T0 + 900, from: T0 - 1800, to: T0 + 900 };
}

const rows = (during: Array<[number, number]>) => [
  { bucket_ts: T0 - 1800, cdn: 'fastly', status: 200, request_count: 1000 },
  ...during.map(([status, n]) => ({ bucket_ts: T0 + CDN_BUCKET_SEC, cdn: 'fastly', status, request_count: n })),
];

function renderCheck(t: CdnTarget) {
  return render(
    <AlertsDatasourceContext.Provider value={{ uid: 'ch', type: 'grafana-clickhouse-datasource' }}>
      <CdnConfirmation target={t} />
    </AlertsDatasourceContext.Provider>
  );
}

describe('CdnConfirmation', () => {
  beforeEach(() => mockQuery.mockReset());

  it('shows the confirmation with the share of failed requests and the codes', async () => {
    mockQuery.mockResolvedValue(
      rows([
        [200, 600],
        [404, 400],
      ])
    );
    renderCheck(target(['confirmed-stream']));

    expect(await screen.findByText('Confirmed by the CDN')).toBeInTheDocument();
    expect(screen.getByText(/confirmed-stream: 40% of 1,000 requests failed at the edge/)).toBeInTheDocument();
    expect(screen.getByText(/Codes: 404 ×400 · fastly: 40% of 1,000/)).toBeInTheDocument();
    expect(mockQuery.mock.calls[0][1]).toContain("stream_name IN ('confirmed-stream')");
  });

  it('says in one line when the CDN served the stream as usual', async () => {
    mockQuery.mockResolvedValue(rows([[200, 900]]));
    renderCheck(target(['clean-stream']));

    expect(await screen.findByText('Not seen at the CDN')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed by the CDN')).not.toBeInTheDocument();
  });

  it('renders nothing without a target', () => {
    const { container } = render(
      <AlertsDatasourceContext.Provider value={{ uid: 'ch' }}>
        <CdnConfirmation target={undefined} />
      </AlertsDatasourceContext.Provider>
    );
    expect(container).toBeEmptyDOMElement();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
