import { getDashboardDescription, hasApprovedDescription } from './dashboardDescriptions';

describe('getDashboardDescription', () => {
  it('returns the approved copy for a known dashboard', () => {
    expect(getDashboardDescription('Search Info')).toBe('Analyze search behavior');
    expect(getDashboardDescription('CDN QoS')).toBe('Monitor delivery quality');
  });

  it('matches titles regardless of case and extra whitespace', () => {
    expect(getDashboardDescription('  stream   quality   info ')).toBe('Track playback quality');
  });

  it('falls back to the folder name for unknown dashboards', () => {
    expect(getDashboardDescription('Ad-hoc Debugging', 'Setplex R&D')).toBe('Setplex R&D');
  });

  it('returns an empty string when there is no folder to fall back to', () => {
    expect(getDashboardDescription('Ad-hoc Debugging')).toBe('');
  });

  it('prefers the approved copy over the folder name', () => {
    expect(getDashboardDescription('User Info', 'Setplex R&D')).toBe('Understand user behavior');
  });
});

describe('hasApprovedDescription', () => {
  it('distinguishes approved dashboards from unknown ones', () => {
    expect(hasApprovedDescription('Device Info')).toBe(true);
    expect(hasApprovedDescription('Something Else')).toBe(false);
  });
});
