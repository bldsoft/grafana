import { useEffect } from 'react';

import { NavModelItem } from '@grafana/data';
import { t } from '@grafana/i18n';
import { AI_INSIDER_ALERTS_NAV_ID, setAiInsiderAlertsNav } from 'app/core/reducers/navBarTree';
import { useAiInsiderAccess } from 'app/features/dashboard-scene/ai-panel/useAiInsiderAccess';
import { useDispatch } from 'app/types/store';

export const ALERTS_PATH = '/ai-insider/alerts';
export const ALERTS_NAV_ID = AI_INSIDER_ALERTS_NAV_ID;

/** The two sections of the page; `?section=keep` picks the second one. */
export type AlertsSection = 'tell' | 'keep';

export function alertsSectionNavId(section: AlertsSection): string {
  return `${ALERTS_NAV_ID}-${section}`;
}

export function alertsSectionUrl(section: AlertsSection): string {
  return section === 'keep' ? `${ALERTS_PATH}?section=keep` : ALERTS_PATH;
}

/**
 * Analytix: the side menu entry of AI Insider Alerts, a top-level item next to
 * Home and Dashboards with one child per section. Both children open the same
 * page (the sections stay mounted there, switching only changes `?section`).
 */
export function buildAlertsNav(): NavModelItem {
  return {
    id: ALERTS_NAV_ID,
    text: t('ai-insider-alerts.page-title', 'AI Insider Alerts'),
    icon: 'bell',
    url: ALERTS_PATH,
    children: [
      {
        id: alertsSectionNavId('tell'),
        text: t('ai-insider-alerts.section-tell', 'Quality'),
        url: alertsSectionUrl('tell'),
      },
      {
        id: alertsSectionNavId('keep'),
        text: t('ai-insider-alerts.section-keep', 'Retention'),
        url: alertsSectionUrl('keep'),
      },
    ],
  };
}

/**
 * Adds the AI Insider Alerts section to the side menu for members of the
 * organisation's AI Insider team and removes it for everyone else. The nav
 * tree comes from the server, which knows nothing about the team gate, so the
 * entry is added on the client once the access lookup answers.
 */
export function AiInsiderAlertsNav() {
  const allowed = useAiInsiderAccess();
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(setAiInsiderAlertsNav(allowed ? buildAlertsNav() : undefined));
  }, [allowed, dispatch]);

  return null;
}
