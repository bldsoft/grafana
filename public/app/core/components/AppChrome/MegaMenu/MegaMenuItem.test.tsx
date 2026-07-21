import fs from 'fs';
import path from 'path';

import { ICONS_WITH_FILLED_VARIANT } from './MegaMenuItem';

// Analytix: MegaMenuItem only asks Icon for the `-filled` variant of an icon
// when one exists on disk - otherwise Icon requests `<name>-filled.svg`, the
// request 404s and the icon disappears the moment the nav item goes active
// (this is what happened to "drilldown"). This test keeps the allow-list
// honest: if someone adds or removes a filled icon asset, it fails here
// instead of silently blanking a nav icon in production.
describe('ICONS_WITH_FILLED_VARIANT', () => {
  // eslint-disable-next-line @grafana/no-restricted-img-srcs -- Analytix: filesystem path for the assertion below, not an image source
  const iconsDir = path.join(process.cwd(), 'public/img/icons/unicons');

  it('matches the -filled icon assets on disk', () => {
    const onDisk = fs
      .readdirSync(iconsDir)
      .filter((file) => file.endsWith('-filled.svg'))
      .map((file) => file.replace('-filled.svg', ''))
      .sort();

    expect([...ICONS_WITH_FILLED_VARIANT].sort()).toEqual(onDisk);
  });

  it('does not include drilldown, which has no filled variant', () => {
    expect(ICONS_WITH_FILLED_VARIANT.has('drilldown')).toBe(false);
    expect(fs.existsSync(path.join(iconsDir, 'drilldown.svg'))).toBe(true);
    expect(fs.existsSync(path.join(iconsDir, 'drilldown-filled.svg'))).toBe(false);
  });
});
