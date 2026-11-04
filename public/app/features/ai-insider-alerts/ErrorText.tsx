// Analytix: AI Insider Alerts - an error code next to what it means. Every
// place that shows a code shows its words from the error dictionary (see
// errorCodes.ts); while the dictionary loads, or for a code it does not know,
// the code alone.

import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import { ErrorDictionary, describeCodes, describeError, errorKeyText, useErrorDictionary } from './errorCodes';

/** Code on one line, its meaning under it: for a table column of its own. */
export function ErrorCell({ code, platform, dict }: { code: string; platform: string; dict?: ErrorDictionary }) {
  const styles = useStyles2(getStyles);
  const description = describeError(dict, code, platform);
  return (
    <>
      <span className={styles.mono}>{errorKeyText(code)}</span>
      {description && <span className={styles.below}>{description}</span>}
    </>
  );
}

/** `403 / -12660 — Networking error…` inline, for a line that says more than the error. */
export function ErrorInline({ code, platform }: { code: string; platform: string }) {
  const styles = useStyles2(getStyles);
  const dict = useErrorDictionary();
  if (!code) {
    return <>—</>;
  }
  const description = describeError(dict, code, platform);
  return (
    <>
      <span className={styles.mono}>{errorKeyText(code)}</span>
      {description && <span className={styles.meaning}> — {description}</span>}
    </>
  );
}

/** The codes of an incident, most viewers first, one per line with their meaning. */
export function ErrorCodeList({
  codes,
  platforms,
  limit = 4,
}: {
  codes: Record<string, number>;
  platforms: Record<string, number>;
  limit?: number;
}) {
  const styles = useStyles2(getStyles);
  const dict = useErrorDictionary();
  const items = describeCodes(dict, codes, platforms, limit);
  if (!items.length) {
    return null;
  }
  return (
    <span className={styles.list}>
      {items.map((c) => (
        <span key={c.key}>
          <span className={styles.mono}>{errorKeyText(c.key)}</span> ({c.count})
          {c.description && <span className={styles.meaning}> — {c.description}</span>}
        </span>
      ))}
    </span>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  mono: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: 12,
    wordBreak: 'break-all',
  }),
  below: css({
    display: 'block',
    color: analytix.textFaint,
    fontSize: 12,
  }),
  meaning: css({
    color: analytix.textFaint,
    fontSize: 12,
  }),
  list: css({
    display: 'grid',
    gap: 2,
  }),
});
