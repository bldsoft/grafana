import { Suspense, lazy, useState } from 'react';

import { t } from '@grafana/i18n';
import { ToolbarButton } from '@grafana/ui';

// Analytix: loaded on demand so pages that only show the button (e.g. the
// home page) do not pull the chat's heavy dependencies into their chunk.
const GenPanelChat = lazy(() => import('./GenPanelChat').then((m) => ({ default: m.GenPanelChat })));

/**
 * Analytix: kill switch for the AI panel button in the dashboard toolbars.
 * The dashboard placement is parked, not removed - flip this back to `true`
 * to bring the toolbar button back in both toolbars. Both registration sites
 * gate their `condition` on it. The button itself lives on the home page now
 * (see {@link ../../home/AnalytixHomePage.tsx}) and is not affected by this.
 */
export const AI_PANEL_ENABLED = false;

/**
 * Toolbar action that opens the "generate panel from a description" chat.
 * Rendered in the header of the home page ({@link ../../home/AnalytixHomePage.tsx}).
 * Also registered (currently disabled via {@link AI_PANEL_ENABLED}) in
 * {@link ../scene/NavToolbarActions.tsx} (legacy toolbar) and
 * {@link ../scene/new-toolbar/RightActions.tsx} (new toolbar).
 */
export function GenPanelButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <ToolbarButton
        icon="ai"
        tooltip={t('dashboard.ai-panel.tooltip', 'Generate a panel from a description')}
        onClick={() => setIsOpen(true)}
      />
      {isOpen && (
        <Suspense fallback={null}>
          <GenPanelChat onClose={() => setIsOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
