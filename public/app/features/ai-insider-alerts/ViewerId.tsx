// Analytix: a viewer id as the tables show it. A subscriber is their account
// number; a guest (the provider's shared `<prefix>-GUEST` account) or a viewer
// without an account is told apart by the device serial, or by the IP address
// on web, so the id alone looks like a random hash or an address. The tag
// under it says which it is.

import { css } from '@emotion/css';

import { GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';
import { analytix } from 'app/features/home/analytixTokens';

import type { ViewerKind } from './types';

export interface ViewerIdentity {
  userId: string;
  userKind?: ViewerKind;
  platform?: string;
}

/** "Guest · device ID" and the like; undefined for a subscriber account (or an older run without the kind). */
export function viewerKindText({ userKind, platform }: Omit<ViewerIdentity, 'userId'>): string | undefined {
  if (userKind !== 'guest' && userKind !== 'none') {
    return undefined;
  }
  const who =
    userKind === 'guest'
      ? t('ai-insider-alerts.viewer-guest', 'Guest')
      : t('ai-insider-alerts.viewer-no-account', 'No account');
  const id =
    platform?.toLowerCase() === 'web'
      ? t('ai-insider-alerts.viewer-id-ip', 'IP address')
      : t('ai-insider-alerts.viewer-id-device', 'device ID');
  return `${who} · ${id}`;
}

/** The id (a link when `onClick` is set) with the guest tag under it. */
export function ViewerId({
  viewer,
  onClick,
  linkClassName,
}: {
  viewer: ViewerIdentity;
  onClick?: () => void;
  linkClassName?: string;
}) {
  const styles = useStyles2(getStyles);
  const kind = viewerKindText(viewer);
  const id = onClick ? (
    <button type="button" className={linkClassName} onClick={onClick}>
      {viewer.userId}
    </button>
  ) : (
    viewer.userId
  );
  if (!kind) {
    return <>{id}</>;
  }
  return (
    <span className={styles.wrap}>
      {id}
      <span
        className={styles.tag}
        title={t(
          'ai-insider-alerts.viewer-guest-tip',
          'Not a subscriber account: guests share one account per provider, so the viewer is told apart by the device (the IP address on web)'
        )}
      >
        {kind}
      </span>
    </span>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  wrap: css({
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.spacing(0.25),
  }),
  tag: css({
    fontFamily: theme.typography.fontFamily,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.4,
    padding: theme.spacing(0, 0.75),
    borderRadius: theme.shape.radius.pill,
    background: analytix.control,
    border: `1px solid ${analytix.border}`,
    color: analytix.textMuted,
    whiteSpace: 'nowrap',
  }),
});
