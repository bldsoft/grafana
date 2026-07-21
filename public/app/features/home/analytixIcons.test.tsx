import { dashboardIcons, getDashboardIcon } from './analytixIcons';

describe('getDashboardIcon', () => {
  it('resolves the nine approved dashboards to their own icon', () => {
    expect(getDashboardIcon('Search Info')).toBe(dashboardIcons.search);
    expect(getDashboardIcon('Content Info')).toBe(dashboardIcons.content);
    expect(getDashboardIcon('Stream Quality Info')).toBe(dashboardIcons.quality);
    expect(getDashboardIcon('Organisations Info')).toBe(dashboardIcons.organisations);
    expect(getDashboardIcon('Providers Info')).toBe(dashboardIcons.providers);
    expect(getDashboardIcon('User Info')).toBe(dashboardIcons.users);
    expect(getDashboardIcon('Device Info')).toBe(dashboardIcons.devices);
    expect(getDashboardIcon('CDN QoS')).toBe(dashboardIcons.cdn);
    expect(getDashboardIcon('Feature Adoption Rate')).toBe(dashboardIcons.adoption);
  });

  it('matches a keyword anywhere in the title, so renames keep their icon', () => {
    expect(getDashboardIcon('CDN QoS v2')).toBe(dashboardIcons.cdn);
    expect(getDashboardIcon('Weekly CDN report')).toBe(dashboardIcons.cdn);
    expect(getDashboardIcon('Feature adoption — Q3')).toBe(dashboardIcons.adoption);
    expect(getDashboardIcon('Search')).toBe(dashboardIcons.search);
  });

  it('ignores case, punctuation and separators', () => {
    expect(getDashboardIcon('  cdn   QOS ')).toBe(dashboardIcons.cdn);
    expect(getDashboardIcon('CDN/QoS')).toBe(dashboardIcons.cdn);
    expect(getDashboardIcon('cdn_qos')).toBe(dashboardIcons.cdn);
  });

  it('matches whole words only, not substrings', () => {
    // "Research" contains "search" - it must not get the magnifier
    expect(getDashboardIcon('Research Info')).toBe(dashboardIcons.default);
    // "Contention" contains "content"
    expect(getDashboardIcon('Contention Info')).toBe(dashboardIcons.default);
  });

  it('handles plural forms', () => {
    expect(getDashboardIcon('Providers')).toBe(dashboardIcons.providers);
    expect(getDashboardIcon('Devices overview')).toBe(dashboardIcons.devices);
    expect(getDashboardIcon('Organizations')).toBe(dashboardIcons.organisations);
  });

  it('applies rules in priority order when a title matches more than one', () => {
    // domain term wins over the generic entity term
    expect(getDashboardIcon('CDN Users')).toBe(dashboardIcons.cdn);
    expect(getDashboardIcon('User Devices')).toBe(dashboardIcons.devices);
  });

  it('falls back to the default icon for unknown dashboards', () => {
    expect(getDashboardIcon('Ad-hoc Debugging')).toBe(dashboardIcons.default);
    expect(getDashboardIcon('')).toBe(dashboardIcons.default);
  });

  it('does not resolve the reserved "default" key from a dashboard title', () => {
    expect(getDashboardIcon('default')).toBe(dashboardIcons.default);
  });
});
