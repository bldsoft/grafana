// Test pushes from the Messages tab: the account → FCM token list a tester
// pastes, the default text per message type, and the plan of who gets what.
// No Grafana dependencies, so it is unit-tested directly.
import type { Decision, DecisionKind } from '../types';

/** Browser storage key of the pasted token list (raw text, per tester). */
export const PUSH_TOKENS_KEY = 'analytix.aiAlerts.pushTokens.v1';

// FCM registration tokens: base64url-ish with a ':' separator (the service checks the same).
const TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;

export type PushTemplateId =
  | 'channel_down'
  | 'service_down'
  | 'unstable'
  | 'channel_back'
  | 'service_back'
  | 'apology'
  | 'diagnosis';

export interface PushTemplate {
  title: string;
  text: string;
  /** true = show the service-status warning with the text; false = clear it. */
  enabled: boolean;
}

/**
 * Default texts. {channel} and {provider} are filled per viewer. "Back" and
 * the apology clear the warning in the iOS/tvOS apps (phones still show the
 * notification text when the app is in the background).
 */
export const DEFAULT_TEMPLATES: Record<PushTemplateId, PushTemplate> = {
  channel_down: {
    title: '{channel} is unavailable',
    text: "{channel} isn't playing right now. We're already fixing it and will let you know when it's back.",
    enabled: true,
  },
  service_down: {
    title: 'Service problems',
    text: "Some channels may not play right now. We're already fixing it.",
    enabled: true,
  },
  unstable: {
    title: '{channel} keeps interrupting',
    text: "{channel} is unstable right now. We're working on it.",
    enabled: true,
  },
  channel_back: {
    title: '{channel} is back',
    text: '{channel} is working again. Thanks for your patience.',
    enabled: false,
  },
  service_back: {
    title: 'Everything works again',
    text: 'The service is back to normal. Thanks for your patience.',
    enabled: false,
  },
  apology: {
    title: 'Sorry about {channel}',
    text: 'Sorry for the interruption on {channel}. It is working again.',
    enabled: false,
  },
  diagnosis: {
    title: 'Playback problems on your side',
    text: 'Channels play fine for other viewers, so the problem is likely your connection. Try restarting your router or device.',
    enabled: true,
  },
};

/** Every template, in the order the dialog lists them. */
export const TEMPLATE_IDS: PushTemplateId[] = [
  'channel_down',
  'service_down',
  'unstable',
  'channel_back',
  'service_back',
  'apology',
  'diagnosis',
];

const isServiceWide = (d: Decision) => Boolean(d.incidentId?.startsWith('prov-')) || (!d.cid && d.kind !== 'diagnosis');

/** The text a decision gets; "in player" and "held back" get the "down" text, as if told anyway. */
export function templateFor(d: Decision): PushTemplateId {
  const kind: DecisionKind = d.kind;
  switch (kind) {
    case 'unstable':
      return 'unstable';
    case 'back':
      return isServiceWide(d) ? 'service_back' : 'channel_back';
    case 'apology':
      return 'apology';
    case 'diagnosis':
      return 'diagnosis';
    case 'service':
      return 'service_down';
    default:
      return isServiceWide(d) ? 'service_down' : 'channel_down';
  }
}

/** Account key as matched against the token list: trimmed, upper case. */
export function accountKey(account: string): string {
  return account.trim().toUpperCase();
}

export interface ParsedTokens {
  /** Account key → tokens (an account may have an iPhone and an Apple TV). */
  byAccount: Map<string, string[]>;
  tokens: number;
  /** Non-empty lines that had no valid token. */
  skipped: number;
}

/**
 * Parse the pasted list: one account per line, then its token(s), separated
 * by spaces, tabs, commas or semicolons (a CSV export works). Lines starting
 * with # and lines without a valid token (e.g. a header) are skipped.
 */
export function parseTokens(text: string): ParsedTokens {
  const byAccount = new Map<string, string[]>();
  let tokens = 0;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const [account, ...rest] = trimmed.split(/[\s,;]+/).map((s) => s.replace(/^["']|["']$/g, ''));
    const valid = rest.filter((s) => TOKEN_RE.test(s));
    if (!account || !valid.length) {
      skipped++;
      continue;
    }
    const key = accountKey(account);
    const list = byAccount.get(key) ?? [];
    for (const token of valid) {
      if (!list.includes(token)) {
        list.push(token);
        tokens++;
      }
    }
    byAccount.set(key, list);
  }
  return { byAccount, tokens, skipped };
}

export interface PushRecipient {
  decision: Decision;
  tokens: string[];
}

export interface PushPlan {
  /** Template → recipients with tokens, in the order of TEMPLATE_IDS. */
  groups: Array<{ template: PushTemplateId; recipients: PushRecipient[] }>;
  /** Distinct accounts in the selection. */
  accounts: number;
  /** Accounts without a token in the list. */
  withoutToken: number;
}

/**
 * Who gets what: one push per account (its latest decision in the selection),
 * to every token of that account.
 */
export function planPush(decisions: Decision[], tokens: Map<string, string[]>): PushPlan {
  const latest = new Map<string, Decision>();
  for (const d of decisions) {
    const key = accountKey(d.userId);
    const seen = latest.get(key);
    if (!seen || d.at > seen.at) {
      latest.set(key, d);
    }
  }
  const byTemplate = new Map<PushTemplateId, PushRecipient[]>();
  let withoutToken = 0;
  for (const [key, decision] of latest) {
    const list = tokens.get(key);
    if (!list?.length) {
      withoutToken++;
      continue;
    }
    const template = templateFor(decision);
    byTemplate.set(template, [...(byTemplate.get(template) ?? []), { decision, tokens: list }]);
  }
  return {
    groups: TEMPLATE_IDS.filter((t) => byTemplate.has(t)).map((template) => ({
      template,
      recipients: byTemplate.get(template)!,
    })),
    accounts: latest.size,
    withoutToken,
  };
}

/** Fill {channel} and {provider} for one viewer. */
export function renderText(text: string, d: Decision): string {
  const channel = d.cid ? d.title || d.cid : 'All channels';
  const provider = d.provider || d.pid;
  return text
    .replace(/\{channel\}/g, channel)
    .replace(/\{provider\}/g, provider)
    .trim();
}

/** What an FCM error code means for the tester. */
export function explainPushError(code: string | undefined): string {
  switch (code) {
    case 'UNREGISTERED':
      return 'token expired or the app was removed';
    case 'SENDER_ID_MISMATCH':
      return 'token belongs to another Firebase project';
    case 'INVALID_ARGUMENT':
      return 'invalid token';
    case 'THIRD_PARTY_AUTH_ERROR':
      return 'APNs key is not set up in the Firebase project';
    case 'QUOTA_EXCEEDED':
      return 'FCM quota exceeded, try later';
    case 'PERMISSION_DENIED':
    case 'UNAUTHENTICATED':
      return 'the service key may not send pushes for this project';
    default:
      return code ?? 'failed';
  }
}
