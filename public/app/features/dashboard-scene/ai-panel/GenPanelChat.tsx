import { css } from '@emotion/css';
import { useEffect, useRef, useState } from 'react';
import { useAsync } from 'react-use';

import { DataSourceInstanceSettings, DataSourceRef, GrafanaTheme2, getDataSourceRef } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { DataSourcePicker } from '@grafana/runtime';
import { EmbeddedScene } from '@grafana/scenes';
import { Alert, Button, Drawer, Field, IconButton, Spinner, TextArea, useStyles2 } from '@grafana/ui';
import { isLLMPluginEnabled } from 'app/features/dashboard/components/GenAI/utils';

import { DashboardScene } from '../scene/DashboardScene';

import { buildGeneratedPanel } from './buildPanel';
import { fetchClickhouseSchema } from './clickhouseSchema';
import { AI_PANEL_DEMO_MODE, buildDemoPanel } from './demo';
import { generatePanelSpec } from './generatePanelSpec';
import { buildInlineChartScene } from './inlineScene';

interface Props {
  dashboard: DashboardScene;
  onClose: () => void;
}

interface ChatEntry {
  id: number;
  prompt: string;
  scene?: EmbeddedScene;
  error?: string;
}

export function GenPanelChat({ onClose }: Props) {
  const styles = useStyles2(getStyles);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [datasource, setDatasource] = useState<DataSourceRef | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const idRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { value: llmEnabled } = useAsync(() => isLLMPluginEnabled(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, busy]);

  const canSend = input.trim() !== '' && !busy && (AI_PANEL_DEMO_MODE || (Boolean(llmEnabled) && Boolean(datasource)));

  const onSend = async () => {
    const prompt = input.trim();
    if (prompt === '' || busy) {
      return;
    }

    setInput('');
    const id = ++idRef.current;

    if (AI_PANEL_DEMO_MODE) {
      const panel = buildDemoPanel(prompt, entries.length);
      setEntries((prev) => [...prev, { id, prompt, scene: buildInlineChartScene(panel) }]);
      return;
    }

    if (!datasource) {
      return;
    }

    setBusy(true);
    try {
      const schema = await fetchClickhouseSchema(datasource);
      const spec = await generatePanelSpec(prompt, schema);
      const panel = buildGeneratedPanel(spec, datasource);
      const scene = buildInlineChartScene(panel, spec.timeFrom, spec.timeTo);
      setEntries((prev) => [...prev, { id, prompt, scene }]);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setEntries((prev) => [...prev, { id, prompt, error }]);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <Drawer
      title={t('dashboard.ai-panel.chat-title', 'AI panel chat')}
      onClose={onClose}
      size="lg"
      // Analytix: open almost full-width, leaving only the left menu visible.
      width="calc(100vw - 72px)"
    >
      <div className={styles.container}>
        <div className={styles.messages}>
          {entries.length === 0 && (
            <div className={styles.empty}>
              <Trans i18nKey="dashboard.ai-panel.chat-empty">
                Describe a panel and press Enter. Each request adds a chart below — keep refining.
              </Trans>
            </div>
          )}

          {entries.map((entry) => (
            <div key={entry.id} className={styles.exchange}>
              <div className={styles.userBubble}>{entry.prompt}</div>

              {entry.error ? (
                <Alert severity="error" title={t('dashboard.ai-panel.chat-error', 'Could not generate the panel')}>
                  {entry.error}
                </Alert>
              ) : (
                entry.scene && (
                  <div className={styles.chartCard}>
                    <entry.scene.Component model={entry.scene} />
                  </div>
                )
              )}
            </div>
          ))}

          {busy && (
            <div className={styles.thinking}>
              <Spinner inline />{' '}
              <Trans i18nKey="dashboard.ai-panel.chat-thinking">Generating…</Trans>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className={styles.composer}>
          {AI_PANEL_DEMO_MODE ? (
            <div className={styles.demoHint}>
              <Trans i18nKey="dashboard.ai-panel.chat-demo">Demo mode — any prompt renders a sample chart.</Trans>
            </div>
          ) : (
            <>
              {!llmEnabled && (
                <Alert severity="warning" title={t('dashboard.ai-panel.llm-disabled-title', 'AI is not configured')}>
                  <Trans i18nKey="dashboard.ai-panel.llm-disabled-body">
                    Install and configure the Grafana LLM app (grafana-llm-app) to enable panel generation.
                  </Trans>
                </Alert>
              )}
              <Field noMargin label={t('dashboard.ai-panel.datasource-label', 'ClickHouse datasource')}>
                <DataSourcePicker
                  current={datasource ?? null}
                  filter={(ds: DataSourceInstanceSettings) => ds.type.includes('clickhouse')}
                  onChange={(ds: DataSourceInstanceSettings) => setDatasource(getDataSourceRef(ds))}
                  noDefault
                />
              </Field>
            </>
          )}

          <div className={styles.inputRow}>
            <TextArea
              rows={2}
              placeholder={t('dashboard.ai-panel.chat-placeholder', 'e.g. Show the last 30 days as a pie chart')}
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <IconButton
              name="message"
              aria-label={t('dashboard.ai-panel.chat-send', 'Send')}
              tooltip={t('dashboard.ai-panel.chat-send', 'Send')}
              size="xl"
              disabled={!canSend}
              onClick={onSend}
            />
          </div>
          <Button variant="secondary" fill="text" size="sm" onClick={() => setEntries([])} disabled={!entries.length}>
            <Trans i18nKey="dashboard.ai-panel.chat-clear">Clear</Trans>
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    gap: theme.spacing(1),
  }),
  messages: css({
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
    paddingRight: theme.spacing(1),
  }),
  empty: css({
    color: theme.colors.text.secondary,
    textAlign: 'center',
    marginTop: theme.spacing(4),
  }),
  exchange: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  userBubble: css({
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1, 1.5),
  }),
  chartCard: css({
    height: 260,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1),
  }),
  thinking: css({
    color: theme.colors.text.secondary,
  }),
  composer: css({
    borderTop: `1px solid ${theme.colors.border.weak}`,
    paddingTop: theme.spacing(1),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  demoHint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  inputRow: css({
    display: 'flex',
    alignItems: 'flex-end',
    gap: theme.spacing(1),
  }),
});
