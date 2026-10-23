import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Icon, IconName, useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { domainState } from './DataAccessMenu';
import { DataDomain } from './assistantClient';

interface Props {
  /** Runs an example request right away (same path as the composer send). */
  onTry: (prompt: string) => void;
  /** Examples are disabled while a generation runs or the service is down. */
  canRun: boolean;
  /** Domains of the user's organization (same source as the Data menu); null while loading. */
  domains: DataDomain[] | null;
}

interface GuideSection {
  icon: IconName;
  title: string;
  items: Array<{ label: string; detail: string }>;
}

interface DomainSection extends GuideSection {
  id: DataDomain['id'];
  /** GA4 properties or CDN-log providers behind the domain, when the service lists them. */
  sourcesLabel?: string;
  examples: string[];
}

/**
 * The capability mini-guide opened by the header "Quick guide" button. It is
 * rendered locally: it opens instantly, costs no model call and always says the
 * same thing, unlike asking the agent "what can you do". What it lists follows
 * the organization's data domains, so a user with GA4 or CDN logs sees what
 * they can ask about each source. Keep it in sync with the backend skills when
 * new data domains or panel types land.
 */
export function CapabilityGuide({ onTry, canRun, domains }: Props) {
  const styles = useStyles2(getStyles);

  const domainSections: DomainSection[] = [
    {
      id: 'streaming',
      icon: 'play',
      title: t('dashboard.ai-panel.guide-streaming-title', 'Streaming & quality'),
      items: [
        {
          label: t('dashboard.ai-panel.guide-data-audience', 'Audience'),
          detail: t(
            'dashboard.ai-panel.guide-data-audience-detail',
            'active users (DAU/MAU), viewers, new vs returning, devices, platforms, app versions, countries'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-data-viewing', 'Viewing'),
          detail: t(
            'dashboard.ai-panel.guide-data-viewing-detail',
            'plays, sessions, watch time, completion rate, top channels, programs and VOD titles'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-data-quality', 'Quality'),
          detail: t(
            'dashboard.ai-panel.guide-data-quality-detail-player',
            'playback errors and error rate as the players report them, buffering, problems by device, platform or region'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-data-product', 'Product'),
          detail: t(
            'dashboard.ai-panel.guide-data-product-detail',
            'search, feature adoption, subscriptions — sliced by provider, app, platform, country or time'
          ),
        },
      ],
      examples: [
        t('dashboard.ai-panel.guide-example-dau', 'Daily active users last month'),
        t('dashboard.ai-panel.guide-example-errors', 'Playback errors by platform this week'),
        t('dashboard.ai-panel.guide-example-changes', 'What changed vs last week'),
        t('dashboard.ai-panel.guide-example-health', 'Is everything OK with playback today?'),
      ],
    },
    {
      id: 'behavior',
      icon: 'apps',
      title: t('dashboard.ai-panel.guide-behavior-title', 'App behavior (GA4)'),
      items: [
        {
          label: t('dashboard.ai-panel.guide-behavior-screens', 'Screens & buttons'),
          detail: t(
            'dashboard.ai-panel.guide-behavior-screens-detail',
            'which screens and modules are opened, what users tap, how they navigate the menu'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-behavior-funnels', 'Funnels & paths'),
          detail: t(
            'dashboard.ai-panel.guide-behavior-funnels-detail',
            'how many get from one step to the next, what users do right before or after an action'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-behavior-health', 'Installs & app health'),
          detail: t(
            'dashboard.ai-panel.guide-behavior-health-detail',
            'installs, removals, updates, crashes and crash-free users, app version adoption'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-behavior-retention', 'Coming back'),
          detail: t(
            'dashboard.ai-panel.guide-behavior-retention-detail',
            'how many users return to the app after the first open, by week or platform'
          ),
        },
      ],
      examples: [
        t('dashboard.ai-panel.guide-example-screens', 'Most opened screens in the app last week'),
        t('dashboard.ai-panel.guide-example-installs', 'App installs and removals by platform last month'),
        t('dashboard.ai-panel.guide-example-crashes', 'Crash-free users by app version this week'),
      ],
    },
    {
      id: 'cdn_logs',
      icon: 'file-alt',
      title: t('dashboard.ai-panel.guide-cdn-logs-title', 'CDN logs'),
      items: [
        {
          label: t('dashboard.ai-panel.guide-cdn-logs-errors', 'Edge errors'),
          detail: t(
            'dashboard.ai-panel.guide-cdn-logs-errors-detail',
            'HTTP status codes the CDN returned: token rejections (403), missing streams (404), CDN and origin failures (5xx)'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-cdn-logs-traffic', 'Cache & traffic'),
          detail: t(
            'dashboard.ai-panel.guide-cdn-logs-traffic-detail',
            'cache hit rate, requests and bytes by CDN, host or edge location'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-cdn-logs-streams', 'Streams & accounts'),
          detail: t(
            'dashboard.ai-panel.guide-cdn-logs-streams-detail',
            'which stream or account got errors from the CDN, and since when'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-cdn-logs-window', 'How far back'),
          detail: t(
            'dashboard.ai-panel.guide-cdn-logs-window-detail',
            'per-request detail for the last 7 days (a few hours per question), daily totals for about a year'
          ),
        },
      ],
      examples: [
        t('dashboard.ai-panel.guide-example-cdn-errors', 'CDN error rate by CDN for the last 3 hours'),
        t('dashboard.ai-panel.guide-example-cdn-cache', 'Cache hit rate by CDN today'),
        t('dashboard.ai-panel.guide-example-cdn-404', 'Streams with the most 404s from the CDN today'),
      ],
    },
  ];

  const finance = {
    id: 'finance' as const,
    icon: 'dollar-alt' as const,
    title: t('dashboard.ai-panel.guide-finance-title', 'Finance'),
  };

  const isOn = (id: DataDomain['id']) => domainState(domains, id)?.status === 'on';
  const connected = domainSections.filter((section) => isOn(section.id));
  const locked = [...domainSections, finance].filter((section) => !isOn(section.id));

  const sourcesLabel = (id: DataDomain['id']): string | undefined => {
    const names = domainState(domains, id)?.properties.map((p) => p.name) ?? [];
    if (names.length === 0) {
      return undefined;
    }
    return id === 'behavior'
      ? t('dashboard.ai-panel.guide-behavior-sources', 'Apps: {{names}}', { names: names.join(', ') })
      : t('dashboard.ai-panel.guide-cdn-logs-sources', 'Providers: {{names}}', { names: names.join(', ') });
  };

  const lockedState = (id: DataDomain['id']): string => {
    switch (domainState(domains, id)?.status) {
      case 'misconfigured':
        return t('dashboard.ai-panel.data-state-unavailable', 'Temporarily unavailable');
      case 'unavailable':
        return t('dashboard.ai-panel.data-state-soon', 'Not available yet');
      default:
        return t('dashboard.ai-panel.data-state-off', 'Not connected for your organization — ask an administrator');
    }
  };

  // With more than one source the user may need to say which one a question is about.
  const sourceHints = [
    isOn('behavior') &&
      t('dashboard.ai-panel.guide-ask-source-behavior', '“in the app” for screens, taps and installs'),
    isOn('cdn_logs') && t('dashboard.ai-panel.guide-ask-source-cdn', '“in CDN logs” for what the CDN returned'),
  ].filter((hint): hint is string => Boolean(hint));

  const generalSections: GuideSection[] = [
    {
      icon: 'chart-line',
      title: t('dashboard.ai-panel.guide-views-title', 'What you get back'),
      items: [
        {
          label: t('dashboard.ai-panel.guide-views-trends', 'Trends'),
          detail: t('dashboard.ai-panel.guide-views-trends-detail', 'time series, trend, state timeline, heatmap'),
        },
        {
          label: t('dashboard.ai-panel.guide-views-compare', 'Comparisons'),
          detail: t(
            'dashboard.ai-panel.guide-views-compare-detail',
            'bar chart, bar gauge, pie chart, histogram, XY chart'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-views-numbers', 'Numbers & lists'),
          detail: t('dashboard.ai-panel.guide-views-numbers-detail', 'stat, gauge, table, top-N rankings'),
        },
        {
          label: t('dashboard.ai-panel.guide-views-insights', 'Insights'),
          detail: t(
            'dashboard.ai-panel.guide-views-insights-detail',
            'a written explanation with real numbers: what changed, why, anomalies, health checks. Every chart exports to CSV or PNG'
          ),
        },
      ],
    },
    {
      icon: 'comments-alt',
      title: t('dashboard.ai-panel.guide-ask-title', 'How to ask'),
      items: [
        {
          label: t('dashboard.ai-panel.guide-ask-recipe', 'Metric + period + slice'),
          detail: t(
            'dashboard.ai-panel.guide-ask-recipe-detail',
            '“Watch time by platform for the last 7 days”. Add a chart type if you have one in mind'
          ),
        },
        ...(sourceHints.length > 0
          ? [
              {
                label: t('dashboard.ai-panel.guide-ask-source', 'Name the source when it is not obvious'),
                detail: isOn('behavior')
                  ? t(
                      'dashboard.ai-panel.guide-ask-source-detail-behavior',
                      '{{hints}}. Viewing and app behavior are not linked per user, so ask about them separately',
                      { hints: sourceHints.join(', ') }
                    )
                  : sourceHints.join(', '),
              },
            ]
          : []),
        {
          label: t('dashboard.ai-panel.guide-ask-names', 'Use plain names'),
          detail: t(
            'dashboard.ai-panel.guide-ask-names-detail',
            'providers, channels and devices by name — no IDs, tables or SQL needed'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-ask-followup', 'Refine with follow-ups'),
          detail: t(
            'dashboard.ai-panel.guide-ask-followup-detail',
            '“now by day”, “only Android”, “as a table” — I keep the context of the conversation'
          ),
        },
        {
          label: t('dashboard.ai-panel.guide-ask-language', 'Any language, or your voice'),
          detail: t(
            'dashboard.ai-panel.guide-ask-language-detail',
            'type or dictate in your own language — I answer in the same one'
          ),
        },
      ],
    },
  ];

  const renderItems = (items: GuideSection['items']) => (
    <ul className={styles.items}>
      {items.map((item) => (
        <li key={item.label}>
          <span className={styles.itemLabel}>{item.label}</span>
          <span className={styles.itemDetail}>{item.detail}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={styles.card}>
      <div className={styles.intro}>
        <Trans i18nKey="dashboard.ai-panel.guide-intro-sources">
          I turn your questions into ready charts and short insights. Below is the data your organization has connected
          and what you can ask about each source. I only see that data, and I never change anything.
        </Trans>
      </div>

      <div className={styles.sections}>
        {connected.map((section) => {
          const sources = sourcesLabel(section.id);
          return (
            <div key={section.id} className={styles.section}>
              <div className={styles.sectionTitle}>
                <Icon name={section.icon} />
                {section.title}
              </div>
              {sources && <div className={styles.sources}>{sources}</div>}
              {renderItems(section.items)}
              <div className={styles.examples}>
                {section.examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className={styles.example}
                    disabled={!canRun}
                    onClick={() => onTry(example)}
                  >
                    <Icon name="play" size="sm" />
                    {example}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {locked.length > 0 && (
        <div className={styles.locked}>
          {locked.map((section) => (
            <div key={section.id} className={styles.lockedRow}>
              <Icon name="lock" size="sm" />
              <span className={styles.lockedTitle}>{section.title}</span>
              <span>{lockedState(section.id)}</span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.sections}>
        {generalSections.map((section) => (
          <div key={section.title} className={styles.section}>
            <div className={styles.sectionTitle}>
              <Icon name={section.icon} />
              {section.title}
            </div>
            {renderItems(section.items)}
          </div>
        ))}
      </div>

      <div className={styles.footnote}>
        <Trans i18nKey="dashboard.ai-panel.guide-footnote-try">
          The examples run right away. Simple charts take seconds; a deeper analysis can take a few minutes. Keep this
          tab open while I work — your browser runs the queries.
        </Trans>
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  card: css({
    alignSelf: 'stretch',
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
    // Same neutral frame as the chart cards: no green accent border.
    background: theme.colors.background.elevated,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    padding: theme.spacing(2),
    color: analytix.textDim,
    [theme.transitions.handleMotion('no-preference')]: {
      transition: `border-color ${analytix.transitionFast}`,
    },
    '&:hover': {
      borderColor: analytix.borderHover,
    },
  }),
  intro: css({
    color: analytix.text,
  }),
  sections: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: theme.spacing(2),
  }),
  section: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    background: theme.colors.background.primary,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusCard,
    padding: theme.spacing(1.5),
  }),
  sectionTitle: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    color: analytix.greenBright,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  items: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: theme.typography.bodySmall.lineHeight,
  }),
  itemLabel: css({
    display: 'block',
    color: analytix.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  itemDetail: css({
    color: analytix.textMuted,
  }),
  sources: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  examples: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    // Pinned to the bottom so the examples of neighbouring sources line up.
    marginTop: 'auto',
    paddingTop: theme.spacing(0.5),
  }),
  locked: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
    color: analytix.textDim,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  lockedRow: css({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
  }),
  lockedTitle: css({
    color: analytix.textMuted,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  example: css({
    display: 'inline-flex',
    alignItems: 'center',
    // Same neutral pill as the empty-state suggestion chips in the chat.
    gap: theme.spacing(0.75),
    background: theme.colors.background.elevated,
    color: analytix.textDim,
    border: `1px solid ${analytix.borderControl}`,
    borderRadius: theme.shape.radius.pill,
    padding: theme.spacing(0.75, 1.5),
    // Long examples wrap inside a narrow source column.
    textAlign: 'left',
    cursor: 'pointer',
    '& svg': { color: analytix.textFaint },
    [theme.transitions.handleMotion('no-preference')]: {
      transition: `all ${analytix.transitionFast}`,
    },
    '&:hover:not(:disabled)': {
      borderColor: analytix.green,
      color: analytix.text,
      boxShadow: analytix.focusRing,
      '& svg': { color: analytix.greenBright },
    },
    '&:disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  }),
  footnote: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
