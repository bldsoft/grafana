import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Icon, IconName, useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

interface Props {
  /** Runs an example request right away (same path as the composer send). */
  onTry: (prompt: string) => void;
  /** Examples are disabled while a generation runs or the service is down. */
  canRun: boolean;
}

interface GuideSection {
  icon: IconName;
  title: string;
  items: Array<{ label: string; detail: string }>;
}

/**
 * The capability mini-guide opened by the header "Guide" button. It is static
 * and rendered locally: it opens instantly, costs no model call and always says
 * the same thing, unlike asking the agent "what can you do". Keep it in sync
 * with the backend skill when new data domains or panel types land.
 */
export function CapabilityGuide({ onTry, canRun }: Props) {
  const styles = useStyles2(getStyles);

  const sections: GuideSection[] = [
    {
      icon: 'database',
      title: t('dashboard.ai-panel.guide-data-title', 'Data I work with'),
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
            'dashboard.ai-panel.guide-data-quality-detail',
            'playback errors and error rate, CDN quality, problems by device, platform or region'
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
    },
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

  const examples = [
    t('dashboard.ai-panel.guide-example-dau', 'Daily active users last month'),
    t('dashboard.ai-panel.guide-example-errors', 'Playback errors by platform this week'),
    t('dashboard.ai-panel.guide-example-countries', 'Viewers by country as a pie chart'),
    t('dashboard.ai-panel.guide-example-changes', 'What changed vs last week'),
    t('dashboard.ai-panel.guide-example-health', 'Is everything OK with playback today?'),
  ];

  return (
    <div className={styles.card}>
      <div className={styles.intro}>
        <Trans i18nKey="dashboard.ai-panel.guide-intro">
          I turn questions about your streaming analytics into ready charts and short insights. I only see the data your
          organization has access to, and I never change anything.
        </Trans>
      </div>

      <div className={styles.sections}>
        {sections.map((section) => (
          <div key={section.title} className={styles.section}>
            <div className={styles.sectionTitle}>
              <Icon name={section.icon} />
              {section.title}
            </div>
            <ul className={styles.items}>
              {section.items.map((item) => (
                <li key={item.label}>
                  <span className={styles.itemLabel}>{item.label}</span>
                  <span className={styles.itemDetail}>{item.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className={styles.trySection}>
        <div className={styles.tryTitle}>
          <Trans i18nKey="dashboard.ai-panel.guide-try">Try one — it runs right away:</Trans>
        </div>
        <div className={styles.examples}>
          {examples.map((example) => (
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

      <div className={styles.footnote}>
        <Trans i18nKey="dashboard.ai-panel.guide-footnote">
          Simple charts take seconds; a deeper analysis can take a few minutes. Keep this tab open while I work — your
          browser runs the queries.
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
  trySection: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  tryTitle: css({
    color: analytix.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  examples: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
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
