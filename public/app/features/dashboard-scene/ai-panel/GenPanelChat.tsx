import { css, cx, keyframes } from '@emotion/css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAsync } from 'react-use';

import {
  DataSourceInstanceSettings,
  DataSourceRef,
  GrafanaTheme2,
  getDataSourceRef,
  renderMarkdown,
} from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { DataSourcePicker, getDataSourceSrv } from '@grafana/runtime';
import { EmbeddedScene } from '@grafana/scenes';
import { Alert, Drawer, Icon, IconButton, TextArea, useStyles2 } from '@grafana/ui';
import { DOCKED_MENU_COLLAPSED_WIDTH, DOCKED_MENU_WIDTH } from 'app/core/components/AppChrome/MegaMenu/MegaMenu';
import { useGrafana } from 'app/core/context/GrafanaContext';
import { analytix } from 'app/features/home/analytixTokens';

import { AssistantProgress, SuggestedPrompt, checkAssistantHealth, fetchSuggestions, generatePanel } from './assistantClient';
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

// Friendly labels for backend tool names shown as progress chips; tools
// without an entry render under their raw name.
const TOOL_LABELS: Record<string, string> = {
  escalate: 'глубокий анализ',
};

// Cold-start suggestions: shown while the user has no history yet, and used
// to pad the personal list up to five. The kind ("summary", a panel type)
// renders as a badge on the chip — only the prompt text goes to the agent.
const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  { prompt: 'Yesterday’s key metrics and insights', kind: 'summary' },
  { prompt: 'What changed vs last week', kind: 'summary' },
  { prompt: 'Watch time by content this week', kind: 'barchart' },
  { prompt: 'Peak viewing hours yesterday', kind: 'timeseries' },
  { prompt: 'Daily active users last month', kind: 'timeseries' },
];

// Human-readable badge labels; unknown kinds render under their raw name.
const KIND_LABELS: Record<string, string> = {
  summary: 'summary',
  timeseries: 'time series',
  barchart: 'bar chart',
  piechart: 'pie chart',
  table: 'table',
  stat: 'stat',
};

