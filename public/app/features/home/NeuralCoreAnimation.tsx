import { css, cx, keyframes } from '@emotion/css';
import { CSSProperties } from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import coreIconSvg from 'img/analytix_min_icon.svg';

// Analytix: "Neural Core" welcome hero animation - devices around the edge
// stream data into the Analytix core. Ported from the approved standalone
// package (analytix-neural-core): pure SVG + CSS, no JS runtime for motion.
// Particle movement uses SMIL <animateMotion>; everything else is CSS
// keyframes. All ids are prefixed with "anc-" so they cannot collide with
// other inline SVGs on the page.

interface Props {
  className?: string;
}

// Dashed links that flow toward the core (background mesh).
const MESH_PATHS = [
  'M95 100 L140 75 L180 120 L210 150',
  'M110 40 L150 90 L190 110 L210 150',
  'M250 35 L270 85 L240 120 L210 150',
  'M320 45 L300 95 L260 115 L210 150',
  'M380 70 L340 110 L280 130 L210 150',
  'M390 140 L330 145 L270 148 L210 150',
  'M385 200 L330 180 L270 160 L210 150',
  'M355 250 L300 210 L250 175 L210 150',
  'M280 270 L250 220 L230 180 L210 150',
  'M210 280 L210 220 L210 180 L210 150',
  'M140 275 L165 220 L190 175 L210 150',
  'M70 255 L120 210 L165 175 L210 150',
  'M35 200 L95 175 L155 160 L210 150',
  'M30 145 L90 148 L150 150 L210 150',
  'M40 95 L100 120 L160 140 L210 150',
  'M95 100 L150 90 L190 110',
  'M270 85 L300 95 L340 110',
  'M330 180 L300 210 L250 220',
  'M120 210 L165 220 L210 220',
  'M100 120 L165 175 L230 180 L270 160',
];

// Brighter direct links from each device to the core.
const SYNAPSE_PATHS = [
  'M31 61 L210 150',
  'M151 25 L210 150',
  'M301 33 L210 150',
  'M397 92 L210 150',
  'M388 248 L210 150',
  'M219 286 L210 150',
  'M80 266 L210 150',
];

// Twinkling point cloud: [cx, cy, r].
const SCATTER: Array<[number, number, number]> = [
  [95, 100, 1.8],
  [140, 75, 2],
  [110, 40, 1.6],
  [150, 90, 2.4],
  [180, 120, 1.7],
  [250, 35, 2],
  [270, 85, 2.2],
  [240, 120, 1.5],
  [320, 45, 1.8],
  [300, 95, 2.3],
  [260, 115, 1.6],
  [380, 70, 2],
  [340, 110, 1.9],
  [280, 130, 1.5],
  [390, 140, 2.1],
  [330, 145, 1.7],
  [270, 148, 1.4],
  [385, 200, 2],
  [330, 180, 2.2],
  [270, 160, 1.6],
  [355, 250, 1.8],
  [300, 210, 2.4],
  [250, 175, 1.5],
  [280, 270, 2],
  [250, 220, 1.9],
  [230, 180, 1.4],
  [210, 280, 2.1],
  [210, 220, 1.7],
  [210, 180, 1.3],
  [140, 275, 2],
  [165, 220, 2.2],
  [190, 175, 1.5],
  [70, 255, 1.8],
  [120, 210, 2.3],
  [165, 175, 1.6],
  [35, 200, 2],
  [95, 175, 1.9],
  [155, 160, 1.4],
  [90, 148, 1.6],
  [150, 150, 1.3],
  [100, 120, 2],
  [160, 140, 1.5],
  [190, 110, 1.7],
  [230, 100, 1.4],
  [175, 200, 1.6],
  [245, 195, 1.5],
  [125, 130, 1.8],
  [295, 165, 1.4],
];

