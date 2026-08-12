import { css, keyframes } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { Trans } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';

import { NeuralCoreAnimation } from './NeuralCoreAnimation';
import { GridIcon } from './analytixIcons';
import { analytix, homeContainer } from './analytixTokens';

interface Props {
  /** Called when the primary CTA is activated. */
  onBrowse: () => void;
}

// Analytix: "Welcome to Analytix" block from the approved home-page design
// (analytix-welcome handoff package). Two columns with the animation as the
// dominant one, everything sized in clamp()/fr so the scene scales with the
// viewport; below lg it stacks with the copy before the illustration.
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
        <NeuralCoreAnimation />
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
    // Analytix: the animation is the dominant half of the block, so the copy
    // sits in the narrower column and the scene gets room to scale.
    display: 'grid',
    gridTemplateColumns: 'minmax(200px, .75fr) minmax(0, 1.4fr)',
    gap: 'clamp(6px, 1vw, 14px)',
    alignItems: 'center',
    minHeight: 'clamp(137px, 20.6vw, 206px)',
    // Analytix: the copy keeps a generous prod-like inset from the left edge;
    // the right side stays tight so the scene can bleed towards the border.
    padding: 'clamp(10px, 1.5vw, 18px) clamp(8px, 1.5vw, 20px) clamp(10px, 1.5vw, 18px) clamp(32px, 4.5vw, 80px)',
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

    [homeContainer(1100)]: {
      gridTemplateColumns: 'minmax(180px, .85fr) minmax(0, 1.2fr)',
    },
    [homeContainer(theme.breakpoints.values.lg)]: {
      gridTemplateColumns: '1fr',
      // Stacked: the copy and the scene each bring their own height.
      minHeight: 0,
      gap: 4,
      padding: '12px 10px 6px',
    },
    [homeContainer(theme.breakpoints.values.md)]: {
      padding: '10px 8px 4px',
    },
  }),
  copy: css({
    // Analytix: keep the text above the absolutely positioned glow/grid layers
    position: 'relative',
    zIndex: 1,
    alignSelf: 'center',

    [homeContainer(theme.breakpoints.values.lg)]: {
      maxWidth: 480,
    },
  }),
  title: css({
    margin: '0 0 10px',
    color: analytix.text,
    fontSize: 'clamp(28px, 3.2vw, 40px)',
    lineHeight: 1.15,
    letterSpacing: '-.02em',

    [theme.breakpoints.down('md')]: {
      fontSize: 'clamp(24px, 7vw, 32px)',
    },
  }),
  subtitle: css({
    margin: '0 0 clamp(16px, 2vw, 22px)',
    // Analytix: wide enough for "Everything you need to understand your data"
    // to stay on a single line at the largest font size.
    maxWidth: 480,
    color: '#c3c6c7',
    fontSize: 'clamp(14px, 1.5vw, 16px)',
    lineHeight: 1.5,

    [theme.breakpoints.down('md')]: {
      maxWidth: 'none',
    },
  }),
  cta: css({
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

    [theme.breakpoints.down('md')]: {
      width: '100%',
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
    zIndex: 1,
    width: '100%',
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // Analytix: the scene bleeds slightly past the panel padding so its faded
    // edges reach the panel border instead of ending in a gap.
    margin: '-6px -8px -6px -4px',
    // Analytix: nudge the scene towards the right half of the panel
    transform: 'translateX(70px)',

    [homeContainer(theme.breakpoints.values.lg)]: {
      margin: '0 -4px -2px',
      // Stacked layout: the scene is centered under the copy again.
      transform: 'none',
    },
    [homeContainer(theme.breakpoints.values.md)]: {
      margin: '2px -2px 0',
    },
  }),
});