export function GenPanelChat({ onClose }: Props) {
  const styles = useStyles2(getStyles);

  // Track the docked sidebar so the drawer stops at its edge in both states
  // (collapsed and expanded) and follows live toggles while the chat is open.
  const { chrome } = useGrafana();
  const { megaMenuDocked, megaMenuOpen } = chrome.useState();
  const menuWidth = megaMenuDocked ? (megaMenuOpen ? DOCKED_MENU_WIDTH : DOCKED_MENU_COLLAPSED_WIDTH) : 0;

  // The drawer mask dims the page but wheel events would still scroll the
  // document behind it (this fork scrolls the document, not an inner pane).
  // Freeze the viewport scroller while the chat is open. The lock goes on
  // <html>: the global styles force `body { overflow-y: auto !important }`
  // (a react-select workaround), so an inline style on body would lose.
  useEffect(() => {
    const previous = document.documentElement.style.overflowY;
    document.documentElement.style.overflowY = 'hidden';
    return () => {
      document.documentElement.style.overflowY = previous;
    };
  }, []);

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  // The generated SQL is executed by a Grafana ClickHouse datasource (with its
  // own credentials) — the panel must know which one. Pick it automatically:
  // the picker is only shown when there is more than one to choose from.
  const clickhouseDatasources = useMemo(
    () =>
      getDataSourceSrv()
        .getList({ all: true })
        .filter((ds) => ds.type.includes('clickhouse')),
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

  // Personal suggestions from the backend (the user's last successful
  // prompts); on any error the list is empty and the defaults fill all
  // five slots — the cold-start behavior.
  const { value: fetchedSuggestions } = useAsync(
    () => (AI_PANEL_DEMO_MODE ? Promise.resolve<SuggestedPrompt[]>([]) : fetchSuggestions()),
    []
  );
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const merged: SuggestedPrompt[] = [];
    for (const suggestion of [...(fetchedSuggestions ?? []), ...DEFAULT_PROMPTS]) {
      const key = suggestion.prompt.trim().toLowerCase();
      if (key === '' || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(suggestion);
      if (merged.length === DEFAULT_PROMPTS.length) {
        break;
      }
    }
    return merged;
  }, [fetchedSuggestions]);

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
      if (abortController.signal.aborted) {
        // User pressed stop (or closed the drawer) — not a failure.
        patchEntry(id, {
          status: 'message',
          message: t('dashboard.ai-panel.stopped', 'Generation stopped.'),
        });
      } else {
        const error = e instanceof Error ? e.message : String(e);
        patchEntry(id, { status: 'error', error });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  // Stop the current generation: aborting the SSE fetch closes the stream,
  // and the backend kills the agent run on disconnect (no more tokens burned).
  const onStop = () => {
    abortRef.current?.abort();
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

  const header = (
    <div className={styles.headerWrap}>
      <div className={styles.headerRow}>
        <span className={styles.headerTitle}>
          <Trans i18nKey="dashboard.ai-panel.chat-title">AI Insider</Trans>
        </span>
        <span className={styles.betaBadge}>
          <Trans i18nKey="dashboard.ai-panel.chat-beta">Beta</Trans>
        </span>
      </div>
      <div className={styles.headerSub}>
        <Trans i18nKey="dashboard.ai-panel.chat-subtitle">
          Ask your data anything — AI Insider writes the query, uncovers patterns, and explains what matters.
        </Trans>
      </div>
    </div>
  );

  const body = (
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
              <Trans i18nKey="dashboard.ai-panel.empty-title">What should we explore?</Trans>
            </div>
            <div className={styles.emptySub}>
              <Trans i18nKey="dashboard.ai-panel.empty-sub">
                Ask in plain language — I’ll chart the data and surface the key insights.
              </Trans>
            </div>
            <div className={styles.chips}>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.prompt}
                  type="button"
                  className={styles.chip}
                  onClick={() => setInput(suggestion.prompt)}
                >
                  <span className={styles.chipText}>{suggestion.prompt}</span>
                  <span className={styles.chipKind}>{KIND_LABELS[suggestion.kind] ?? suggestion.kind}</span>
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
                        {TOOL_LABELS[tool] ?? tool}
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
              <Trans i18nKey="dashboard.ai-panel.datasource-label">Datasource</Trans>
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
          {busy ? (
            <button
              type="button"
              className={cx(styles.sendButton, styles.stopButton)}
              onClick={onStop}
              aria-label={t('dashboard.ai-panel.chat-stop', 'Stop generation')}
              title={t('dashboard.ai-panel.chat-stop', 'Stop generation')}
            >
              <Icon name="square-shape" size="lg" />
            </button>
          ) : (
            <button
              type="button"
              className={styles.sendButton}
              disabled={!canSend}
              onClick={onSend}
              aria-label={t('dashboard.ai-panel.chat-send', 'Send')}
            >
              <Icon name="arrow-up" size="lg" />
            </button>
          )}
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
  );

  return (
    <Drawer
      // Custom header node (the Drawer renders string titles itself, but a
      // ReactNode replaces the whole block): product name + Beta pill + tagline.
      title={header}
      onClose={onClose}
      size="lg"
      // Analytix: open almost full-width, leaving the left menu visible —
      // the width tracks the sidebar state so the drawer never covers it.
      width={`calc(100vw - ${menuWidth}px)`}
    >
      {body}
    </Drawer>
  );
}

const pulse = keyframes({
  '0%': { boxShadow: `0 0 0 0 rgb(53 185 68 / 45%)` },
  '70%': { boxShadow: `0 0 0 8px rgb(53 185 68 / 0%)` },
  '100%': { boxShadow: `0 0 0 0 rgb(53 185 68 / 0%)` },
});

const getStyles = (theme: GrafanaTheme2) => ({
  headerWrap: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
  }),
  headerRow: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  headerTitle: css({
    fontSize: theme.typography.h2.fontSize,
    fontWeight: theme.typography.fontWeightBold,
    color: analytix.text,
    lineHeight: 1.1,
  }),
  betaBadge: css({
    fontSize: theme.typography.bodySmall.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    color: '#a99cff',
    background: 'rgb(124 108 255 / 14%)',
    border: '1px solid rgb(124 108 255 / 38%)',
    borderRadius: theme.shape.radius.pill,
    padding: '1px 10px',
  }),
  headerSub: css({
    color: analytix.textMuted,
    fontSize: theme.typography.body.fontSize,
  }),
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
    background: `radial-gradient(circle at 50% 35%, rgb(53 185 68 / 22%), transparent 70%), ${theme.colors.background.elevated}`,
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
    // Home-page control surface (same as the catalog filter buttons).
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    // Personal suggestions replay real prompts, which can be long — the text
    // span ellipsizes inside this cap so a chip never spans the whole row.
    maxWidth: 420,
    background: theme.colors.background.elevated,
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
  chipText: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  chipKind: css({
    flexShrink: 0,
    fontSize: theme.typography.bodySmall.fontSize,
    color: analytix.textFaint,
  }),
  exchange: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  userBubble: css({
    alignSelf: 'flex-end',
    maxWidth: '78%',
    background: theme.colors.background.elevated,
    border: `1px solid ${analytix.borderControl}`,
    borderRadius: analytix.radiusPanel,
    borderBottomRightRadius: theme.shape.radius.default,
    padding: theme.spacing(1, 1.5),
    whiteSpace: 'pre-wrap',
  }),
  assistantBubble: css({
    alignSelf: 'flex-start',
    maxWidth: '85%',
    background: theme.colors.background.elevated,
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
      // One surface step below the elevated bubble so accents stay visible.
      background: theme.colors.background.primary,
    },
    '& code': {
      background: theme.colors.background.primary,
      borderRadius: theme.shape.radius.default,
      padding: '1px 4px',
      fontSize: theme.typography.bodySmall.fontSize,
    },
    '& pre': {
      background: theme.colors.background.primary,
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
    background: theme.colors.background.elevated,
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
    background: theme.colors.background.elevated,
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
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  textarea: css({
    // Same raised grey as the home-page search field.
    background: theme.colors.background.elevated,
    borderColor: analytix.borderControl,
    borderRadius: analytix.radiusControl,
    // Quiet focus: no green ring/border — a subtle border lift is enough to
    // show the caret owner without pulling attention from the conversation.
    '&:focus': {
      outline: 'none',
      boxShadow: 'none',
      borderColor: analytix.borderHover,
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
      background: theme.colors.background.elevated,
      color: analytix.textFaint,
      cursor: 'not-allowed',
    },
  }),
  // The send circle turned into a stop control while a generation runs:
  // neutral surface, no green glow — stopping is not the primary action.
  stopButton: css({
    background: theme.colors.background.elevated,
    border: `1px solid ${analytix.borderControl}`,
    color: analytix.text,
    // Same specificity as the sendButton hover rule so the green glow loses.
    '&:hover:not(:disabled)': {
      background: theme.colors.background.elevated,
      borderColor: theme.colors.error.border,
      color: theme.colors.error.text,
      boxShadow: 'none',
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
