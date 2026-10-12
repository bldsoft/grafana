// Analytix: AI Insider Alerts — "Keep the customer" hand-off files. Saved
// locally, nothing is sent anywhere:
//   - the marketing CSV: treatment jobs only. The control group never goes
//     into it (contacting it would destroy the effect measurement), and
//     technical cases go to support, not marketing;
//   - the control JSON: who was held back, to compare outcomes with later;
//   - the support CSV: technical problems and deactivated subscriptions, all
//     of them (support is not a marketing contact), the control group marked;
//   - the leads CSV: upgrade leads for sales, without the control group.
// All carry subscriber identifiers; the page asks before saving them.

import { downloadBlob } from '../export';
import { csvCell } from '../format';

import { ruleDays } from './engine';
import { evidenceCodeList, evidenceCodes, isoDay, isoTime, localTime } from './text';
import type { AccountAssessment, KeepJob, KeepRules, KeepSnapshot } from './types';

/** 2: list values are joined with '|' (was ';'). */
export const KEEP_EXPORT_VERSION = 2;

export type KeepFileKind = 'jobs' | 'control' | 'support' | 'leads';

/** `ai-insider-keep-jobs_2026-10-09.csv` (same pattern as the alerts exports). */
export function keepFileName(kind: KeepFileKind, asOf: number, ext: string): string {
  return `ai-insider-keep-${kind}_${isoDay(asOf)}.${ext}`;
}

/** Jobs that may go to marketing: never the control group, never a support hand-off. */
export function marketingJobs(jobs: KeepJob[]): KeepJob[] {
  return jobs.filter((j) => !j.control && j.action !== 'support');
}

/** A cell starting with one of these is a formula to a spreadsheet (see csvCell). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell (csvCell), also quoted when it holds a ';': spreadsheets in
 * locales whose list separator is ';' split an unquoted cell there, and the
 * part after it would start a new cell (possibly a formula).
 */
