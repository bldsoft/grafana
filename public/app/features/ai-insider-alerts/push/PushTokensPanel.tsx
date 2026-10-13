import { css } from '@emotion/css';
import { useMemo, useState } from 'react';

import { GrafanaTheme2, store } from '@grafana/data';
import { Trans, t } from '@grafana/i18n';
import { Button, Icon, TextArea, useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { PUSH_TOKENS_KEY, ParsedTokens, parseTokens } from './pushPlan';

/** The pasted token list, kept in this browser only (a test aid, not a device registry). */
export function usePushTokens(): { text: string; setText: (text: string) => void; parsed: ParsedTokens } {
  const [text, setTextState] = useState<string>(() => store.get(PUSH_TOKENS_KEY) ?? '');
  const parsed = useMemo(() => parseTokens(text), [text]);
  const setText = (next: string) => {
    setTextState(next);
    if (next.trim()) {
      store.set(PUSH_TOKENS_KEY, next);
    } else {
      store.delete(PUSH_TOKENS_KEY);
    }
  };
  return { text, setText, parsed };
}

/** "Push tokens for tests": account → FCM token lines under the Messages table. */
export function PushTokensPanel({
  text,
  parsed,
  onChange,
}: {
  text: string;
  parsed: ParsedTokens;
  onChange: (text: string) => void;
}) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(() => !text.trim());

  return (
    <div className={styles.panel}>
      <button type="button" className={styles.head} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'angle-down' : 'angle-right'} />
        <span className={styles.title}>
          <Trans i18nKey="ai-insider-alerts.push.tokens-title">Push tokens for tests</Trans>
        </span>
        <span className={styles.faint}>
          {t('ai-insider-alerts.push.tokens-count', '{{accounts}} accounts · {{tokens}} tokens', {
            accounts: parsed.byAccount.size,
            tokens: parsed.tokens,
          })}
        </span>
      </button>
      {open && (
        <div className={styles.body}>
          <div className={styles.faint}>
            <Trans i18nKey="ai-insider-alerts.push.tokens-help">
              One account per line: the account number, then its FCM token(s), separated by spaces, tabs, commas or
              semicolons (a CSV works; # starts a comment). Kept only in this browser. Rows of the table with a token
              get a push button.
            </Trans>
          </div>
          <TextArea
            className={styles.textarea}
            rows={6}
            spellCheck={false}
            placeholder={t(
              'ai-insider-alerts.push.tokens-placeholder',
              'ACC123456 fcm-token-iphone fcm-token-apple-tv'
            )}
            value={text}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
          <div className={styles.footer}>
            {parsed.skipped > 0 && (
              <span className={styles.warn}>
                {t('ai-insider-alerts.push.tokens-skipped', '{{count}} lines without a valid token are ignored', {
                  count: parsed.skipped,
                })}
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              fill="text"
              icon="trash-alt"
              disabled={!text}
              onClick={() => onChange('')}
            >
              <Trans i18nKey="ai-insider-alerts.push.tokens-clear">Clear</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css({
    border: `1px solid ${analytix.border}`,
    borderRadius: analytix.radiusCard,
  }),
  head: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    width: '100%',
    padding: theme.spacing(1, 1.25),
    background: 'none',
    border: 0,
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  }),
  title: css({
    fontWeight: theme.typography.fontWeightMedium,
  }),
  body: css({
    display: 'grid',
    gap: theme.spacing(1),
    padding: theme.spacing(0, 1.25, 1.25),
  }),
  textarea: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: 12,
  }),
  footer: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.spacing(1),
  }),
  faint: css({
    color: analytix.textFaint,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  warn: css({
    color: theme.colors.warning.text,
    fontSize: theme.typography.bodySmall.fontSize,
    marginRight: 'auto',
  }),
});
