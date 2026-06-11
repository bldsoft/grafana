import { useKBar, VisualState } from 'kbar';

import { selectors } from '@grafana/e2e-selectors';
import { t } from '@grafana/i18n';
import { ToolbarButton } from '@grafana/ui';

export function TopSearchBarCommandPaletteTrigger() {
  const { query: kbar } = useKBar((kbarState) => ({
    kbarSearchQuery: kbarState.searchQuery,
    kbarIsOpen: kbarState.visualState === VisualState.showing,
  }));

  const onOpenSearch = () => {
    kbar.toggle();
  };

  return (
    <ToolbarButton
      iconOnly
      icon="search"
      data-testid={selectors.components.NavToolbar.commandPaletteTrigger}
      aria-label={t('nav.search.placeholderCommandPalette', 'Search...')}
      onClick={onOpenSearch}
    />
  );
}
