// Analytix: AI Insider Alerts — "Keep the customer". Words of the section:
// the engine speaks in short evidence codes and enum values, the page and the
// hand-off speak in sentences. Only numbers, plan names and catalogue titles
// go into a sentence, never text typed by a customer.

import { t } from '@grafana/i18n';

import type {
  Delivery,
  Evidence,
  KeepAction,
  KeepJob,
  KeepReason,
  OfferKind,
  OfferTool,
  PlanClass,
  PriorityTier,
  RenewalStyle,
} from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-10-09`: a UTC day (epoch seconds of any moment of it). */
export function isoDay(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Start of the UTC day of a `YYYY-MM-DD` value; NaN when invalid. */
export function parseIsoDay(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) {
    return NaN;
  }
  const sec = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
  // Date.UTC rolls 2026-02-31 over to March; such a value is not a day.
  return isoDay(sec) === value.trim() ? sec : NaN;
}

/** `2026-10-12T17:00:00Z`. */
export function isoTime(sec: number | null | undefined): string {
  return sec === null || sec === undefined || !Number.isFinite(sec)
    ? ''
    : new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

/** `18:00` at the customer's UTC offset, null when the offset is unknown. */
export function localTime(sec: number | null, tzOffsetH: number | null | undefined): string | null {
  if (sec === null || tzOffsetH === null || tzOffsetH === undefined || !Number.isFinite(tzOffsetH)) {
    return null;
  }
  const d = new Date((sec + Math.round(tzOffsetH * 3600)) * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `UTC+1`, `UTC-3:30`. */
export function utcOffsetLabel(tzOffsetH: number): string {
  const sign = tzOffsetH < 0 ? '-' : '+';
  const abs = Math.abs(tzOffsetH);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ''}`;
}

/**
 * Values are inserted as is: React escapes the text it renders, and i18next's
 * own escaping would show a `/` in an error code or an `&` in a title as an
 * HTML entity.
 */
export const RAW = { interpolation: { escapeValue: false } };

/** What a sentence needs beyond the evidence itself (from the account's assessment). */
export interface EvidenceContext {
  /** Watched minutes per day in the recent window (the raw "now" of FADING). */
  recentWatchPerDay?: number;
}

const pct = (share: number | undefined) => (share === undefined ? '—' : `${Math.round(share * 100)}%`);
const num = (value: number | undefined, digits = 0) =>
  value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits).replace(/\.0+$/, '');

/**
 * One evidence code as a sentence. What `value` / `ref` / `label` carry per
 * code (see the engine): QUIET days since last seen; FADING / FADING_PLAYS the
 * ratio to the baseline (FADING after the provider-wide trend: 1 = as usual
 * for the provider), ref the baseline per day; EXPIRING days
 * left; LAPSED / LAPSED_SILENT days since the end; DOWNGRADE label = the new
 * plan; *_ATTEMPTS refused playbacks (label = a title); DEACTIVATED the
 * moment (epoch); DIVERSITY_DROP distinct titles per day vs ref; FAILED_SEARCH
 * sessions; TOP_TITLE_GONE the baseline share (label = the title);
 * FAVORITES_REMOVED removed vs ref added; TECH_ERRORS the failed share (label
 * = top code); TECH_BUFFERING stops per hour vs ref; GA4_* counts (ref = days).
 */
