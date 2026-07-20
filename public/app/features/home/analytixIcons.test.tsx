import { dashboardIcons, getDashboardIcon } from './analytixIcons';

describe('getDashboardIcon', () => {
  it('resolves each of the nine approved dashboards to its own icon', () => {
    const approved = [
      'Search Info',
      'Content Info',
      'Stream Quality Info',
      'Organisations Info',
      'Providers Info',
      'User Info',
      'Device Info',
      'CDN QoS',
    ];

    for (const title of approved) {
      expect(getDashboardIcon(title)).not.toBe(dashboardIcons.default);
    }
  });

  it('matches titles regardless of case and extra whitespace', () => {
    expect(getDashboardIcon('  cdn   QOS ')).toBe(dashboardIcons['cdn qos']);
  });

  it('falls back to the default icon for unknown dashboards', () => {
    expect(getDashboardIcon('Ad-hoc Debugging')).toBe(dashboardIcons.default);
  });

  it('does not resolve the reserved "default" key from a dashboard title', () => {
    // Analytix: a dashboard literally named "default" must not bypass the map
    expect(getDashboardIcon('default')).toBe(dashboardIcons.default);
  });
});
