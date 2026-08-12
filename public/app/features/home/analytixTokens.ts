// Analytix: design tokens from the home-page handoff (styles/tokens.css).
//
// These are intentionally literal values rather than GrafanaTheme2 lookups.
// The Analytix build is dark-only (see app/core/services/theme.ts), and the
// approved design specifies exact surfaces, greens and glow effects that have
// no equivalent in the Grafana palette. Text, borders and spacing still go
// through the theme wherever an equivalent exists.

export const analytix = {
  surface: '#0d1011',
  surfaceRaised: '#111415',
  control: '#151819',
  controlSunken: '#0b0d0e',
  border: '#35393a',
  borderHover: '#575c5e',
  borderControl: '#363a3b',
  text: '#f4f5f5',
  textMuted: '#a7abad',
  textDim: '#aeb2b3',
  textFaint: '#9ba0a2',
  green: '#35b944',
  greenBright: '#45d157',
  greenDark: '#215d2a',
  favorite: '#ffad00',
  focusRing: '0 0 0 3px rgb(53 185 68 / 25%)',
  radiusControl: '7px',
  radiusCard: '8px',
  radiusPanel: '10px',
  transitionFast: '160ms ease',
} as const;

// Analytix: the home page marks its content column as the `analytix-home`
// container (see AnalytixHomePage `main`). Layout rules built with this helper
// react to the actual column width — e.g. when the docked AI chat takes half
// the screen — not just the viewport, mirroring theme.breakpoints.down().
export const homeContainer = (maxWidth: number) => `@container analytix-home (max-width: ${maxWidth - 0.02}px)`;