export function evidenceText(e: Evidence, context: EvidenceContext = {}): string {
  const v = e.value;
  switch (e.code) {
    case 'QUIET':
      return t('ai-insider-alerts.keep.ev-quiet', 'No activity for {{days}} d', { days: num(v) });
    case 'FADING': {
      // The share is relative to the provider-wide trend, so it differs from
      // the raw minutes now / before; both are shown next to it.
      const now = context.recentWatchPerDay;
      if (e.ref !== undefined && now !== undefined && Number.isFinite(now)) {
        return t(
          'ai-insider-alerts.keep.ev-fading-now',
          'Watching {{share}} of usual, relative to the provider trend (now {{now}}, was {{ref}} min/day)',
          { share: pct(v), now: num(now), ref: num(e.ref) }
        );
      }
      return e.ref !== undefined
        ? t(
            'ai-insider-alerts.keep.ev-fading-ref',
            'Watching {{share}} of usual, relative to the provider trend (was {{ref}} min/day)',
            { share: pct(v), ref: num(e.ref) }
          )
        : t('ai-insider-alerts.keep.ev-fading', 'Watching {{share}} of usual, relative to the provider trend', {
            share: pct(v),
          });
    }
    case 'FADING_PLAYS':
      return t('ai-insider-alerts.keep.ev-fading-plays', 'Plays or active days down to {{share}} of usual', {
        share: pct(v),
      });
    case 'EXPIRING':
      return t('ai-insider-alerts.keep.ev-expiring', 'Subscription ends in {{days}} d', { days: num(v, 1) });
    case 'LAPSED':
      return t('ai-insider-alerts.keep.ev-lapsed', 'Subscription ended {{days}} d ago, still using the app', {
        days: num(v, 1),
      });
    case 'LAPSED_SILENT':
      return t('ai-insider-alerts.keep.ev-lapsed-silent', 'Subscription ended {{days}} d ago, no renewal seen since', {
        days: num(v, 1),
      });
    case 'DOWNGRADE':
      return e.label
        ? t('ai-insider-alerts.keep.ev-downgrade-plan', 'Moved from a paid plan to {{plan}}', { plan: e.label, ...RAW })
        : t('ai-insider-alerts.keep.ev-downgrade', 'Moved from a paid plan to a free one');
    case 'INACTIVE_ATTEMPTS':
      return t('ai-insider-alerts.keep.ev-inactive', '{{n}} playbacks refused: subscription not active', {
        n: num(v),
      });
    case 'PREMIUM_ATTEMPTS':
      return e.label
        ? t('ai-insider-alerts.keep.ev-premium-title', '{{n}} playbacks refused: needs another package ({{title}})', {
            n: num(v),
            title: e.label,
            ...RAW,
          })
        : t('ai-insider-alerts.keep.ev-premium', '{{n}} playbacks refused: needs another package', {
            n: num(v),
          });
    case 'DEACTIVATED':
      return v !== undefined && v > 1e9
        ? t(
            'ai-insider-alerts.keep.ev-deactivated-at',
            'Subscription end moved back on {{day}} (void, refund or admin)',
            {
              day: isoDay(v),
            }
          )
        : t('ai-insider-alerts.keep.ev-deactivated', 'Subscription end moved back (void, refund or admin)');
    case 'RENEWAL_REPURCHASE':
      return t('ai-insider-alerts.keep.ev-repurchase', 'Last renewal was a new purchase after the end');
    case 'DIVERSITY_DROP':
      return t('ai-insider-alerts.keep.ev-diversity', 'Distinct titles per day {{value}} (was {{ref}})', {
        value: num(v, 1),
        ref: num(e.ref, 1),
      });
    case 'FAILED_SEARCH':
      return t('ai-insider-alerts.keep.ev-failed-search', '{{n}} searches opened nothing', { n: num(v) });
    case 'TOP_TITLE_GONE':
      return e.label
        ? t('ai-insider-alerts.keep.ev-top-title-named', 'Stopped watching {{title}} ({{share}} of the time before)', {
            title: e.label,
            share: pct(v),
            ...RAW,
          })
        : t('ai-insider-alerts.keep.ev-top-title', 'Stopped watching the favourite ({{share}} of the time before)', {
            share: pct(v),
          });
    case 'FAVORITES_REMOVED':
      return t('ai-insider-alerts.keep.ev-favorites', 'Removed {{removed}} favourites, added {{added}}', {
        removed: num(v),
        added: num(e.ref),
      });
    case 'TECH_ERRORS':
      return e.label
        ? t('ai-insider-alerts.keep.ev-tech-errors-code', '{{share}} of playbacks failed (code {{code}})', {
            share: pct(v),
            code: e.label,
            ...RAW,
          })
        : t('ai-insider-alerts.keep.ev-tech-errors', '{{share}} of playbacks failed', { share: pct(v) });
    case 'TECH_BUFFERING':
      return t('ai-insider-alerts.keep.ev-tech-buffering', '{{value}} buffering stops per hour watched (was {{ref}})', {
        value: num(v, 1),
        ref: num(e.ref, 1),
      });
    case 'GA4_SEARCH_NO_PLAY':
      return t('ai-insider-alerts.keep.ev-ga4-search', '{{n}} app sessions searched without playing (GA4)', {
        n: num(v),
      });
    case 'GA4_BROWSE_NO_PLAY':
      return t('ai-insider-alerts.keep.ev-ga4-browse', '{{n}} app sessions browsed without playing (GA4)', {
        n: num(v),
      });
    case 'GA4_CRASHES':
      return t('ai-insider-alerts.keep.ev-ga4-crashes', '{{n}} app crashes on {{days}} d (GA4)', {
        n: num(v),
        days: num(e.ref),
      });
    case 'GA4_ERROR_SCREENS':
      return t('ai-insider-alerts.keep.ev-ga4-error-screens', '{{n}} app sessions with an error screen (GA4)', {
        n: num(v),
      });
    case 'GA4_ACCOUNT_VISITS':
      return t('ai-insider-alerts.keep.ev-ga4-account', 'Opened the account page {{n}} times (GA4)', {
        n: num(v),
      });
    case 'GA4_LOGOUT':
      return t('ai-insider-alerts.keep.ev-ga4-logout', 'Tapped "log out" {{n}} times (GA4)', { n: num(v) });
    default:
      return e.code;
  }
}

/** The evidence of a decision as one readable line (strongest first, as the engine orders it). */
export function evidenceSentence(evidence: Evidence[], max = 3, context?: EvidenceContext): string {
  const parts = evidence.slice(0, max).map((e) => evidenceText(e, context));
  if (evidence.length > max) {
    parts.push(t('ai-insider-alerts.keep.ev-more', '+{{more}} more', { more: evidence.length - max }));
  }
  return parts.join(' · ');
}

