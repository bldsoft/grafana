import { css } from '@emotion/css';
import { useMemo, useState } from 'react';

import { GrafanaTheme2, store } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  RadioButtonGroup,
  TextArea,
  useStyles2,
} from '@grafana/ui';
import { TestPushMessage, sendTestPush } from 'app/features/dashboard-scene/ai-panel/assistantClient';
import { analytix } from 'app/features/home/analytixTokens';

import { formatCount } from '../format';
import type { Decision } from '../types';

import {
  DEFAULT_TEMPLATES,
  PushTemplate,
  PushTemplateId,
  TEMPLATE_IDS,
  accountKey,
  explainPushError,
  planPush,
  renderText,
} from './pushPlan';

/** Browser storage key of the tester's edited texts, per template. */
const TEMPLATES_KEY = 'analytix.aiAlerts.pushTemplates.v1';
const FAILURES_SHOWN = 20;

function templateLabel(id: PushTemplateId): string {
  switch (id) {
    case 'channel_down':
      return t('ai-insider-alerts.push.tpl-channel-down', 'Channel down');
    case 'service_down':
      return t('ai-insider-alerts.push.tpl-service-down', 'Service problems');
    case 'unstable':
      return t('ai-insider-alerts.push.tpl-unstable', 'Unstable');
    case 'channel_back':
      return t('ai-insider-alerts.push.tpl-channel-back', 'Channel back');
    case 'service_back':
      return t('ai-insider-alerts.push.tpl-service-back', 'Service back');
    case 'apology':
      return t('ai-insider-alerts.push.tpl-apology', 'Outage');
    default:
      return t('ai-insider-alerts.push.tpl-diagnosis', 'Connection');
  }
}

function loadTemplates(): Record<PushTemplateId, PushTemplate> {
  const saved = store.getObject<Partial<Record<PushTemplateId, Partial<PushTemplate>>>>(TEMPLATES_KEY, {});
  const out = { ...DEFAULT_TEMPLATES };
  for (const id of TEMPLATE_IDS) {
    const s = saved?.[id];
    if (s && typeof s === 'object') {
      out[id] = {
        title: typeof s.title === 'string' ? s.title : out[id].title,
        text: typeof s.text === 'string' ? s.text : out[id].text,
        enabled: typeof s.enabled === 'boolean' ? s.enabled : out[id].enabled,
      };
    }
  }
  return out;
}

interface SendOutcome {
  status: 'on' | 'off' | 'error';
  message?: string;
  validateOnly: boolean;
  ok: number;
  failures: Array<{ account: string; token: string; error?: string }>;
}

/**
 * Edit and send test pushes for the selected decisions: one push per account
 * (its latest decision), to every token pasted for it. The texts per message
 * type are remembered in this browser.
 */
