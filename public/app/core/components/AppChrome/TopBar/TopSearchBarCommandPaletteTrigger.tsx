import { useKBar, VisualState } from 'kbar';

import { ToolbarButton } from '@grafana/ui';
import { t } from 'app/core/internationalization';

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
      aria-label={t('nav.search.placeholderCommandPalette', 'Search or jump to...')}
      onClick={onOpenSearch}
    />
  );
}
