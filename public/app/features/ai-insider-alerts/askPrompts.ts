// Analytix: the questions "Ask AI Insider" opens the chat with, one per kind of
// problem. The chat knows nothing about the alerts page, so each question says
// what was seen, where, and when (UTC, with the date), then what to look at.

import { t } from '@grafana/i18n';

import { activityPeak } from './activity';
import { topKey } from './engine';
import { breakdown, formatCount, toUtcInput } from './format';
import { PROVIDER_BUCKET_SEC } from './sql';
import type { ActivityIncident, Incident, ProviderIncident } from './types';

// Plain text for the composer: i18next would HTML-escape the values (`/` in a stream path, a code).
const RAW = { interpolation: { escapeValue: false } };

/** `2026-10-10 18:00`. */
function utc(sec: number): string {
  return toUtcInput(sec).replace('T', ' ');
}

/** `on 2026-10-10 18:00–18:45 UTC`, or `since … UTC (still ongoing)` without an end. */
export function utcWindow(start: number, end: number | undefined): string {
  if (end === undefined) {
    return t('ai-insider-alerts.ask.window-ongoing', 'since {{start}} UTC (still ongoing)', {
      start: utc(start),
      ...RAW,
    });
  }
  const from = utc(start);
  const to = utc(end);
  // Same day: the end needs only its time.
  return t('ai-insider-alerts.ask.window', 'on {{from}}–{{to}} UTC', {
    from,
    to: from.slice(0, 10) === to.slice(0, 10) ? to.slice(11) : to,
    ...RAW,
  });
}

function providerName(pid: string, provider: string): string {
  return provider ? `${pid} (${provider})` : pid;
}

function sentences(parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function channelPrompt(inc: Incident): string {
  // A channel that went quiet without clean viewing ended with its last failing minute.
  const end = inc.recovered === false ? inc.lastBad + 60 : inc.closedAt;
  const path = topKey(inc.paths) || topKey(inc.hosts);
  return sentences([
    t(
      'ai-insider-alerts.ask.channel',
      'Channel {{channel}} of provider {{provider}} failed {{window}}: up to {{errors}} of {{viewers}} viewers ({{share}}%) had playback errors in a minute.',
      {
        channel: inc.title ? `${inc.title} (id ${inc.cid})` : inc.cid,
        provider: providerName(inc.pid, inc.provider),
        window: utcWindow(inc.start, end),
        errors: inc.peakErrUsers,
        viewers: inc.peakUsers,
        share: Math.round(inc.peakErrShare * 100),
        ...RAW,
      }
    ),
    path && t('ai-insider-alerts.ask.channel-path', 'Stream: {{path}}.', { path, ...RAW }),
    t('ai-insider-alerts.ask.channel-where', 'Platforms: {{platforms}}. Error codes: {{codes}}.', {
      platforms: breakdown(inc.platforms, 3),
      codes: breakdown(inc.codes, 3),
      ...RAW,
    }),
    t(
      'ai-insider-alerts.ask.channel-question',
      'Show the errors on this channel minute by minute in this window, by error code, platform and CDN host, and compare with the same time the day before.'
    ),
  ]);
}

export function providerPrompt(inc: ProviderIncident): string {
  const end = inc.recovered === false ? inc.lastSurge + PROVIDER_BUCKET_SEC : inc.closedAt;
  return sentences([
    t(
      'ai-insider-alerts.ask.provider',
      'Provider {{provider}} had playback errors across its channels {{window}}: up to {{errors}} viewers with errors per 15 minutes, {{ratio}}× the usual {{usual}} at that time on previous days.',
      {
        provider: providerName(inc.pid, inc.provider),
        window: utcWindow(inc.start, end),
        errors: formatCount(inc.peakErrUsers),
        ratio: inc.peakRatio.toFixed(1),
        usual: formatCount(inc.peakBaselineErr),
        ...RAW,
      }
    ),
    t('ai-insider-alerts.ask.provider-where', 'Platforms: {{platforms}}. Error codes: {{codes}}.', {
      platforms: breakdown(inc.platforms, 3),
      codes: breakdown(inc.codes, 3),
      ...RAW,
    }),
    t(
      'ai-insider-alerts.ask.provider-question',
      'Break these errors down by error code, platform, channel and ISP, and compare with the same time on previous days.'
    ),
  ]);
}

export function activityPrompt(inc: ActivityIncident): string {
  const peak = activityPeak(inc);
  const window = utcWindow(inc.start, inc.closedAt);
  const pids = Object.entries(inc.pids)
    .sort((a, b) => b[1] - a[1])
    .map(([pid]) => pid)
    .join(', ');
  const count = Object.keys(inc.pids).length;
  switch (inc.kind) {
    case 'service_down':
      return t(
        'ai-insider-alerts.ask.service',
        'Service down for provider {{provider}} {{window}}: app starts up to {{sessions}}× the usual and playback starts down to {{plays}}% of the usual, viewers kept reopening the app without watching. Show app starts, playback starts and errors per 5 minutes for this provider around this window, compared with the same time on previous days.',
        {
          provider: providerName(inc.pid, inc.provider),
          window,
          sessions: peak.sessions.toFixed(1),
          plays: Math.round(peak.plays * 100),
          ...RAW,
        }
      );
    case 'outage':
      return t(
        'ai-insider-alerts.ask.outage',
        'An outage across {{count}} providers ({{pids}}) {{window}}: playback starts down to {{plays}}% of the usual, errors up to {{errors}}× the usual. Show playback starts and errors per provider per 5 minutes in this window, compared with the same time on previous days.',
        { count, pids, window, plays: Math.round(peak.plays * 100), errors: peak.errors.toFixed(1), ...RAW }
      );
    default:
      return t(
        'ai-insider-alerts.ask.no-data',
        'No analytics events from {{count}} providers ({{pids}}) {{window}}. Show the number of events per provider per 5 minutes around this window, compared with the same time on previous days.',
        { count, pids, window, ...RAW }
      );
  }
}
