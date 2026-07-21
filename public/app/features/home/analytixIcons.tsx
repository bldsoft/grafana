// Analytix: card and UI icons from the approved home-page design handoff
// (analytix-your-dashboards-graphics). All icons use `currentColor` so the
// surrounding component controls the colour via CSS.

const CARD_ICON_PROPS = {
  viewBox: '0 0 38 38',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/**
 * The nine approved dashboard card icons, keyed by topic.
 * `getDashboardIcon` resolves a dashboard title to one of these via ICON_RULES,
 * falling back to `default`.
 */
export const dashboardIcons = {
  search: (
    <svg {...CARD_ICON_PROPS} strokeWidth={2}>
      <circle cx="15" cy="15" r="9" />
      <path d="m22 22 8 8" />
    </svg>
  ),
  content: (
    <svg {...CARD_ICON_PROPS} strokeWidth={2}>
      <rect x="5" y="7" width="28" height="24" rx="2" />
      <path d="m16 14 9 5-9 5z" />
    </svg>
  ),
  quality: (
    <svg {...CARD_ICON_PROPS} strokeWidth={2}>
      <path d="M3 20h5l4-11 6 22 5-18 4 11h7" />
    </svg>
  ),
  organisations: (
    <svg {...CARD_ICON_PROPS} strokeWidth={1.8}>
      <rect x="7" y="5" width="14" height="28" />
      <rect x="21" y="12" width="11" height="21" />
      <path d="M11 10h3m3 0h1m-7 6h3m3 0h1m-7 6h3m3 0h1m7-4h3m-3 6h3M5 33h29" />
    </svg>
  ),
  providers: (
    <svg {...CARD_ICON_PROPS} strokeWidth={1.8}>
      <circle cx="19" cy="7" r="4" />
      <circle cx="8" cy="23" r="4" />
      <circle cx="30" cy="23" r="4" />
      <circle cx="19" cy="32" r="4" />
      <path d="m16 10-6 9m12-9 6 9M12 25l4 4m10-4-4 4" />
    </svg>
  ),
  users: (
    <svg {...CARD_ICON_PROPS} strokeWidth={2}>
      <circle cx="19" cy="12" r="7" />
      <path d="M7 33c1-8 5-12 12-12s11 4 12 12z" />
    </svg>
  ),
  devices: (
    <svg {...CARD_ICON_PROPS} strokeWidth={1.8}>
      <rect x="4" y="7" width="23" height="17" rx="1" />
      <path d="M10 29h11m-6-5v5" />
      <rect x="24" y="16" width="11" height="18" rx="2" />
    </svg>
  ),
  cdn: (
    <svg {...CARD_ICON_PROPS} strokeWidth={1.8}>
      <path d="M10 28H8a6 6 0 0 1 0-12 11 11 0 0 1 21-2 7 7 0 0 1 2 14h-3" />
      <path d="m11 25 4-7 4 13 4-8 3 5" />
    </svg>
  ),
  adoption: (
    <svg {...CARD_ICON_PROPS} strokeWidth={2}>
      <path d="M5 30 14 20l7 5L33 10" />
      <path d="M26 10h7v7" />
    </svg>
  ),
  // Analytix: fallback for dashboards outside the nine approved titles - the
  // trend-line icon reads as "a dashboard" without implying a specific domain.
  default: (
    <svg {...CARD_ICON_PROPS} strokeWidth={2}>
      <path d="M5 30 14 20l7 5L33 10" />
      <path d="M26 10h7v7" />
    </svg>
  ),
};

/**
 * Keyword rules for resolving a dashboard title to a card icon.
 *
 * Analytix: matching is by whole word, not by substring - "Research Info"
 * contains "search" but must not get the magnifier. Plurals are listed
 * explicitly rather than matched by prefix, so the behaviour stays predictable
 * (a prefix match would turn "Contention" into the content icon).
 *
 * Order matters: the first rule with a matching word wins. Domain-specific
 * terms come before generic entity terms, so "CDN Users" reads as a CDN
 * dashboard rather than a user one.
 */
const ICON_RULES: Array<{ words: string[]; icon: keyof typeof dashboardIcons }> = [
  { words: ['cdn'], icon: 'cdn' },
  { words: ['adoption'], icon: 'adoption' },
  { words: ['stream', 'streams', 'streaming', 'quality'], icon: 'quality' },
  { words: ['provider', 'providers'], icon: 'providers' },
  { words: ['organisation', 'organisations', 'organization', 'organizations', 'org', 'orgs'], icon: 'organisations' },
  { words: ['device', 'devices'], icon: 'devices' },
  { words: ['content', 'contents'], icon: 'content' },
  { words: ['search', 'searches'], icon: 'search' },
  { words: ['user', 'users'], icon: 'users' },
];

/** Splits a title into lowercase words, dropping punctuation and separators. */
function toWords(title: string): string[] {
  return title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Resolves a dashboard title to one of the approved card icons by looking for
 * a known keyword anywhere in the title. Unknown titles get the fallback icon.
 */
export function getDashboardIcon(title: string) {
  const words = new Set(toWords(title));
  const rule = ICON_RULES.find(({ words: keywords }) => keywords.some((keyword) => words.has(keyword)));
  return rule ? dashboardIcons[rule.icon] : dashboardIcons.default;
}

const UI_ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export const GridIcon = () => (
  <svg {...UI_ICON_PROPS}>
    <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
    <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
    <rect x="14.5" y="14.5" width="6" height="6" rx="1" />
  </svg>
);

export const SearchIcon = () => (
  <svg {...UI_ICON_PROPS}>
    <circle cx="10.8" cy="10.8" r="6.2" />
    <path d="m15.4 15.4 4.2 4.2" />
  </svg>
);

export const RecentIcon = () => (
  <svg {...UI_ICON_PROPS}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);

export const OpenArrowIcon = () => (
  <svg {...UI_ICON_PROPS}>
    <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
  </svg>
);

export const FavoriteIcon = ({ filled }: { filled: boolean }) =>
  filled ? (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden={true}>
      <path d="m12 2.8 2.8 5.6 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.3l6.2-.9z" />
    </svg>
  ) : (
    <svg {...UI_ICON_PROPS} strokeWidth={1.7}>
      <path d="m12 3.7 2.5 5.1 5.6.8-4.1 4 .9 5.6-4.9-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z" />
    </svg>
  );