export function PushDialog({
  decisions,
  tokens,
  heading,
  onDismiss,
}: {
  decisions: Decision[];
  tokens: Map<string, string[]>;
  heading: string;
  onDismiss: () => void;
}) {
  const styles = useStyles2(getStyles);
  const plan = useMemo(() => planPush(decisions, tokens), [decisions, tokens]);
  const [templates, setTemplates] = useState(loadTemplates);
  const [validateOnly, setValidateOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | undefined>();

  const recipients = plan.groups.reduce((n, g) => n + g.recipients.length, 0);
  const devices = plan.groups.reduce((n, g) => n + g.recipients.reduce((m, r) => m + r.tokens.length, 0), 0);
  const invalid = plan.groups.some((g) => !templates[g.template].text.trim());

  const update = (id: PushTemplateId, patch: Partial<PushTemplate>) => {
    setTemplates((prev) => {
      const next = { ...prev, [id]: { ...prev[id], ...patch } };
      store.setObject(TEMPLATES_KEY, next);
      return next;
    });
  };

  const send = async () => {
    const messages: TestPushMessage[] = [];
    for (const g of plan.groups) {
      const tpl = templates[g.template];
      for (const { decision, tokens: list } of g.recipients) {
        for (const token of list) {
          messages.push({
            pid: decision.pid,
            account: decision.userId,
            token,
            title: renderText(tpl.title, decision),
            text: renderText(tpl.text, decision),
            enabled: tpl.enabled,
            kind: decision.kind,
          });
        }
      }
    }
    setBusy(true);
    setOutcome(undefined);
    const res = await sendTestPush(messages, validateOnly);
    setBusy(false);
    const failures = res.results
      .map((r, i) => ({ r, m: messages[i] }))
      .filter(({ r }) => !r.ok)
      .map(({ r, m }) => ({ account: m.account, token: m.token, error: r.error }));
    setOutcome({
      status: res.status,
      message: res.message,
      validateOnly,
      ok: res.results.filter((r) => r.ok).length,
      failures,
    });
  };

  return (
    <Modal title={heading} isOpen onDismiss={onDismiss} className={styles.modal}>
      <div className={styles.summary}>
        {t(
          'ai-insider-alerts.push.summary',
          '{{accounts}} viewers selected · {{recipients}} with a push token · {{devices}} devices',
          { accounts: formatCount(plan.accounts), recipients: formatCount(recipients), devices: formatCount(devices) }
        )}
        {plan.withoutToken > 0 && (
          <span className={styles.faint}>
            {t(
              'ai-insider-alerts.push.without-token',
              '{{count}} without a token are skipped: add them under "Push tokens for tests".',
              { count: plan.withoutToken }
            )}
          </span>
        )}
      </div>

      {recipients === 0 ? (
        <Alert severity="info" title={t('ai-insider-alerts.push.no-recipients-title', 'Nobody to send to')}>
          <Trans i18nKey="ai-insider-alerts.push.no-recipients">
            None of the selected viewers has a token in the list. Paste &quot;account token&quot; lines under the
            Messages table.
          </Trans>
        </Alert>
      ) : (
        <div className={styles.groups}>
          {plan.groups.map((g) => {
            const tpl = templates[g.template];
            const sample = g.recipients[0].decision;
            return (
              <div key={g.template} className={styles.group}>
                <div className={styles.groupHead}>
                  <Badge text={templateLabel(g.template)} color={tpl.enabled ? 'orange' : 'green'} />
                  <span className={styles.faint}>
                    {t('ai-insider-alerts.push.group-count', '{{count}} viewers', { count: g.recipients.length })}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    fill="text"
                    onClick={() => update(g.template, DEFAULT_TEMPLATES[g.template])}
                  >
                    <Trans i18nKey="ai-insider-alerts.push.reset">Reset text</Trans>
                  </Button>
                </div>
                <Field noMargin label={t('ai-insider-alerts.push.title', 'Title')}>
                  <Input
                    id={`ai-push-title-${g.template}`}
                    value={tpl.title}
                    maxLength={120}
                    onChange={(e) => update(g.template, { title: e.currentTarget.value })}
                  />
                </Field>
                <Field
                  noMargin
                  label={t('ai-insider-alerts.push.text', 'Text')}
                  description={t('ai-insider-alerts.push.text-help', '{channel} and {provider} are filled per viewer.')}
                >
                  <TextArea
                    id={`ai-push-text-${g.template}`}
                    rows={3}
                    value={tpl.text}
                    maxLength={1000}
                    onChange={(e) => update(g.template, { text: e.currentTarget.value })}
                  />
                </Field>
                <RadioButtonGroup
                  size="sm"
                  value={tpl.enabled}
                  onChange={(enabled) => update(g.template, { enabled })}
                  options={[
                    {
                      label: t('ai-insider-alerts.push.mode-show', 'Show warning'),
                      value: true,
                      description: t(
                        'ai-insider-alerts.push.mode-show-tip',
                        'iOS/tvOS: the yellow strip with this text for 24 h (toast in the player)'
                      ),
                    },
                    {
                      label: t('ai-insider-alerts.push.mode-clear', 'Clear warning'),
                      value: false,
                      description: t(
                        'ai-insider-alerts.push.mode-clear-tip',
                        'iOS/tvOS: hide the strip; a phone in the background still shows the text'
                      ),
                    },
                  ]}
                />
                <div className={styles.preview}>
                  <span className={styles.faint}>
                    {t('ai-insider-alerts.push.preview', 'Example for {{account}}:', { account: sample.userId })}
                  </span>{' '}
                  <strong>{renderText(tpl.title, sample)}</strong> {renderText(tpl.text, sample)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {outcome && <OutcomeView outcome={outcome} />}

      <Modal.ButtonRow
        leftItems={
          <Checkbox
            value={validateOnly}
            onChange={(e) => setValidateOnly(e.currentTarget.checked)}
            label={t('ai-insider-alerts.push.validate-only', 'Check tokens only')}
            description={t(
              'ai-insider-alerts.push.validate-only-tip',
              'FCM validates the tokens, nothing is delivered'
            )}
          />
        }
      >
        <Button variant="secondary" fill="outline" onClick={onDismiss}>
          <Trans i18nKey="ai-insider-alerts.push.close">Close</Trans>
        </Button>
        <Button icon={busy ? 'spinner' : 'message'} disabled={busy || recipients === 0 || invalid} onClick={send}>
          {validateOnly
            ? t('ai-insider-alerts.push.check', 'Check {{count}} tokens', { count: devices })
            : t('ai-insider-alerts.push.send', 'Send to {{count}} devices', { count: devices })}
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
}

function OutcomeView({ outcome }: { outcome: SendOutcome }) {
  const styles = useStyles2(getStyles);
  if (outcome.status === 'off') {
    return (
      <Alert severity="warning" title={t('ai-insider-alerts.push.off-title', 'Test pushes are off')}>
        <Trans i18nKey="ai-insider-alerts.push.off">
          The AI Insider service has no Firebase key for push messages yet.
        </Trans>
      </Alert>
    );
  }
  const failed = outcome.failures.length;
  const severity = outcome.status === 'error' ? 'error' : failed ? 'warning' : 'success';
  const title =
    outcome.status === 'error'
      ? (outcome.message ?? t('ai-insider-alerts.push.error', 'Push request failed'))
      : outcome.validateOnly
        ? t('ai-insider-alerts.push.checked', '{{ok}} tokens valid, {{failed}} not', { ok: outcome.ok, failed })
        : t('ai-insider-alerts.push.sent', '{{ok}} sent, {{failed}} failed', { ok: outcome.ok, failed });
  return (
    <Alert severity={severity} title={title}>
      {failed > 0 && (
        <ul className={styles.failures}>
          {outcome.failures.slice(0, FAILURES_SHOWN).map((f, i) => (
            <li key={i}>
              <span className={styles.mono}>
                {accountKey(f.account)} …{f.token.slice(-8)}
              </span>{' '}
              — {explainPushError(f.error)}
            </li>
          ))}
          {failed > FAILURES_SHOWN && <li>…</li>}
        </ul>
      )}
    </Alert>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  modal: css({
    width: 720,
    maxWidth: '95vw',
  }),
  summary: css({
    display: 'grid',
    gap: 2,
    marginBottom: theme.spacing(2),
  }),
  faint: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  groups: css({
    display: 'grid',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
  }),
  group: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(1.5),
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusCard,
  }),
  groupHead: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  preview: css({
    fontSize: theme.typography.bodySmall.fontSize,
    color: analytix.textDim,
  }),
  failures: css({
    margin: 0,
    paddingLeft: theme.spacing(2),
  }),
  mono: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: 12,
  }),
});
