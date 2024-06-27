// Libraries
import { css } from '@emotion/css';
import React from 'react';

// Components
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Stack, useStyles2 } from '@grafana/ui';
import { Branding } from 'app/core/components/Branding/Branding';

import { ChangePassword } from '../ForgottenPassword/ChangePassword';

import LoginCtrl from './LoginCtrl';
import { LoginForm } from './LoginForm';
import { LoginLayout, InnerBox } from './LoginLayout';
import { LoginServiceButtons } from './LoginServiceButtons';
import { UserSignup } from './UserSignup';

export const LoginPage = () => {
  const styles = useStyles2(getStyles);
  document.title = Branding.AppTitle;

  return (
    <LoginCtrl>
      {({
        loginHint,
        passwordHint,
        disableLoginForm,
        disableUserSignUp,
        login,
        isLoggingIn,
        changePassword,
        skipPasswordChange,
        isChangingPassword,
        showDefaultPasswordWarning,
        loginErrorMessage,
      }) => (
        <LoginLayout isChangingPassword={isChangingPassword}>
          {!isChangingPassword && (
            <InnerBox>
              {loginErrorMessage && (
                <Alert className={styles.alert} severity="error" title={''}>
                  {loginErrorMessage}
                </Alert>
              )}

              {!disableLoginForm && (
                <LoginForm onSubmit={login} loginHint={loginHint} passwordHint={passwordHint} isLoggingIn={isLoggingIn}>
                  <Stack justifyContent="flex-end"></Stack>
                </LoginForm>
              )}
              <LoginServiceButtons />
              {!disableUserSignUp && <UserSignup />}
            </InnerBox>
          )}

          {isChangingPassword && (
            <InnerBox>
              <ChangePassword
                showDefaultPasswordWarning={showDefaultPasswordWarning}
                onSubmit={changePassword}
                onSkip={() => skipPasswordChange()}
              />
            </InnerBox>
          )}
        </LoginLayout>
      )}
    </LoginCtrl>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  return {
    forgottenPassword: css({
      padding: 0,
      marginTop: theme.spacing(0.5),
    }),

    alert: css({
      width: '100%',
    }),
  };
};