function cell(value: unknown): string {
  // Spreadsheets that split on ';' treat a quote as a qualifier only at the
  // start of a field, so quoting cannot keep such a cell whole: the text after
  // each ';' is neutralized instead, like the start of the cell.
  const text = csvCell(String(value).replace(/;(?=["']*[=+\-@\t\r])/g, ";'"));
  // csvCell output starts with '"' exactly when it is quoted already.
  return text.includes(';') && !text.startsWith('"') ? `"${text}"` : text;
}

/**
 * A list in one cell: elements joined with '|' (neither the CSV comma nor the
 * ';' some spreadsheets split on), a '|' or '\' inside an element escaped with
 * '\', and every element guarded against formulas on its own, not only the
 * first one of the cell.
 */
export function listCell(values: string[]): string {
  return values
    .map((value) => {
      const escaped = value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
      return FORMULA_START.test(escaped) ? `'${escaped}` : escaped;
    })
    .join('|');
}

const csvLine = (values: unknown[]) => values.map(cell).join(',');

const round = (value: number, digits: number) => +value.toFixed(digits);

export interface JobsCsvOptions {
  /** Seed titles next to the ids; off = ids only. */
  includeTitles: boolean;
  /** The customer's UTC offset (hours) by job key, for the local send time. */
  tzOffsetOf?: (key: string) => number | null | undefined;
}

/**
 * The marketing hand-off as CSV (UTC ISO times). Control and support jobs are
 * dropped here, whatever is passed. Deferred jobs (beyond the daily capacity)
 * and jobs without a channel stay in, marked by the `deferred` and `delivery`
 * columns; a deferred job has no send time, so whoever schedules by it does
 * not send it today.
 */
export function jobsToCsv(jobs: KeepJob[], { includeTitles, tzOffsetOf }: JobsCsvOptions): string {
  const header = [
    'job_id',
    'provider_id',
    'account',
    'account_key',
    'profile_ids',
    'reason',
    'action',
    'offer_kind',
    'offer_step',
    'offer_tool',
    'delivery',
    'priority',
    'tier',
    'deferred',
    'send_at_utc',
    'send_local_time',
    'steps',
    'due_by_utc',
    'expiry_utc',
    'plan',
    'renewal_style',
    'rec_endpoint',
    'rec_fallback',
    'seed_content_ids',
    ...(includeTitles ? ['seed_titles'] : []),
    'evidence_codes',
    'tech_issue',
    'consent',
  ];
  const lines = marketingJobs(jobs).map((j) => {
    const sendAt = j.deferred ? null : j.sendAt;
    return csvLine([
      j.id,
      j.pid,
      j.account,
      j.accountKey,
      listCell(j.profileIds),
      j.reason,
      j.action,
      j.offerKind ?? '',
      j.offerStep ?? '',
      j.offerTool,
      j.delivery,
      j.priority,
      j.tier,
      j.deferred,
      isoTime(sendAt),
      localTime(sendAt, tzOffsetOf?.(j.key)) ?? '',
      // A deferred job has no send time: neither does any of its steps.
      listCell(j.steps.map((s) => (j.deferred ? `${s.channel} ${s.what}` : `${isoTime(s.at)} ${s.channel} ${s.what}`))),
      isoTime(j.dueBy),
      isoTime(j.expiry),
      j.plan,
      j.renewalStyle,
      j.recEndpoint,
      j.recFallback,
      listCell(j.seeds.map((s) => `${s.contentType}:${s.contentId}`)),
      ...(includeTitles ? [listCell(j.seeds.map((s) => s.title))] : []),
      listCell(evidenceCodeList(j.evidence)),
      j.techIssue,
      j.consent,
    ]);
  });
  return [header.join(','), ...lines].join('\n');
}

/** Keys (`pid|account`) of the accounts whose job is in the control group. */
export function controlKeysOf(jobs: KeepJob[]): Set<string> {
  return new Set(jobs.filter((j) => j.control).map((j) => j.key));
}

const planOf = (a: AccountAssessment) => a.latestPlan || a.baselinePlan;

export interface SupportCsvOptions {
  rules: Pick<KeepRules, 'recentDays'>;
  /** Accounts in the control group (marked, not dropped: support is not marketing). */
  controlKeys: Set<string>;
}

/** The support hand-off as CSV: why, the failure figures of the recent window, deactivation, platforms. */
export function supportToCsv(rows: AccountAssessment[], { rules, controlKeys }: SupportCsvOptions): string {
  const header = [
    'provider_id',
    'account',
    'account_key',
    'plan',
    'reason_codes',
    'top_err_code',
    'failed_playbacks',
    'playbacks',
    'failed_share',
    'buffering_per_hour',
    'watched_min_per_day',
    'deactivated',
    'deactivated_at_utc',
    'tech_issue',
    'control',
    'platforms',
  ];
  const recentDays = ruleDays(rules.recentDays);
  const lines = rows.map((a) => {
    const r = a.recent;
    const hours = r.watchAllMin / 60;
    return csvLine([
      a.pid,
      a.account,
      a.accountKey,
      planOf(a),
      listCell(evidenceCodeList(a.evidence)),
      a.topErrCode,
      r.failedPlaybacks,
      r.playbacks,
      r.playbacks > 0 ? round(Math.min(r.failedPlaybacks, r.playbacks) / r.playbacks, 3) : '',
      hours > 0 ? round(r.bufferingStops / hours, 2) : '',
      round(r.watchAllMin / recentDays, 1),
      a.deactivated,
      a.deactivated ? isoTime(a.deactivatedAt) : '',
      a.techIssue,
      controlKeys.has(a.key),
      listCell(a.platforms),
    ]);
  });
  return [header.join(','), ...lines].join('\n');
}

/** Leads that may go to sales: never the control group (a sales call is a contact too). */
export function salesLeads(rows: AccountAssessment[], controlKeys: Set<string>): AccountAssessment[] {
  return rows.filter((a) => !controlKeys.has(a.key));
}

export interface LeadsCsvOptions {
  rules: Pick<KeepRules, 'recentDays' | 'baselineDays'>;
  controlKeys: Set<string>;
  /** The title refused most often; off = no titles. */
  includeTitles: boolean;
}

/** The upsell leads as CSV. Control-group accounts are dropped here, whatever is passed. */
export function leadsToCsv(rows: AccountAssessment[], { rules, controlKeys, includeTitles }: LeadsCsvOptions): string {
  const header = [
    'provider_id',
    'account',
    'account_key',
    'plan',
    'expiry_utc',
    'refused_other_package',
    ...(includeTitles ? ['refused_title'] : []),
    'watched_min_per_day',
    'watched_min_per_day_before',
    'evidence_codes',
    'platforms',
  ];
  const recentDays = ruleDays(rules.recentDays);
  const baselineDays = ruleDays(rules.baselineDays);
  const lines = salesLeads(rows, controlKeys).map((a) =>
    csvLine([
      a.pid,
      a.account,
      a.accountKey,
      planOf(a),
      isoTime(a.expiry),
      a.recent.premiumAttempts - a.recent.premiumPaidContent,
      ...(includeTitles ? [a.evidence.find((e) => e.code === 'PREMIUM_ATTEMPTS')?.label ?? ''] : []),
      round(a.recent.watchAllMin / recentDays, 1),
      round(a.baseline.watchAllMin / baselineDays, 1),
      listCell(evidenceCodeList(a.evidence)),
      listCell(a.platforms),
    ])
  );
  return [header.join(','), ...lines].join('\n');
}

/** The control group of one scan as a JSON document (for the effect measurement). */
export function controlDocument(snapshot: KeepSnapshot, rules: Pick<KeepRules, 'holdoutShare' | 'holdoutSalt'>) {
  return {
    format: 'ai-insider-keep-control',
    version: KEEP_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    asOf: isoDay(snapshot.asOf),
    pids: snapshot.pids,
    holdoutShare: rules.holdoutShare,
    holdoutSalt: rules.holdoutSalt,
    jobs: snapshot.jobs
      .filter((j) => j.control)
      .map((j) => ({
        id: j.id,
        pid: j.pid,
        account: j.account,
        accountKey: j.accountKey,
        reason: j.reason,
        action: j.action,
        offerKind: j.offerKind ?? null,
        offerStep: j.offerStep ?? null,
        delivery: j.delivery,
        priority: j.priority,
        tier: j.tier,
        expiry: isoTime(j.expiry) || null,
        plan: j.plan,
        renewalStyle: j.renewalStyle,
        evidence: evidenceCodes(j.evidence),
      })),
  };
}

// A BOM so spreadsheet apps read titles and plan names as UTF-8.
const BOM = '﻿';

function saveCsv(kind: KeepFileKind, asOf: number, csv: string) {
  const blob = new Blob([BOM, csv], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, keepFileName(kind, asOf, 'csv'));
}

export function downloadJobsCsv(asOf: number, jobs: KeepJob[], options: JobsCsvOptions) {
  saveCsv('jobs', asOf, jobsToCsv(jobs, options));
}

export function downloadSupportCsv(asOf: number, rows: AccountAssessment[], options: SupportCsvOptions) {
  saveCsv('support', asOf, supportToCsv(rows, options));
}

export function downloadLeadsCsv(asOf: number, rows: AccountAssessment[], options: LeadsCsvOptions) {
  saveCsv('leads', asOf, leadsToCsv(rows, options));
}

export function downloadControlJson(snapshot: KeepSnapshot, rules: Pick<KeepRules, 'holdoutShare' | 'holdoutSalt'>) {
  const blob = new Blob([JSON.stringify(controlDocument(snapshot, rules), null, 1)], { type: 'application/json' });
  downloadBlob(blob, keepFileName('control', snapshot.asOf, 'json'));
}
