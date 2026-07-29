import { css, keyframes } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';

import { NeuralCoreAnimation } from './NeuralCoreAnimation';
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
        {/* Analytix: animated "Neural Core" scene replaces the static hero
            illustration; decorative only, hence no accessible alternative. */}
        <NeuralCoreAnimation className={styles.heroAnimation} />
      </div>
    </section>
  );
}

// Analytix: glow "breathing" from the analytix-welcome hero package
const glowBreathe = keyframes({
  '0%, 100%': { opacity: 0.85, transform: 'scale(1)' },
  '50%': { opacity: 1, transform: 'scale(1.03)' },
});

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
    // Analytix: grey panel surface (same as the catalog panel below) with the
    // hero effects from the analytix-welcome package on top - green glow only
    // under/right of the animation (the glow layer starts 30% in from the
    // left edge) and faint grid lines.
    background: theme.colors.background.secondary,

    '&::before': {
      content: '""',
      position: 'absolute',
      inset: '-20% -10% -30% 30%',
      pointerEvents: 'none',
      background:
        'radial-gradient(ellipse 45% 55% at 65% 45%, rgba(57, 211, 83, 0.18), transparent 70%),' +
        'radial-gradient(ellipse 30% 40% at 80% 60%, rgba(74, 222, 128, 0.1), transparent 70%)',

      [theme.transitions.handleMotion('no-preference')]: {
        animation: `${glowBreathe} 6s ease-in-out infinite`,
      },
    },

    '&::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      opacity: 0.5,
      backgroundImage:
        'linear-gradient(rgba(74, 222, 128, 0.04) 1px, transparent 1px),' +
        'linear-gradient(90deg, rgba(74, 222, 128, 0.04) 1px, transparent 1px)',
      backgroundSize: '40px 40px',
      maskImage: 'radial-gradient(ellipse 70% 80% at 70% 50%, #000 20%, transparent 75%)',
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
    // Analytix: keep the text above the absolutely positioned glow/grid layers
    position: 'relative',
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

    [theme.breakpoints.down('lg')]: {
      minHeight: 205,
    },
    [theme.breakpoints.down('sm')]: {
      minHeight: 180,
    },
  }),
  heroAnimation: css({
    // Analytix: the neural scene fills the column; the panel keeps its own
    // green ::after glow, the animation brings its halo on top of it
    height: '100%',
  }),
});
