import { cx, css, keyframes } from '@emotion/css';
import { useEffect, useState } from 'react';
import * as React from 'react';

import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { Trans } from 'app/core/internationalization';

import { Branding } from '../Branding/Branding';
import { BrandingSettings } from '../Branding/types';

interface InnerBoxProps {
  enterAnimation?: boolean;
}
export const InnerBox = ({ children, enterAnimation = true }: React.PropsWithChildren<InnerBoxProps>) => {
  const loginStyles = useStyles2(getLoginStyles);
  return <div className={cx(loginStyles.loginInnerBox, enterAnimation && loginStyles.enterAnimation)}>{children}</div>;
};

export interface LoginLayoutProps {
  /** Custom branding settings that can be used e.g. for previewing the Login page changes */
  branding?: BrandingSettings;
  isChangingPassword?: boolean;
}

export const LoginLayout = ({ children, branding, isChangingPassword }: React.PropsWithChildren<LoginLayoutProps>) => {
  const loginStyles = useStyles2(getLoginStyles);
  const [startAnim, setStartAnim] = useState(false);
  const subTitle = branding?.loginSubtitle ?? Branding.GetLoginSubTitle();
  const loginBoxBackground = branding?.loginBoxBackground || Branding.LoginBoxBackground();
  const loginLogo = branding?.loginLogo;

  useEffect(() => setStartAnim(true), []);

  return (
    <Branding.LoginBackground
      className={cx(loginStyles.container, startAnim && loginStyles.loginAnim, branding?.loginBackground)}
    >
      <div className={loginStyles.loginMain}>
        <div className={loginStyles.loginLogoContainer}>
          <Branding.LoginLogo className={loginStyles.loginLogo} logo={loginLogo} />
        </div>
        <div className={cx(loginStyles.loginContent, loginBoxBackground, 'login-content-box')}>
          <div className={loginStyles.loginLogoWrapper}>
            <div className={loginStyles.titleText}>Welcome back</div>
            <div className={loginStyles.additionalText}>Sign in to your account and do your best</div>
            <div className={loginStyles.titleWrapper}>
              {isChangingPassword ? (
                <h1 className={loginStyles.mainTitle}>
                  <Trans i18nKey="login.layout.update-password">Update your password</Trans>
                </h1>
              ) : (
                <>
                  {subTitle && <h3 className={loginStyles.subTitle}>{subTitle}</h3>}
                </>
              )}
            </div>
          </div>
          <div className={loginStyles.loginOuterBox}>{children}</div>
        </div>
        <div className={loginStyles.productText}>A <img src={'public/img/setplex.png'} alt="Setplex" /> product. Supported by <a href="https://grafana.com/grafana" className={loginStyles.grafanaText} target="_blank" rel="noreferrer">Grafana</a>.</div>
      </div>
    </Branding.LoginBackground>
  );
};

const flyInAnimation = keyframes`
from{
  opacity: 0;
  transform: translate(-60px, 0px);
}

to{
  opacity: 1;
  transform: translate(0px, 0px);
}`;

export const getLoginStyles = (theme: GrafanaTheme2) => {
  return {
    loginMain: css({
      flexGrow: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: '100%',
      marginTop: '60px'
    }),
    container: css({
      minHeight: '100%',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      flex: 1,
      minWidth: '100%',
      marginLeft: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    }),
    loginAnim: css({
      ['.login-content-box']: {
        opacity: 1,
        backgroundColor: '#262626',
        borderRadius: 20,
      },
    }),
    submitButton: css({
      justifyContent: 'center',
      width: '100%',
    }),
    titleText: css({
      fontSize: '32px',
      lineHeight: '40px',
      fontWeight: '700'
    }),
    additionalText: css({
      fontSize: '16px',
      lineHeight: '24px',
      fontWeight: '400',
      paddingTop: '16px',
      color: theme.colors.text.icon3,
    }),
    productText: css({
      fontSize: '12px',
      lineHeight: '16px',
      fontWeight: '500',
      color: theme.colors.text.icon3,
      width: '100%',
      textAlign: 'center',
      marginTop: theme.spacing(20)
    }),
    grafanaText: css({
      color: '#40B041',
      position: 'relative'
    }),
    loginLogo: css({
      width: '100%',
      maxWidth: 60,
      [theme.breakpoints.up('sm')]: {
        maxWidth: 200,
      },
    }),
    loginLogoContainer: css({
      width: '100%',
      textAlign: 'center',
      marginBottom: theme.spacing(8)
    }),
    loginLogoWrapper: css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      padding: theme.spacing(3),
    }),
    titleWrapper: css({
      textAlign: 'center',
    }),
    mainTitle: css({
      fontSize: 22,

      [theme.breakpoints.up('sm')]: {
        fontSize: 32,
      },
    }),
    subTitle: css({
      fontSize: theme.typography.size.md,
      color: theme.colors.text.secondary,
    }),
    loginContent: css({
      maxWidth: 478,
      width: `calc(100% - 2rem)`,
      display: 'flex',
      alignItems: 'stretch',
      flexDirection: 'column',
      position: 'relative',
      justifyContent: 'flex-start',
      zIndex: 1,
      minHeight: 320,
      borderRadius: theme.shape.radius.default,
      padding: theme.spacing(2, 0),
      opacity: 0,
      [theme.transitions.handleMotion('no-preference', 'reduce')]: {
        transition: 'opacity 0.5s ease-in-out',
      },

      [theme.breakpoints.up('sm')]: {
        minHeight: theme.spacing(40),
        justifyContent: 'center',
      },
    }),
    loginOuterBox: css({
      display: 'flex',
      overflowY: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    }),
    loginInnerBox: css({
      padding: theme.spacing(0, 2, 2, 2),
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      flexGrow: 1,
      maxWidth: 415,
      width: '100%',
      transform: 'translate(0px, 0px)',
      [theme.transitions.handleMotion('no-preference')]: {
        transition: '0.25s ease',
      },
    }),
    enterAnimation: css({
      [theme.transitions.handleMotion('no-preference')]: {
        animation: `${flyInAnimation} ease-out 0.2s`,
      },
    }),
  };
};
