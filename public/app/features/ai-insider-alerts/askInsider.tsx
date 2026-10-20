// Analytix: "Ask AI Insider" from a problem on the alerts page. Opens the AI
// Insider chat over the page with a question about that problem in the
// composer (not sent: the viewer edits it or sends it as is), on the same
// ClickHouse datasource the run reads. The page itself is behind the AI Insider
// access gate, so the chat needs no gate of its own here.

import { css } from '@emotion/css';
import { ReactNode, Suspense, createContext, lazy, useContext, useState } from 'react';

import { DataSourceRef, GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { reportInteraction } from '@grafana/runtime';
import { Button, useStyles2 } from '@grafana/ui';

// Loaded on first use: the chat pulls scenes, markdown and the SSE client.
const GenPanelChat = lazy(() =>
  import('app/features/dashboard-scene/ai-panel/GenPanelChat').then((m) => ({ default: m.GenPanelChat }))
);

const AskContext = createContext<((prompt: string) => void) | undefined>(undefined);

/** Hosts the chat drawer for every {@link AskInsiderButton} below it. */
export function AskInsiderProvider({ datasource, children }: { datasource?: DataSourceRef; children: ReactNode }) {
  // Held here, not in the button: a live run re-renders the tables (or drops the
  // row under a filter) and must not close a conversation in progress.
  const [prompt, setPrompt] = useState<string>();
  return (
    <AskContext.Provider value={setPrompt}>
      {children}
      {prompt !== undefined && (
        <Suspense fallback={null}>
          <GenPanelChat initialPrompt={prompt} initialDatasource={datasource} onClose={() => setPrompt(undefined)} />
        </Suspense>
      )}
    </AskContext.Provider>
  );
}

/** Right-aligned "Ask AI Insider" above a problem's details; nothing outside a provider. */
export function AskInsiderButton({ prompt, source }: { prompt: () => string; source: string }) {
  const styles = useStyles2(getStyles);
  const ask = useContext(AskContext);
  if (!ask) {
    return null;
  }
  return (
    <div className={styles.row}>
      <Button
        size="sm"
        variant="secondary"
        icon="ai"
        tooltip={t(
          'ai-insider-alerts.ask-insider-tip',
          'Opens the AI Insider chat with a question about this problem: edit it or send it as is'
        )}
        onClick={() => {
          reportInteraction('analytix_ai_alerts_ask_insider', { source });
          ask(prompt());
        }}
      >
        {t('ai-insider-alerts.ask-insider', 'Ask AI Insider')}
      </Button>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  row: css({
    display: 'flex',
    justifyContent: 'flex-end',
    marginBottom: theme.spacing(-0.5),
  }),
});
