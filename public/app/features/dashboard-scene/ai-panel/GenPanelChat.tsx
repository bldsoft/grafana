import { css, cx, keyframes } from '@emotion/css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAsync } from 'react-use';

import { DataSourceInstanceSettings, DataSourceRef, GrafanaTheme2, getDataSourceRef, renderMarkdown } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { DataSourcePicker, getDataSourceSrv } from '@grafana/runtime';
import { EmbeddedScene } from '@grafana/scenes';
import { Alert, Drawer, Icon, IconButton, TextArea, useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { AssistantProgress, checkAssistantHealth, generatePanel } from './assistantClient';
import { buildGeneratedPanel } from './buildPanel';
import { AI_PANEL_DEMO_MODE, buildDemoPanel } from './demo';
import { buildInlineChartScene } from './inlineScene';
import { GeneratedPanelSpec } from './types';

interface Props {
  onClose: () => void;
}

interface ChatEntry {
  id: number;
  prompt: string;
  status: 'running' | 'done' | 'message' | 'error';
  /** Live agent narration while the entry is running. */
  progressText?: string;
  toolCounts?: Record<string, number>;
  scene?: EmbeddedScene;
  spec?: GeneratedPanelSpec;
  /** Assistant text reply (with or without a chart). */
  message?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Assistant text rendered as markdown: the agent replies with bold/tables/lists,
 * which looked like raw `**` and `|` pipes as plain text. renderMarkdown
 * sanitizes the HTML, so dangerouslySetInnerHTML is safe here.
 */
function MarkdownText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text, { breaks: true }), [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

const EXAMPLE_PROMPTS = [
  'Top 10 channels by views this week as a bar chart',
  'Daily active subscribers for the last 30 days',
  'Requests per hour today as a time series',
];

export function GenPanelChat({ onClose }: Props) {
  const styles = useStyles2(getStyles);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // The generated SQL is executed by a Grafana ClickHouse datasource (with its
  // own credentials) — the panel must know which one. Pick it automatically:
  // the picker is only shown when there is more than one to choose from.
  const clickhouseDatasources = useMemo(
    () => getDataSourceSrv().getList({ all: true }).filter((ds) => ds.type.includes('clickhouse')),
    []
  );
  const [datasource, setDatasource] = useState<DataSourceRef | undefined>(() =>
    clickhouseDatasources.length > 0 ? getDataSourceRef(clickhouseDatasources[0]) : undefined
  );

  const idRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { value: health } = useAsync(() => checkAssistantHealth(), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, busy]);

  // Stop the agent run (and stop burning tokens) when the drawer unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const serviceUp = AI_PANEL_DEMO_MODE || Boolean(health?.ok);
  const canSend = input.trim() !== '' && !busy && (AI_PANEL_DEMO_MODE || (serviceUp && Boolean(datasource)));

  const patchEntry = (id: number, patch: Partial<ChatEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const onSend = async () => {
    const prompt = input.trim();
    if (prompt === '' || busy) {
      return;
    }

    setInput('');
    const id = ++idRef.current;

    if (AI_PANEL_DEMO_MODE) {
      const panel = buildDemoPanel(prompt, entries.length);
      setEntries((prev) => [...prev, { id, prompt, status: 'done', scene: buildInlineChartScene(panel) }]);
      return;
    }

    if (!datasource) {
      return;
    }

    setBusy(true);
    setEntries((prev) => [...prev, { id, prompt, status: 'running', progressText: '', toolCounts: {} }]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const result = await generatePanel({
        prompt,
        // The agent's exploration queries execute in this browser through the
        // selected datasource — same data and permissions as the final panel.
        datasource,
        sessionId: sessionRef.current,
        signal: abortController.signal,
        onProgress: (p: AssistantProgress) => {
          patchEntry(id, { progressText: p.text, toolCounts: p.toolCounts });
        },
      });
      sessionRef.current = result.sessionId ?? sessionRef.current;

      if (result.spec) {
        const panel = buildGeneratedPanel(result.spec, datasource);
        const scene = buildInlineChartScene(panel, result.spec.timeFrom, result.spec.timeTo);
        patchEntry(id, {
          status: 'done',
          scene,
          spec: result.spec,
          message: result.message,
          durationMs: result.durationMs,
        });
      } else {
        // Valid outcome without a chart (e.g. "no such table in the schema").
        patchEntry(id, { status: 'message', message: result.message || '—' });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      patchEntry(id, { status: 'error', error });
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const onClear = () => {
    setEntries([]);
    sessionRef.current = null; // fresh conversation on the service side too
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
      subtitle={t(
        'dashboard.ai-panel.chat-subtitle',
        'Describe a chart — the assistant explores ClickHouse, writes the SQL and renders it.'
      )}
      onClose={onClose}
      size="lg"
      // Analytix: open almost full-width, leaving only the left menu visible.
      width="calc(100vw - 72px)"
    >
      <div className={styles.container}>
        <div className={styles.messages}>
          {!AI_PANEL_DEMO_MODE && health && !health.ok && (
            <Alert severity="warning" title={t('dashboard.ai-panel.service-down-title', 'Assistant is offline')}>
              <Trans i18nKey="dashboard.ai-panel.service-down-body">
                The ai-grafana-helper service is not reachable. Start it locally (npm start) and reopen the chat.
              </Trans>
            </Alert>
          )}

          {entries.length === 0 && (
            <div className={styles.empty}>
              <div className={styles.emptyGlow}>
                <Icon name="ai" size="xxl" />
              </div>
              <div className={styles.emptyTitle}>
                <Trans i18nKey="dashboard.ai-panel.empty-title">What should we chart?</Trans>
              </div>
              <div className={styles.emptySub}>
                <Trans i18nKey="dashboard.ai-panel.empty-sub">
                  Ask in plain language — each request adds a chart below, and follow-ups refine it.
                </Trans>
              </div>
              <div className={styles.chips}>
                {EXAMPLE_PROMPTS.map((example) => (
                  <button key={example} type="button" className={styles.chip} onClick={() => setInput(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {entries.map((entry) => (
            <div key={entry.id} className={styles.exchange}>
              <div className={styles.userBubble}>{entry.prompt}</div>

              {entry.status === 'running' && (
                <div className={styles.agentCard}>
                  <div className={styles.agentHeader}>
                    <span className={styles.pulseDot} />
                    <span className={styles.agentTitle}>
                      <Trans i18nKey="dashboard.ai-panel.working">Analyzing the data…</Trans>
                    </span>
                    <span className={styles.toolChips}>
                      {Object.entries(entry.toolCounts || {}).map(([tool, count]) => (
                        <span key={tool} className={styles.toolChip}>
                          {tool}
                          {count > 1 ? ` ×${count}` : ''}
                        </span>
                      ))}
                    </span>
                  </div>
                  {entry.progressText && (
                    <MarkdownText className={cx(styles.progressText, styles.markdownBody)} text={entry.progressText} />
                  )}
                </div>
              )}

              {entry.status === 'error' && (
                <Alert severity="error" title={t('dashboard.ai-panel.chat-error', 'Could not generate the panel')}>
                  {entry.error}
                </Alert>
              )}

              {entry.status === 'message' && (
                <MarkdownText className={cx(styles.assistantBubble, styles.markdownBody)} text={entry.message || ''} />
              )}

              {entry.status === 'done' && entry.scene && (
                <div className={styles.chartCard}>
                  <div className={styles.chartBody}>
                    <entry.scene.Component model={entry.scene} />
                  </div>
                  <div className={styles.chartFooter}>
                    {entry.spec && <span className={styles.typeBadge}>{entry.spec.panelType}</span>}
                    {entry.message && <MarkdownText className={styles.chartNote} text={entry.message} />}
                    {entry.durationMs != null && (
                      <span className={styles.duration}>
                        {t('dashboard.ai-panel.duration', '{{seconds}}s', {
                          seconds: (entry.durationMs / 1000).toFixed(1),
                        })}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>

        <div className={styles.composer}>
          {AI_PANEL_DEMO_MODE && (
            <div className={styles.demoHint}>
              <Trans i18nKey="dashboard.ai-panel.chat-demo">Demo mode — any prompt renders a sample chart.</Trans>
            </div>
          )}
          {!AI_PANEL_DEMO_MODE && clickhouseDatasources.length === 0 && (
            <Alert severity="warning" title={t('dashboard.ai-panel.no-ds-title', 'No ClickHouse datasource')}>
              <Trans i18nKey="dashboard.ai-panel.no-ds-body">
                Add a ClickHouse datasource in Grafana first — the generated panel needs one to run its query.
              </Trans>
            </Alert>
          )}
          {/* One datasource = zero questions; the picker appears only when there is a real choice. */}
          {!AI_PANEL_DEMO_MODE && clickhouseDatasources.length > 1 && (
            <div className={styles.dsRow}>
              <span className={styles.dsLabel}>
                <Trans i18nKey="dashboard.ai-panel.datasource-label">ClickHouse datasource</Trans>
              </span>
              <DataSourcePicker
                current={datasource ?? null}
                filter={(ds: DataSourceInstanceSettings) => ds.type.includes('clickhouse')}
                onChange={(ds: DataSourceInstanceSettings) => setDatasource(getDataSourceRef(ds))}
                noDefault
              />
            </div>
          )}

          <div className={styles.inputRow}>
            <TextArea
              className={styles.textarea}
              rows={2}
              placeholder={t('dashboard.ai-panel.chat-placeholder', 'e.g. Show the last 30 days as a pie chart')}
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <button
              type="button"
              className={styles.sendButton}
              disabled={!canSend}
              onClick={onSend}
              aria-label={t('dashboard.ai-panel.chat-send', 'Send')}
            >
              <Icon name="arrow-up" size="lg" />
            </button>
          </div>

          <div className={styles.footerRow}>
            <span className={styles.hint}>
              <Trans i18nKey="dashboard.ai-panel.hint">Enter — send · Shift+Enter — new line</Trans>
            </span>
            <IconButton
              name="trash-alt"
              size="sm"
              tooltip={t('dashboard.ai-panel.chat-clear', 'Clear the conversation')}
              disabled={!entries.length}
              onClick={onClear}
            />
          </div>
        </div>
      </div>
    </Drawer>
  );
}

const pulse = keyframes({
  '0%': { boxShadow: `0 0 0 0 rgb(53 185 68 / 45%)` },
  '70%': { boxShadow: `0 0 0 8px rgb(53 185 68 / 0%)` },
  '100%': { boxShadow: `0 0 0 0 rgb(53 185 68 / 0%)` },
});

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
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    marginTop: theme.spacing(6),
    textAlign: 'center',
  }),
  emptyGlow: css({
    width: 72,
    height: 72,
    display: 'grid',
    placeItems: 'center',
    borderRadius: theme.shape.radius.circle,
    color: analytix.greenBright,
    background: `radial-gradient(circle at 50% 35%, rgb(53 185 68 / 22%), transparent 70%), ${analytix.surfaceRaised}`,
    border: `1px solid ${analytix.border}`,
    boxShadow: '0 0 32px rgb(53 185 68 / 18%)',
  }),
  emptyTitle: css({
    fontSize: theme.typography.h3.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    color: analytix.text,
  }),
  emptySub: css({
    color: analytix.textMuted,
    maxWidth: 440,
  }),
  chips: css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  }),
  chip: css({
    background: analytix.control,
    color: analytix.textDim,
    border: `1px solid ${analytix.borderControl}`,
    borderRadius: theme.shape.radius.pill,
    padding: theme.spacing(0.75, 1.5),
    cursor: 'pointer',
    [theme.transitions.handleMotion('no-preference')]: {
      transition: `all ${analytix.transitionFast}`,
    },
    '&:hover': {
      borderColor: analytix.green,
      color: analytix.text,
      boxShadow: analytix.focusRing,
    },
  }),
  exchange: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  userBubble: css({
    alignSelf: 'flex-end',
    maxWidth: '78%',
    background: analytix.control,
    border: `1px solid ${analytix.borderControl}`,
    borderRadius: analytix.radiusPanel,
    borderBottomRightRadius: theme.shape.radius.default,
    padding: theme.spacing(1, 1.5),
    whiteSpace: 'pre-wrap',
  }),
  assistantBubble: css({
    alignSelf: 'flex-start',
    maxWidth: '85%',
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    borderBottomLeftRadius: theme.shape.radius.default,
    padding: theme.spacing(1, 1.5),
    color: analytix.textDim,
  }),
  // Rendered-markdown polish shared by the assistant bubble and live progress:
  // compact paragraphs, Analytix-toned tables and code.
  markdownBody: css({
    '& p': { margin: 0, marginBottom: theme.spacing(0.5) },
    '& p:last-child': { marginBottom: 0 },
    '& ul, & ol': { margin: theme.spacing(0.5, 0), paddingLeft: theme.spacing(2.5) },
    '& strong': { color: analytix.text },
    '& a': { color: analytix.greenBright },
    '& h1, & h2, & h3, & h4, & h5, & h6': {
      fontSize: theme.typography.body.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      color: analytix.text,
      margin: theme.spacing(0.5, 0),
    },
    '& table': {
      borderCollapse: 'collapse',
      margin: theme.spacing(0.5, 0),
    },
    '& th, & td': {
      border: `1px solid ${analytix.border}`,
      padding: theme.spacing(0.5, 1),
      textAlign: 'left',
    },
    '& th': {
      color: analytix.text,
      fontWeight: theme.typography.fontWeightMedium,
      background: analytix.control,
    },
    '& code': {
      background: analytix.control,
      borderRadius: theme.shape.radius.default,
      padding: '1px 4px',
      fontSize: theme.typography.bodySmall.fontSize,
    },
    '& pre': {
      background: analytix.controlSunken,
      border: `1px solid ${analytix.borderControl}`,
      borderRadius: analytix.radiusControl,
      padding: theme.spacing(1),
      overflowX: 'auto',
      '& code': { background: 'none', padding: 0 },
    },
    '& blockquote': {
      margin: theme.spacing(0.5, 0),
      paddingLeft: theme.spacing(1.5),
      borderLeft: `2px solid ${analytix.green}`,
      color: analytix.textMuted,
    },
  }),
  agentCard: css({
    alignSelf: 'stretch',
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    padding: theme.spacing(1.5),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  agentHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  pulseDot: css({
    width: 8,
    height: 8,
    borderRadius: theme.shape.radius.circle,
    background: analytix.greenBright,
    [theme.transitions.handleMotion('no-preference')]: {
      animation: `${pulse} 1.6s ease-out infinite`,
    },
  }),
  agentTitle: css({
    color: analytix.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  toolChips: css({
    display: 'flex',
    gap: theme.spacing(0.5),
    flexWrap: 'wrap',
  }),
  toolChip: css({
    fontSize: theme.typography.bodySmall.fontSize,
    color: analytix.greenBright,
    background: 'rgb(53 185 68 / 12%)',
    border: `1px solid ${analytix.greenDark}`,
    borderRadius: theme.shape.radius.pill,
    padding: '1px 8px',
  }),
  progressText: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
    maxHeight: 120,
    overflowY: 'auto',
  }),
  chartCard: css({
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    padding: theme.spacing(1),
    [theme.transitions.handleMotion('no-preference')]: {
      transition: `border-color ${analytix.transitionFast}`,
    },
    '&:hover': {
      borderColor: analytix.borderHover,
    },
  }),
  chartBody: css({
    height: 320,
  }),
  chartFooter: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 0.5, 0),
  }),
  typeBadge: css({
    fontSize: theme.typography.bodySmall.fontSize,
    color: analytix.greenBright,
    background: 'rgb(53 185 68 / 12%)',
    border: `1px solid ${analytix.greenDark}`,
    borderRadius: theme.shape.radius.pill,
    padding: '0 8px',
  }),
  chartNote: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    // The note is a one-line summary: keep markdown blocks inline so the
    // ellipsis still applies, and bold stays subtle at footer contrast.
    '& p': { display: 'inline', margin: 0 },
    '& strong': { fontWeight: theme.typography.fontWeightMedium },
  }),
  duration: css({
    marginLeft: 'auto',
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  composer: css({
    borderTop: `1px solid ${analytix.border}`,
    paddingTop: theme.spacing(1.5),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  dsRow: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    maxWidth: 480,
  }),
  dsLabel: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
    whiteSpace: 'nowrap',
  }),
  inputRow: css({
    display: 'flex',
    alignItems: 'flex-end',
    gap: theme.spacing(1),
  }),
  textarea: css({
    background: analytix.control,
    borderColor: analytix.borderControl,
    borderRadius: analytix.radiusControl,
    '&:focus': {
      boxShadow: analytix.focusRing,
      borderColor: analytix.green,
    },
  }),
  sendButton: css({
    width: 40,
    height: 40,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    border: 'none',
    borderRadius: theme.shape.radius.circle,
    cursor: 'pointer',
    color: '#08110a',
    background: `linear-gradient(135deg, ${analytix.green}, ${analytix.greenBright})`,
    [theme.transitions.handleMotion('no-preference')]: {
      transition: `all ${analytix.transitionFast}`,
    },
    '&:hover:not(:disabled)': {
      boxShadow: '0 0 16px rgb(53 185 68 / 45%)',
    },
    '&:disabled': {
      background: analytix.control,
      color: analytix.textFaint,
      cursor: 'not-allowed',
    },
  }),
  footerRow: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  }),
  hint: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  demoHint: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
