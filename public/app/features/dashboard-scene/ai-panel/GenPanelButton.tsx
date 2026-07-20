import { useState } from 'react';

import { t } from '@grafana/i18n';
import { ToolbarButton } from '@grafana/ui';

import { ToolbarActionProps } from '../scene/new-toolbar/types';

import { GenPanelChat } from './GenPanelChat';

/**
 * Toolbar action that opens the "generate panel from a description" chat.
 * Registered in {@link ../scene/NavToolbarActions.tsx} (legacy toolbar) and
 * {@link ../scene/new-toolbar/RightActions.tsx} (new toolbar).
 */
export function GenPanelButton({ dashboard }: ToolbarActionProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <ToolbarButton
        icon="ai"
        tooltip={t('dashboard.ai-panel.tooltip', 'Generate a panel from a description')}
        onClick={() => setIsOpen(true)}
      />
      {isOpen && <GenPanelChat dashboard={dashboard} onClose={() => setIsOpen(false)} />}
    </>
  );
}
