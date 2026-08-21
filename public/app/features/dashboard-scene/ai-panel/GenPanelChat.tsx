import { css, cx, keyframes } from '@emotion/css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAsync } from 'react-use';

import {
  AppEvents,
  DataSourceInstanceSettings,
  DataSourceRef,
  GrafanaTheme2,
  getDataSourceRef,
  renderMarkdown,
} from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { DataSourcePicker, getAppEvents, getDataSourceSrv } from '@grafana/runtime';
import { EmbeddedScene, VizPanel } from '@grafana/scenes';
import { Alert, Button, ConfirmModal, Drawer, Icon, IconButton, TextArea, useStyles2, useTheme2 } from '@grafana/ui';
import { DOCKED_MENU_COLLAPSED_WIDTH, DOCKED_MENU_WIDTH } from 'app/core/components/AppChrome/MegaMenu/MegaMenu';
import { useGrafana } from 'app/core/context/GrafanaContext';
import { analytix } from 'app/features/home/analytixTokens';

import {
  AssistantError,
  AssistantProgress,
  SuggestedPrompt,
  checkAssistantHealth,
  fetchSuggestions,
  generatePanel,
} from './assistantClient';
import { buildGeneratedPanel } from './buildPanel';
import { AI_PANEL_DEMO_MODE, buildDemoPanel } from './demo';
import { canExportImage, ExportState, exportPanelCsv, exportPanelPng, exportState } from './exportPanel';
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
  /** The built panel, kept so CSV export can read its live query result. */
  panel?: VizPanel;
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
function MarkdownText({
  text,
  className,
  innerRef,
}: {
  text: string;
  className?: string;
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  const html = useMemo(() => renderMarkdown(text, { breaks: true }), [text]);
  // dir="auto": RTL languages (Arabic, Hebrew) align right and read правильно.
  return <div ref={innerRef} className={className} dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * The insight text under a chart: clamped to two lines, with a Show more/less
 * toggle rendered ONLY when the text actually overflows the clamp — a short
 * one-line note gets no dangling "Show more". Overflow is re-measured on
 * resize (the drawer tracks the sidebar and changes width while open).
 */
function ChartNote({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  const styles = useStyles2(getStyles);
  const noteRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = noteRef.current;
    // While expanded nothing is clipped (scrollHeight == clientHeight), so
    // measuring would wrongly clear the flag; the toggle stays via `expanded`
    // below and the clamp state is re-measured after the user collapses.
    if (!el || expanded) {
      return undefined;
    }
    let disposed = false;
    const measure = () => {
      if (!disposed) {
        setClamped(el.scrollHeight - el.clientHeight > 1);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // A late web-font swap can reflow the text without changing the clamped
    // box size (which is all the observer sees) — re-measure once fonts load.
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [text, expanded]);

  return (
    <div className={styles.noteWrap}>
      <MarkdownText
        innerRef={noteRef}
        className={cx(styles.chartNote, expanded && styles.chartNoteExpanded)}
        text={text}
      />
      {(clamped || expanded) && (
        <button type="button" className={styles.noteToggle} onClick={onToggle}>
          {expanded
            ? t('dashboard.ai-panel.note-collapse', 'Show less')
            : t('dashboard.ai-panel.note-expand', 'Show more')}
        </button>
      )}
    </div>
  );
}

// Human-readable, localized labels for the backend tool names shown as progress
// chips — never the raw `ch_query` / `emit_panel` jargon, and never a language
// hardcoded independently of the UI locale. Unknown tools fall back to their id.
function toolLabel(tool: string): string {
  switch (tool) {
    case 'ch_query':
      return t('dashboard.ai-panel.tool-query', 'querying data');
    case 'ch_databases':
      return t('dashboard.ai-panel.tool-databases', 'listing databases');
    case 'ch_tables':
      return t('dashboard.ai-panel.tool-tables', 'listing tables');
    case 'ch_describe':
      return t('dashboard.ai-panel.tool-describe', 'reading schema');
    case 'skill_doc':
      return t('dashboard.ai-panel.tool-docs', 'reading docs');
    case 'emit_panel':
      return t('dashboard.ai-panel.tool-emit', 'building panel');
    case 'escalate':
      return t('dashboard.ai-panel.tool-escalate', 'deep analysis');
    default:
      return tool;
  }
}

// Turn a raw backend/transport error into one calm, localized sentence for a
// non-technical user. The raw text (429s, SDK/ClickHouse stack messages, dev
// hints) is never shown verbatim; unknown errors get a generic line.
function humanizeError(raw: string): string {
  const r = (raw || '').toLowerCase();
  if (r.includes('daily usage limit') || r.includes('quota')) {
    return t('dashboard.ai-panel.err-quota', 'The daily usage limit has been reached. Please try again later.');
  }
  if (r.includes('too many concurrent') || r.includes('rate limit') || r.includes('slow down') || r.includes('429')) {
    return t('dashboard.ai-panel.err-busy', 'AI Insider is busy right now. Please try again in a moment.');
  }
  if (r.includes('did not finish within') || r.includes('stopped responding') || r.includes('timeout') || r.includes('timed out')) {
    return t('dashboard.ai-panel.err-timeout', 'This took longer than expected. Please try again.');
  }
  if (r.includes('failed to fetch') || r.includes('networkerror') || r.includes('service error') || r.includes('load failed')) {
    return t('dashboard.ai-panel.err-offline', 'Can’t reach AI Insider right now. Please try again shortly.');
  }
  return raw;
}

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

// Bound the in-memory conversation: every entry can hold a live chart scene and
// the drawer may stay open all day — past the cap the oldest exchanges are
// dropped (they are not persisted anywhere anyway).
const MAX_ENTRIES = 50;

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
  const theme = useTheme2();

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
  // Closing the drawer kills the in-flight agent run (see the unmount effect),
  // and multi-minute runs die to a stray Esc — so a running generation asks first.
  const [confirmClose, setConfirmClose] = useState(false);

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
  // Guards against a duplicate PNG download while the first export awaits the
  // logo preload (see onExportPng).
  const pngExportingRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only follows the stream while the user is already at the bottom;
  // if they scroll up to read a previous chart, progress ticks stop yanking them
  // back down (~4/s during a multi-minute run).
  const stickToBottomRef = useRef(true);
  // Bumped on Clear so a still-in-flight run that resolves afterwards cannot
  // write its session id / result back into the freshly-cleared conversation.
  const genRef = useRef(0);
  // Per-entry expand toggle for the insight text under a chart.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  // Health is re-checked on an interval, not just once per mount: a service
  // that was briefly down (or not yet up) no longer locks the composer into a
  // false "offline" state until the user reopens the chat — and a service that
  // goes down mid-conversation is noticed too.
  const [health, setHealth] = useState<{ ok: boolean } | undefined>();
  useEffect(() => {
    if (AI_PANEL_DEMO_MODE) {
      return undefined;
    }
    let cancelled = false;
    const check = () => {
      checkAssistantHealth().then((h) => {
        if (!cancelled) {
          setHealth(h);
        }
      });
    };
    check();
    const timer = window.setInterval(check, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
    if (stickToBottomRef.current) {
      // Instant (not smooth): a smooth animation fires intermediate scroll
      // events at non-bottom positions, which onMessagesScroll would misread as
      // "user scrolled up" and switch auto-follow off mid-stream.
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [entries, busy]);

  // Track whether the user is pinned to the bottom; a small threshold absorbs
  // sub-pixel rounding and the smooth-scroll tail.
  const onMessagesScroll = () => {
    const el = messagesRef.current;
    if (el) {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }
  };

  // Stop the agent run (and stop burning tokens) when the drawer unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const serviceUp = AI_PANEL_DEMO_MODE || Boolean(health?.ok);
  const canSend = input.trim() !== '' && !busy && (AI_PANEL_DEMO_MODE || (serviceUp && Boolean(datasource)));

  const patchEntry = (id: number, patch: Partial<ChatEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  // Shared by the composer send button and the per-entry retry: retries replay
  // the same prompt with the session id kept, so a timed-out agent resumes
  // from everything it already discovered instead of starting over.
  const runPrompt = async (prompt: string) => {
    if (prompt === '' || busy) {
      return;
    }

    const id = ++idRef.current;

    if (AI_PANEL_DEMO_MODE) {
      const panel = buildDemoPanel(prompt, entries.length);
      // Keep the panel too so CSV export works offline (PNG stays hidden without
      // a spec/panelType). The explicit ChatEntry annotation stops TS from
      // widening the status literal inside the array-spread + slice chain.
      const demoEntry: ChatEntry = { id, prompt, status: 'done', scene: buildInlineChartScene(panel), panel };
      setEntries((prev) => [...prev, demoEntry].slice(-MAX_ENTRIES));
      return;
    }

    if (!datasource) {
      return;
    }

    // Snapshot the conversation generation: if the user hits Clear while this
    // run streams, genRef changes and the guards below drop the late result.
    const myGen = genRef.current;
    stickToBottomRef.current = true; // a new prompt always scrolls into view

    setBusy(true);
    // Annotated for the same literal-widening reason as the demo entry above.
    const runningEntry: ChatEntry = { id, prompt, status: 'running', progressText: '', toolCounts: {} };
    setEntries((prev) => [...prev, runningEntry].slice(-MAX_ENTRIES));

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
          if (genRef.current === myGen) {
            patchEntry(id, { progressText: p.text, toolCounts: p.toolCounts });
          }
        },
        // Keep the session id from the moment the agent opens it: a Stop press
        // then still leaves the next message resuming the agent's discoveries.
        onSession: (sid) => {
          if (genRef.current === myGen) {
            sessionRef.current = sid;
          }
        },
      });
      if (genRef.current !== myGen) {
        return; // conversation was cleared mid-run — discard this result
      }
      sessionRef.current = result.sessionId ?? sessionRef.current;

      if (result.spec) {
        const panel = buildGeneratedPanel(result.spec, datasource);
        const scene = buildInlineChartScene(panel, result.spec.timeFrom, result.spec.timeTo);
        patchEntry(id, {
          status: 'done',
          scene,
          panel,
          spec: result.spec,
          message: result.message,
          durationMs: result.durationMs,
        });
      } else {
        // Valid outcome without a chart (e.g. "no such table in the schema").
        patchEntry(id, { status: 'message', message: result.message || '—' });
      }
    } catch (e) {
      if (genRef.current !== myGen) {
        return; // conversation was cleared mid-run — discard this outcome
      }
      if (abortController.signal.aborted) {
        // User pressed stop (or closed the drawer) — not a failure.
        patchEntry(id, {
          status: 'message',
          message: t('dashboard.ai-panel.stopped', 'Generation stopped.'),
        });
      } else {
        if (e instanceof AssistantError) {
          // Trust the backend's verdict on the session: a resumable id keeps a
          // retry warm; a null id (the backend detected a dead/expired session)
          // clears ours so the retry starts fresh instead of replaying a ghost.
          sessionRef.current = e.sessionId;
        }
        const error = e instanceof Error ? e.message : String(e);
        patchEntry(id, { status: 'error', error });
      }
    } finally {
      if (genRef.current === myGen) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  const onSend = () => {
    const prompt = input.trim();
    if (prompt === '' || busy) {
      return;
    }
    setInput('');
    runPrompt(prompt);
  };

  // Stop the current generation: aborting the SSE fetch closes the stream,
  // and the backend kills the agent run on disconnect (no more tokens burned).
  const onStop = () => {
    abortRef.current?.abort();
  };

  const onClear = () => {
    // Abort any in-flight run and invalidate it (genRef) so its late result
    // can't land back in the cleared conversation or revive the old session id.
    genRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setEntries([]);
    setExpanded(new Set());
    sessionRef.current = null; // fresh conversation on the service side too
    setBusy(false);
  };

  // A state-specific message: "still loading" only when the query really is in
  // flight — a finished-but-empty or failed panel says so instead, so the user
  // does not click retry forever.
  const notifyExport = (state: ExportState) => {
    const message =
      state === 'error'
        ? t('dashboard.ai-panel.export-error', 'The chart could not load, so there is nothing to export.')
        : state === 'empty'
          ? t('dashboard.ai-panel.export-empty', 'This chart has no data to export.')
          : t('dashboard.ai-panel.export-loading', 'The chart is still loading — try the export again in a moment.');
    getAppEvents().publish({ type: AppEvents.alertWarning.name, payload: [message] });
  };

  // Export the chart's data as CSV (all panel types) or the chart itself as PNG
  // (canvas panels only). Both are best-effort: until the query resolves the
  // helper reports why and we surface the matching message.
  const onExportCsv = (entry: ChatEntry) => {
    if (!entry.panel) {
      notifyExport('loading');
      return;
    }
    const state = exportPanelCsv(entry.panel, entry.spec?.title || 'panel', theme);
    if (state !== 'ready') {
      notifyExport(state);
    }
  };

  const onExportPng = async (event: React.MouseEvent<HTMLElement>, entry: ChatEntry) => {
    // The first export may await the logo fetch (up to ~1.5s) with no visible
    // feedback; without this guard an impatient second click would download a
    // duplicate PNG.
    if (pngExportingRef.current) {
      return;
    }
    pngExportingRef.current = true;
    // Resolve the card root before the first await: currentTarget is only
    // valid synchronously during the event dispatch.
    const root = event.currentTarget.closest<HTMLElement>('[data-chart-export-root]');
    let started = false;
    try {
      started = await exportPanelPng(root, entry.spec?.title || 'panel', {
        background: theme.colors.background.elevated,
        text: theme.colors.text.primary,
        fontFamily: theme.typography.fontFamily,
      });
    } finally {
      pngExportingRef.current = false;
    }
    if (!started) {
      // No canvas yet: report the panel's real state (a ready panel whose canvas
      // is momentarily absent counts as still-rendering).
      const state = entry.panel ? exportState(entry.panel) : 'loading';
      notifyExport(state === 'ready' ? 'loading' : state);
    }
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
      <div className={styles.messages} ref={messagesRef} onScroll={onMessagesScroll}>
        {!AI_PANEL_DEMO_MODE && health && !health.ok && (
          <Alert severity="warning" title={t('dashboard.ai-panel.service-down-title', 'AI Insider is unavailable')}>
            <Trans i18nKey="dashboard.ai-panel.service-down-body">
              AI Insider can’t be reached right now. Please try again shortly.
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
                  <span className={styles.chipText} dir="auto">
                    {suggestion.prompt}
                  </span>
                  <span className={styles.chipKind}>{KIND_LABELS[suggestion.kind] ?? suggestion.kind}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) => (
          <div key={entry.id} className={styles.exchange}>
            <div className={styles.userBubble} dir="auto">
              {entry.prompt}
            </div>

            {entry.status === 'running' && (
              <div className={styles.agentCard} role="status" aria-live="polite">
                <div className={styles.agentHeader}>
                  <span className={styles.pulseDot} />
                  <span className={styles.agentTitle}>
                    <Trans i18nKey="dashboard.ai-panel.working">Analyzing the data…</Trans>
                  </span>
                  <span className={styles.toolChips}>
                    {Object.entries(entry.toolCounts || {}).map(([tool, count]) => (
                      <span key={tool} className={styles.toolChip}>
                        {toolLabel(tool)}
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
                <div>{humanizeError(entry.error || '')}</div>
                <Button
                  className={styles.retryButton}
                  size="sm"
                  variant="secondary"
                  icon="sync"
                  disabled={busy}
                  onClick={() => runPrompt(entry.prompt)}
                >
                  <Trans i18nKey="dashboard.ai-panel.chat-retry">Retry</Trans>
                </Button>
              </Alert>
            )}

            {entry.status === 'message' && (
              <MarkdownText className={cx(styles.assistantBubble, styles.markdownBody)} text={entry.message || ''} />
            )}

            {entry.status === 'done' && entry.scene && (
              <div className={styles.chartCard} data-chart-export-root>
                {/* Export controls overlay the panel's empty top-right header
                    corner, reading as panel actions (the title stays left). */}
                <div className={styles.exportButtons}>
                  <IconButton
                    name="download-alt"
                    size="lg"
                    tooltip={t('dashboard.ai-panel.export-csv', 'Download CSV')}
                    onClick={() => onExportCsv(entry)}
                  />
                  {entry.spec && canExportImage(entry.spec.panelType) && (
                    <IconButton
                      name="camera"
                      size="lg"
                      tooltip={t('dashboard.ai-panel.export-png', 'Download PNG')}
                      onClick={(e) => onExportPng(e, entry)}
                    />
                  )}
                </div>
                <div className={styles.chartBody}>
                  <entry.scene.Component model={entry.scene} />
                </div>
                <div className={styles.chartFooter}>
                  {entry.spec && <span className={styles.typeBadge}>{entry.spec.panelType}</span>}
                  {entry.message && (
                    <ChartNote
                      text={entry.message}
                      expanded={expanded.has(entry.id)}
                      onToggle={() => toggleExpanded(entry.id)}
                    />
                  )}
                  {entry.durationMs != null && (
                    <span className={cx(styles.duration, styles.durationEnd)}>
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
              Add a ClickHouse datasource in Analytix first — the generated panel needs one to run its query.
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
            dir="auto"
            rows={2}
            aria-label={t('dashboard.ai-panel.chat-input-label', 'Describe the panel you want')}
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

  const handleClose = () => {
    // Confirm before discarding real work: a running generation, or a
    // conversation with results the user cannot get back (nothing is persisted).
    if (busy || entries.length > 0) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Drawer
        // Custom header node (the Drawer renders string titles itself, but a
        // ReactNode replaces the whole block): product name + Beta pill + tagline.
        title={header}
        onClose={handleClose}
        size="lg"
        // Never close on an accidental backdrop click — the conversation and its
        // panels are in-memory only and a stray click would lose them silently.
        // Esc and the close button still route through handleClose (which confirms).
        closeOnMaskClick={false}
        // Analytix: open almost full-width, leaving the left menu visible —
        // the width tracks the sidebar state so the drawer never covers it.
        width={`calc(100vw - ${menuWidth}px)`}
      >
        {body}
      </Drawer>
      <ConfirmModal
        isOpen={confirmClose}
        title={
          busy
            ? t('dashboard.ai-panel.close-confirm-title', 'Generation in progress')
            : t('dashboard.ai-panel.close-discard-title', 'Discard this conversation?')
        }
        body={
          busy
            ? t(
                'dashboard.ai-panel.close-confirm-body',
                'Closing the chat stops the current generation and discards this conversation. Close anyway?'
              )
            : t(
                'dashboard.ai-panel.close-discard-body',
                'Closing the chat discards this conversation and its panels — they are not saved. Close anyway?'
              )
        }
        confirmText={t('dashboard.ai-panel.close-confirm-yes', 'Close')}
        dismissText={t('dashboard.ai-panel.close-confirm-no', 'Keep working')}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onDismiss={() => setConfirmClose(false)}
      />
    </>
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
    // Anchor for the export-buttons overlay in the top-right corner.
    position: 'relative',
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
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 0.5, 0),
  }),
  noteWrap: css({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.spacing(0.25),
  }),
  noteToggle: css({
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: analytix.green,
    fontSize: theme.typography.bodySmall.fontSize,
    '&:hover': { textDecoration: 'underline' },
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
    // Collapsed: clamp to two lines (multi-line ellipsis) instead of a single
    // truncated line, so the insight is readable at a glance and fully via the
    // Show more toggle. Keep markdown blocks inline so the clamp applies.
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
    '& p': { display: 'inline', margin: 0 },
    '& strong': { fontWeight: theme.typography.fontWeightMedium },
  }),
  chartNoteExpanded: css({
    // Expanded: show the whole insight, wrapping normally.
    display: 'block',
    WebkitLineClamp: 'unset',
    overflow: 'visible',
    '& p': { display: 'block', margin: 0 },
  }),
  exportButtons: css({
    // Overlaid on the panel's own (empty) top-right header corner so the
    // export controls read as panel actions.
    position: 'absolute',
    top: theme.spacing(1),
    right: theme.spacing(1.5),
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    // Opaque pill: a very long generated panel title truncates only at the
    // card's right edge and would otherwise render beneath the transparent
    // icon buttons.
    background: theme.colors.background.elevated,
    borderRadius: theme.shape.radius.pill,
    padding: theme.spacing(0.25, 0.75),
  }),
  duration: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
    whiteSpace: 'nowrap',
  }),
  durationEnd: css({
    // Right edge of the chart footer, after the (flexible) insight note.
    marginLeft: 'auto',
    flexShrink: 0,
  }),
  retryButton: css({
    marginTop: theme.spacing(1),
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