// Particles travelling along the links into the core.
const FIRINGS: Array<{ r: number; dur: string; begin?: string; path: string }> = [
  { r: 2.4, dur: '4.8s', path: 'M31 61 L210 150' },
  { r: 2.2, dur: '5.2s', begin: '0.6s', path: 'M151 25 L210 150' },
  { r: 2.4, dur: '4.6s', begin: '1.1s', path: 'M301 33 L210 150' },
  { r: 2.2, dur: '5s', begin: '1.7s', path: 'M397 92 L210 150' },
  { r: 2.3, dur: '4.9s', begin: '0.9s', path: 'M388 248 L210 150' },
  { r: 2.2, dur: '5.1s', begin: '1.4s', path: 'M219 286 L210 150' },
  { r: 2.3, dur: '4.7s', begin: '2s', path: 'M80 266 L210 150' },
  { r: 1.8, dur: '5.8s', begin: '0.4s', path: 'M95 100 L140 75 L180 120 L210 150' },
  { r: 1.7, dur: '6.2s', begin: '1.3s', path: 'M380 70 L340 110 L280 130 L210 150' },
  { r: 1.9, dur: '5.5s', begin: '2.1s', path: 'M355 250 L300 210 L250 175 L210 150' },
  { r: 1.6, dur: '6s', begin: '0.8s', path: 'M70 255 L120 210 L165 175 L210 150' },
  { r: 1.8, dur: '5.4s', begin: '1.6s', path: 'M390 140 L330 145 L270 148 L210 150' },
  { r: 1.7, dur: '5.9s', begin: '2.4s', path: 'M140 275 L165 220 L190 175 L210 150' },
  { r: 1.6, dur: '6.4s', begin: '1.9s', path: 'M320 45 L300 95 L260 115 L210 150' },
];

// Peripheral device nodes: icon symbol id (without prefix), label, position.
const DEVICES: Array<{ icon: string; label: string; x: number; y: number }> = [
  { icon: 'mobile', label: 'mobile', x: 18, y: 55 },
  { icon: 'web', label: 'web', x: 145, y: 12 },
  { icon: 'tablet', label: 'tablet', x: 310, y: 22 },
  { icon: 'tv', label: 'tv', x: 410, y: 88 },
  { icon: 'stb', label: 'stb', x: 70, y: 275 },
  { icon: 'cdn', label: 'cdn', x: 220, y: 300 },
  { icon: 'mw', label: 'mw', x: 400, y: 255 },
];

