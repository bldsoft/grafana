import { css, cx } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Dropdown, Icon, IconName, useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { DataDomain } from './assistantClient';

interface Props {
  /** Domains of the user's organization; null while loading or when the service predates them. */
  domains: DataDomain[] | null;
  /** Puts an example question into the composer (does not send it). */
  onPick: (prompt: string) => void;
}

interface DomainView {
  id: DataDomain['id'];
  icon: IconName;
  title: string;
  source: string;
  detail: string;
  examples: string[];
}

// Streaming is what the service always offered; an older service (no
// /api/capabilities) or a failed lookup shows exactly that.
const FALLBACK: DataDomain[] = [{ id: 'streaming', status: 'on', properties: [] }];

/**
 * The header "Data" menu: which data domains the user's organization can ask
 * about, with a few example questions per available domain. Availability
 * comes from the service (it reads the org's attributes), so the menu and the
 * agent always agree; finance is shown locked for everyone until it exists.
 */
export function DataAccessMenu({ domains, onPick }: Props) {
  const styles = useStyles2(getStyles);
  const list = domains && domains.length > 0 ? domains : FALLBACK;
  const statusOf = (id: DataDomain['id']) => list.find((d) => d.id === id);

  const views: DomainView[] = [
    {
      id: 'streaming',
      icon: 'play',
      title: t('dashboard.ai-panel.data-streaming-title', 'Streaming & quality'),
      source: 'ClickHouse',
      detail: t(
        'dashboard.ai-panel.data-streaming-detail',
        'viewers, watch time, plays, channels and titles, errors, CDN'
      ),
      examples: [t('dashboard.ai-panel.data-streaming-example', 'Active users by platform for the last 7 days')],
    },
    {
      id: 'behavior',
      icon: 'apps',
      title: t('dashboard.ai-panel.data-behavior-title', 'App behavior'),
      source: 'GA4',
      detail: t('dashboard.ai-panel.data-behavior-detail', 'screens, modules, buttons, navigation, funnels, installs'),
      examples: [
        t(
          'dashboard.ai-panel.data-behavior-example-module',
          'How many times was My List opened in the last 28 days, by platform?'
        ),
        t('dashboard.ai-panel.data-behavior-example-buttons', 'Top buttons on the player screen this week'),
        t('dashboard.ai-panel.data-behavior-example-funnel', 'Funnel: app open → My List → playback'),
      ],
    },
    {
      id: 'finance',
      icon: 'dollar-alt',
      title: t('dashboard.ai-panel.data-finance-title', 'Finance'),
      source: '',
      detail: t('dashboard.ai-panel.data-finance-detail', 'revenue, payments, ARPU'),
      examples: [],
    },
  ];

  const enabledCount = views.filter((v) => statusOf(v.id)?.status === 'on').length;

  const stateLine = (domain: DataDomain | undefined): string | null => {
    switch (domain?.status) {
      case 'on':
        return null;
      case 'misconfigured':
        return t('dashboard.ai-panel.data-state-unavailable', 'Temporarily unavailable');
      case 'unavailable':
        return t('dashboard.ai-panel.data-state-soon', 'Not available yet');
      default:
        return t('dashboard.ai-panel.data-state-off', 'Not connected for your organization — ask an administrator');
    }
  };

  const overlay = (
    <div
      className={styles.panel}
      role="dialog"
      aria-label={t('dashboard.ai-panel.data-menu-label', 'Data you can ask about')}
    >
      <div className={styles.panelTitle}>
        <Trans i18nKey="dashboard.ai-panel.data-menu-title">Data you can ask about</Trans>
      </div>
      {views.map((view) => {
        const domain = statusOf(view.id);
        const on = domain?.status === 'on';
        const state = stateLine(domain);
        const properties = view.id === 'behavior' && on ? domain?.properties.map((p) => p.name).join(', ') : '';
        return (
          <div key={view.id} className={cx(styles.domain, !on && styles.domainOff)}>
            <div className={styles.domainHead}>
              <Icon name={on ? 'check-circle' : 'lock'} className={on ? styles.iconOn : styles.iconOff} />
              <Icon name={view.icon} className={styles.domainIcon} />
              <span className={styles.domainTitle}>{view.title}</span>
              {view.source && <span className={styles.source}>{view.source}</span>}
            </div>
            <div className={styles.detail}>{view.detail}</div>
            {properties && <div className={styles.detail}>{properties}</div>}
            {state && <div className={styles.state}>{state}</div>}
            {on &&
              view.examples.map((example) => (
                <button key={example} type="button" className={styles.example} onClick={() => onPick(example)}>
                  <Icon name="angle-right" size="sm" />
                  {example}
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );

  return (
    <Dropdown placement="bottom-end" overlay={overlay}>
      <button type="button" className={styles.trigger}>
        <Icon name="database" />
        {t('dashboard.ai-panel.data-button', 'Data: {{enabled}} of {{total}}', {
          enabled: enabledCount,
          total: views.length,
        })}
        <Icon name="angle-down" />
      </button>
    </Dropdown>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  trigger: css({
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    borderRadius: theme.shape.radius.pill,
    padding: theme.spacing(1, 1.5, 1, 2),
    cursor: 'pointer',
    fontWeight: theme.typography.fontWeightMedium,
    color: analytix.text,
    background: analytix.control,
    border: `1px solid ${analytix.borderControl}`,
    [theme.transitions.handleMotion('no-preference')]: {
      transition: `all ${analytix.transitionFast}`,
    },
    '&:hover': {
      borderColor: analytix.borderHover,
    },
    '&:focus-visible': {
      outline: 'none',
      boxShadow: analytix.focusRing,
    },
  }),
  panel: css({
    width: 380,
    maxWidth: 'calc(100vw - 32px)',
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    padding: theme.spacing(2),
    background: analytix.surfaceRaised,
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    boxShadow: theme.shadows.z3,
  }),
  panelTitle: css({
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }),
  domain: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
  }),
  domainOff: css({
    opacity: 0.7,
  }),
  domainHead: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  iconOn: css({
    color: analytix.greenBright,
  }),
  iconOff: css({
    color: analytix.textDim,
  }),
  domainIcon: css({
    color: analytix.textMuted,
  }),
  domainTitle: css({
    color: analytix.text,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  source: css({
    marginLeft: 'auto',
    padding: theme.spacing(0, 1),
    borderRadius: theme.shape.radius.pill,
    border: `1px solid ${analytix.border}`,
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  detail: css({
    paddingLeft: theme.spacing(5),
    color: analytix.textMuted,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  state: css({
    paddingLeft: theme.spacing(5),
    color: analytix.textDim,
    fontSize: theme.typography.bodySmall.fontSize,
    fontStyle: 'italic',
  }),
  example: css({
    marginLeft: theme.spacing(4),
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.5, 1),
    border: 'none',
    borderRadius: analytix.radiusControl,
    background: 'transparent',
    color: analytix.text,
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover': {
      background: analytix.control,
      color: analytix.greenBright,
    },
    '&:focus-visible': {
      outline: 'none',
      boxShadow: analytix.focusRing,
    },
  }),
});