/** `['QUIET=6', 'FADING=0.22']` — machine-readable evidence for the hand-off (no labels: they may be titles). */
export function evidenceCodeList(evidence: Evidence[]): string[] {
  return evidence.map((e) =>
    e.value === undefined || !Number.isFinite(e.value) ? e.code : `${e.code}=${+e.value.toFixed(2)}`
  );
}

/** `QUIET=6|FADING=0.22`: the same as one value, in the list format of the CSV files. */
export function evidenceCodes(evidence: Evidence[]): string {
  return evidenceCodeList(evidence).join('|');
}

export function actionText(action: KeepAction): string {
  switch (action) {
    case 'content_push':
      return t('ai-insider-alerts.keep.action-content-push', 'Content push');
    case 're_engagement':
      return t('ai-insider-alerts.keep.action-re-engagement', 'Re-engagement');
    case 'retention_offer':
      return t('ai-insider-alerts.keep.action-retention-offer', 'Retention offer');
    case 'renewal_campaign':
      return t('ai-insider-alerts.keep.action-renewal-campaign', 'Renewal campaign');
    default:
      return t('ai-insider-alerts.keep.action-support', 'Support');
  }
}

export function reasonText(reason: KeepReason): string {
  switch (reason) {
    case 'content':
      return t('ai-insider-alerts.keep.reason-content', 'Content');
    case 'price':
      return t('ai-insider-alerts.keep.reason-price', 'Price');
    case 'timing':
      return t('ai-insider-alerts.keep.reason-timing', 'Timing');
    case 'disengaged':
      return t('ai-insider-alerts.keep.reason-disengaged', 'Disengaged');
    default:
      return t('ai-insider-alerts.keep.reason-technical', 'Technical');
  }
}

export function offerText(kind: OfferKind | undefined, tool: OfferTool, step?: 1 | 2): string {
  const what =
    kind === 'win_back'
      ? t('ai-insider-alerts.keep.offer-win-back', 'Win-back')
      : kind === 'win_back_free'
        ? t('ai-insider-alerts.keep.offer-win-back-free', 'Win-back from free')
        : kind === 'upgrade'
          ? t('ai-insider-alerts.keep.offer-upgrade', 'Upgrade')
          : '';
  const how =
    tool === 'payment_link'
      ? t('ai-insider-alerts.keep.tool-payment-link', 'payment link')
      : tool === 'discount_or_bonus'
        ? t('ai-insider-alerts.keep.tool-discount', 'discount or bonus')
        : tool === 'plan_change'
          ? t('ai-insider-alerts.keep.tool-plan-change', 'plan change')
          : '';
  const stepText = step ? t('ai-insider-alerts.keep.offer-step', 'step {{step}}', { step }) : '';
  return [what, stepText, how].filter(Boolean).join(' · ');
}

export function deliveryText(delivery: Delivery): string {
  switch (delivery) {
    case 'push':
      return t('ai-insider-alerts.keep.delivery-push', 'Push');
    case 'crm':
      return t('ai-insider-alerts.keep.delivery-crm', 'CRM');
    case 'none':
      return t('ai-insider-alerts.keep.delivery-none', 'No channel');
    default:
      return t('ai-insider-alerts.keep.delivery-unset', 'Not set');
  }
}

export function styleText(style: RenewalStyle): string {
  switch (style) {
    case 'at_term':
      return t('ai-insider-alerts.keep.style-at-term', 'At term');
    case 'early':
      return t('ai-insider-alerts.keep.style-early', 'Early');
    case 'repurchase':
      return t('ai-insider-alerts.keep.style-repurchase', 'Re-purchase');
    default:
      return t('ai-insider-alerts.keep.style-unknown', 'Unknown');
  }
}

export function tierText(tier: PriorityTier): string {
  switch (tier) {
    case 'high':
      return t('ai-insider-alerts.keep.tier-high', 'High');
    case 'medium':
      return t('ai-insider-alerts.keep.tier-medium', 'Medium');
    default:
      return t('ai-insider-alerts.keep.tier-low', 'Low');
  }
}

export function planClassText(cls: PlanClass): string {
  switch (cls) {
    case 'paid':
      return t('ai-insider-alerts.keep.plan-paid', 'Paid');
    case 'free':
      return t('ai-insider-alerts.keep.plan-free', 'Free / trial');
    default:
      return t('ai-insider-alerts.keep.plan-unknown', 'Unknown');
  }
}

/** Action plus offer, e.g. `Retention offer · Win-back · step 1 · payment link`. */
export function jobActionText(job: KeepJob): string {
  const offer = offerText(job.offerKind, job.offerTool, job.offerStep);
  return offer ? `${actionText(job.action)} · ${offer}` : actionText(job.action);
}