export function NeuralCoreAnimation({ className }: Props) {
  const styles = useStyles2(getStyles);

  return (
    <div className={cx(styles.neural, className)} aria-hidden="true">
      <div className={styles.halo} />
      {/* Analytix: the viewBox is taller than the drawn content (devices end at
          y=322 with the "cdn" label) so nothing clips at the bottom and the
          scene renders slightly smaller than an edge-to-edge fit. */}
      <svg className={styles.svg} viewBox="-24 -20 468 352" preserveAspectRatio="xMidYMid meet" focusable="false">
        <defs>
          <radialGradient id="anc-core-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#4ade80" stopOpacity="0.95" />
            <stop offset="45%" stopColor="#39d353" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#39d353" stopOpacity="0" />
          </radialGradient>
          <filter id="anc-glow">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <symbol id="anc-ico-mobile" viewBox="0 0 24 24">
            <rect x="7" y="2" width="10" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="12" cy="18.5" r="1" fill="currentColor" />
            <line x1="10" y1="4.5" x2="14" y2="4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </symbol>
          <symbol id="anc-ico-tablet" viewBox="0 0 24 24">
            <rect x="4" y="2" width="16" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="12" cy="18.5" r="1" fill="currentColor" />
          </symbol>
          <symbol id="anc-ico-tv" viewBox="0 0 24 24">
            <rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="M8 20h8M12 17v3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </symbol>
          <symbol id="anc-ico-stb" viewBox="0 0 24 24">
            <rect x="2" y="8" width="20" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="6.5" cy="12.5" r="1.2" fill="currentColor" />
            <line x1="10" y1="11.5" x2="18" y2="11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="10" y1="14.5" x2="15" y2="14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </symbol>
          <symbol id="anc-ico-web" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <line x1="3.5" y1="12" x2="20.5" y2="12" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 7.5h14M5 16.5h14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </symbol>
          <symbol id="anc-ico-cdn" viewBox="0 0 24 24">
            <path
              d="M7.5 17H18a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.5-1.2A3.5 3.5 0 0 0 7.5 17z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <circle cx="9" cy="12.5" r="1" fill="currentColor" />
            <circle cx="13" cy="11" r="1" fill="currentColor" />
            <circle cx="16.5" cy="13.5" r="1" fill="currentColor" />
            <path d="M9 12.5L13 11M13 11L16.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </symbol>
          <symbol id="anc-ico-mw" viewBox="0 0 24 24">
            <rect x="4" y="3" width="16" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <rect x="4" y="9.5" width="16" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <rect x="4" y="16" width="16" height="5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="7.2" cy="5.5" r="0.9" fill="currentColor" />
            <circle cx="7.2" cy="12" r="0.9" fill="currentColor" />
            <circle cx="7.2" cy="18.5" r="0.9" fill="currentColor" />
          </symbol>
        </defs>

        <g className={styles.mesh} filter="url(#anc-glow)">
          {MESH_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>

        <g className={styles.synapses}>
          {SYNAPSE_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>

        <g className={styles.scatter}>
          {SCATTER.map(([cx2, cy, r], i) => (
            <circle key={`${cx2}-${cy}`} cx={cx2} cy={cy} r={r} style={scatterVariant(i)} />
          ))}
        </g>

        <g className={styles.firings}>
          {FIRINGS.map((f) => (
            <circle key={f.path + f.dur} r={f.r} className={styles.fire}>
              <animateMotion dur={f.dur} begin={f.begin} repeatCount="indefinite" path={f.path} />
            </circle>
          ))}
        </g>

        <g>
          {DEVICES.map((d, i) => (
            <g key={d.icon} className={styles.device} transform={`translate(${d.x} ${d.y})`}>
              <use
                href={`#anc-ico-${d.icon}`}
                x="-13"
                y="-15"
                width="26"
                height="26"
                style={{ animationDelay: `${i * 0.3}s` }}
              />
              <text className={styles.deviceLabel} y="22" textAnchor="middle">
                {d.label}
              </text>
            </g>
          ))}
        </g>

        <circle className={styles.coreGlow} cx="210" cy="150" r="58" fill="url(#anc-core-grad)" />
        <circle className={styles.coreRing} cx="210" cy="150" r="32" />
        <circle className={cx(styles.coreRing, styles.coreRing2)} cx="210" cy="150" r="46" />
        <circle className={styles.core} cx="210" cy="150" r="26" />
        <image href={coreIconSvg} x="197" y="138" width="26" height="24" preserveAspectRatio="xMidYMid meet" />
      </svg>
    </div>
  );
}

// Twinkle variations from the original stylesheet (:nth-child(odd/3n/4n)),
// resolved per index so the cascade order is preserved: 4n beats 3n beats odd.
function scatterVariant(index: number): CSSProperties {
  const nth = index + 1;
  if (nth % 4 === 0) {
    return { animationDelay: '0.9s', fill: '#4ade80' };
  }
  if (nth % 3 === 0) {
    return { animationDelay: '0.55s', fill: 'rgba(154, 165, 158, 0.45)' };
  }
  if (nth % 2 === 1) {
    return { animationDelay: '0.25s' };
  }
  return {};
}

const linkFlow = keyframes({
  from: { strokeDashoffset: 0 },
  to: { strokeDashoffset: -40 },
});

const twinkle = keyframes({
  '0%, 100%': { opacity: 0.35 },
  '50%': { opacity: 1 },
});

const breathe = keyframes({
  '0%, 100%': { transform: 'scale(1)' },
  '50%': { transform: 'scale(1.12)' },
});

const spin = keyframes({
  to: { transform: 'rotate(360deg)' },
});

const haloBreathe = keyframes({
  '0%, 100%': { transform: 'scale(0.9)', opacity: 0.55 },
  '50%': { transform: 'scale(1.15)', opacity: 1 },
});

// Analytix: the scene fades out towards the edges instead of ending on a hard
// rectangle; the mask opens up on small screens so the outer devices survive.
const SCENE_MASK = 'radial-gradient(ellipse 78% 72% at 52% 48%, #000 42%, transparent 88%)';
const SCENE_MASK_MOBILE = 'radial-gradient(ellipse 82% 78% at 50% 48%, #000 38%, transparent 90%)';

const getStyles = (theme: GrafanaTheme2) => ({
  neural: css({
    position: 'relative',
    width: '100%',
    // Analytix: the scene carries its own aspect ratio instead of a fixed
    // height, so it scales with the column it is dropped into.
    aspectRatio: '468 / 352',
    minHeight: 'clamp(108px, 18.6vw, 196px)',
    // Analytix: past this width the aspect ratio alone would push the hero
    // beyond 300px tall on ultra-wide monitors.
    maxWidth: 402,
    marginInline: 'auto',
    display: 'grid',
    placeItems: 'center',
    // Analytix: both gradients must fade out fully INSIDE the scene (edge
    // distance / radius > transparent stop on every side) - a tint that still
    // has alpha at the container edge gets cut off and paints a visible seam
    // against the panel background.
    background:
      'radial-gradient(circle at 52% 48%, rgba(57, 211, 83, 0.22), transparent 38%),' +
      'radial-gradient(ellipse 55% 50% at 52% 48%, rgba(12, 20, 14, 0.35), transparent 85%)',
    maskImage: SCENE_MASK,
    WebkitMaskImage: SCENE_MASK,

    [theme.breakpoints.down('lg')]: {
      // Stacked layout: the column is already as wide as the panel, so the
      // aspect ratio alone decides the height.
      minHeight: 0,
      maxWidth: 314,
    },
    [theme.breakpoints.down('md')]: {
      aspectRatio: '450 / 352',
      maskImage: SCENE_MASK_MOBILE,
      WebkitMaskImage: SCENE_MASK_MOBILE,
    },
  }),
  halo: css({
    position: 'absolute',
    width: 'clamp(69px, 13.7vw, 137px)',
    aspectRatio: '1',
    borderRadius: theme.shape.radius.circle,
    background: 'radial-gradient(circle, rgba(74, 222, 128, 0.28), rgba(57, 211, 83, 0.08) 45%, transparent 72%)',
    filter: 'blur(14px)',
    pointerEvents: 'none',

    [theme.transitions.handleMotion('no-preference')]: {
      animation: `${haloBreathe} 4s ease-in-out infinite`,
    },

    [theme.breakpoints.down('md')]: {
      width: 'clamp(59px, 20.6vw, 98px)',
      filter: 'blur(10px)',
    },
  }),
  svg: css({
    position: 'relative',
    zIndex: 1,
    display: 'block',
    width: '100%',
    height: 'auto',
    aspectRatio: '468 / 352',
    // Analytix: device labels are drawn a couple of units past the viewBox on
    // the tightest ratios - let them paint rather than clip mid-glyph.
    overflow: 'visible',

    [theme.breakpoints.down('md')]: {
      aspectRatio: '450 / 352',
    },
  }),
  mesh: css({
    '& path': {
      fill: 'none',
      stroke: 'rgba(74, 222, 128, 0.18)',
      strokeWidth: 1.15,
      strokeLinecap: 'round',
      strokeDasharray: '2 6',

      [theme.transitions.handleMotion('no-preference')]: {
        animation: `${linkFlow} 6.5s linear infinite`,
      },
    },
    '& path:nth-of-type(odd)': {
      strokeOpacity: 0.55,

      [theme.transitions.handleMotion('no-preference')]: {
        animationDuration: '8s',
      },
    },
    '& path:nth-of-type(3n)': {
      stroke: 'rgba(74, 222, 128, 0.2)',

      [theme.transitions.handleMotion('no-preference')]: {
        animationDuration: '5.5s',
      },
    },
  }),
  synapses: css({
    '& path': {
      fill: 'none',
      stroke: 'rgba(74, 222, 128, 0.4)',
      strokeWidth: 1.35,
      strokeLinecap: 'round',
      strokeDasharray: '3 7',

      [theme.transitions.handleMotion('no-preference')]: {
        animation: `${linkFlow} 5.5s linear infinite`,
      },
    },
    '& path:nth-of-type(odd)': {
      [theme.transitions.handleMotion('no-preference')]: {
        animationDuration: '7s',
      },
    },
  }),
  scatter: css({
    '& circle': {
      fill: 'rgba(74, 222, 128, 0.55)',

      [theme.transitions.handleMotion('no-preference')]: {
        animation: `${twinkle} 2.8s ease-in-out infinite`,
      },
    },
  }),
  // SMIL <animateMotion> ignores CSS animation rules, so under reduced motion
  // the whole particle layer is hidden instead.
  firings: css({
    [theme.transitions.handleMotion('reduce')]: {
      display: 'none',
    },
  }),
  fire: css({
    fill: '#4ade80',
    filter: 'drop-shadow(0 0 5px rgba(74, 222, 128, 1))',
  }),
  device: css({
    color: '#4ade80',

    '& use': {
      filter: 'drop-shadow(0 0 10px rgba(57, 211, 83, 0.55))',
      transformBox: 'fill-box',
      transformOrigin: 'center',

      [theme.transitions.handleMotion('no-preference')]: {
        animation: `${breathe} 2.8s ease-in-out infinite`,
      },
    },
  }),
  deviceLabel: css({
    fill: '#9aa59e',
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: 9,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  }),
  coreGlow: css({
    opacity: 0.95,
    filter: 'blur(1px)',
  }),
  coreRing: css({
    fill: 'none',
    stroke: 'rgba(74, 222, 128, 0.35)',
    strokeWidth: 1.2,
    strokeDasharray: '6 8',
    transformOrigin: '210px 150px',

    [theme.transitions.handleMotion('no-preference')]: {
      animation: `${spin} 12s linear infinite`,
    },
  }),
  coreRing2: css({
    strokeOpacity: 0.25,

    [theme.transitions.handleMotion('no-preference')]: {
      animationDuration: '18s',
      animationDirection: 'reverse',
    },
  }),
  core: css({
    fill: '#0a0c0b',
    stroke: '#4ade80',
    strokeWidth: 2,
    transformOrigin: '210px 150px',

    [theme.transitions.handleMotion('no-preference')]: {
      animation: `${breathe} 2.2s ease-in-out infinite`,
    },
  }),
});
