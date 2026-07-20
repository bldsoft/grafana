import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';
import heroImage from 'img/analytix_welcome_hero.webp';

import { GridIcon } from './analytixIcons';
import { analytix } from './analytixTokens';

interface Props {
  /** Called when the primary CTA is activated. */
  onBrowse: () => void;
}

// Analytix: "Welcome to Analytix" block from the approved home-page design.
// Layout follows COMPONENT_SPEC.md: two columns (~58/42), 232px min height,
// stacking below 900px with the copy before the illustration.
export function WelcomePanel({ onBrowse }: Props) {
  const styles = useStyles2(getStyles);

  return (
    <section className={styles.panel} aria-labelledby="analytix-welcome-title">
      <div className={styles.copy}>
        <h1 id="analytix-welcome-title" className={styles.title}>
          <Trans i18nKey="analytix.home.welcome.title">Welcome to Analytix</Trans>
        </h1>
        <p className={styles.subtitle}>
          <Trans i18nKey="analytix.home.welcome.subtitle">Everything you need to understand your data</Trans>
        </p>
        <button type="button" className={styles.cta} onClick={onBrowse}>
          <span className={styles.ctaIcon}>
            <GridIcon />
          </span>
          <Trans i18nKey="analytix.home.welcome.browse">Browse dashboards</Trans>
        </button>
      </div>
      <div className={styles.visual}>
        <img
          className={styles.heroImage}
          src={heroImage}
          alt="Analytix dashboards displayed on a desktop monitor and laptop"
        />
      </div>
    </section>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css({
    position: 'relative',
    isolation: 'isolate',
    overflow: 'hidden',
    minHeight: 232,
    display: 'grid',
    gridTemplateColumns: '1.15fr .85fr',
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusPanel,
    background: analytix.panelGradient,

    // Analytix: green glow behind the product illustration
    '&::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      zIndex: -1,
      pointerEvents: 'none',
      background: 'radial-gradient(ellipse at 78% 45%, rgb(45 201 72 / 37%), transparent 46%)',
    },

    [theme.breakpoints.down('lg')]: {
      gridTemplateColumns: '1fr',
      minHeight: 410,
    },
    [theme.breakpoints.down('sm')]: {
      minHeight: 390,
    },
  }),
  copy: css({
    alignSelf: 'center',
    padding: '38px 46px',

    [theme.breakpoints.down('lg')]: {
      padding: '30px 28px 0',
    },
    [theme.breakpoints.down('sm')]: {
      padding: '25px 18px 0',
    },
  }),
  title: css({
    margin: '0 0 10px',
    color: analytix.text,
    fontSize: 'clamp(30px, 3vw, 42px)',
    lineHeight: 1.15,
    letterSpacing: '-.8px',

    [theme.breakpoints.down('sm')]: {
      fontSize: 29,
    },
  }),
  subtitle: css({
    margin: 0,
    color: '#c3c6c7',
    fontSize: 16,
    lineHeight: 1.5,

    [theme.breakpoints.down('sm')]: {
      fontSize: 14,
    },
  }),
  cta: css({
    marginTop: 28,
    minHeight: 40,
    padding: '0 17px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    border: '1px solid transparent',
    borderRadius: analytix.radiusControl,
    color: '#fff',
    font: 'inherit',
    background: 'linear-gradient(180deg, #3bc64b, #28a938)',
    boxShadow: '0 0 22px rgb(44 190 62 / 14%)',
    cursor: 'pointer',

    [theme.transitions.handleMotion('no-preference')]: {
      transition: theme.transitions.create(['filter', 'transform'], { duration: 160 }),
    },

    '&:hover': {
      filter: 'brightness(1.1)',
    },
    '&:active': {
      transform: 'translateY(1px)',
    },
    '&:focus-visible': {
      outline: 0,
      boxShadow: analytix.focusRing,
    },

    [theme.breakpoints.down('sm')]: {
      width: '100%',
      marginTop: 21,
    },
  }),
  ctaIcon: css({
    display: 'inline-flex',
    width: 18,
    height: 18,
    '& svg': { width: '100%', height: '100%', strokeWidth: 1.6 },
  }),
  visual: css({
    position: 'relative',
    minWidth: 0,
    minHeight: 230,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    // Analytix: organic ring outline behind the hero image
    '&::before': {
      content: '""',
      position: 'absolute',
      width: 290,
      height: 290,
      border: '2px solid rgb(65 222 82 / 38%)',
      // eslint-disable-next-line @grafana/no-border-radius-literal -- Analytix: organic blob shape from the approved design; no theme token can express it
      borderRadius: '42% 58% 60% 40%',
      transform: 'rotate(24deg)',
      boxShadow: '0 0 45px rgb(42 207 63 / 30%)',
    },

    [theme.breakpoints.down('lg')]: {
      minHeight: 205,
    },
    [theme.breakpoints.down('sm')]: {
      minHeight: 180,
    },
  }),
  heroImage: css({
    position: 'relative',
    width: 'min(100%, 550px)',
    maxHeight: 228,
    objectFit: 'contain',
    filter: 'drop-shadow(0 14px 18px rgb(0 0 0 / 45%))',

    [theme.breakpoints.down('lg')]: {
      maxHeight: 205,
    },
    [theme.breakpoints.down('sm')]: {
      width: '96%',
      maxHeight: 180,
    },
  }),
});
