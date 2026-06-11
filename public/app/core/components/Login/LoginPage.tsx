// Libraries
import { css } from '@emotion/css';

// Components
import { GrafanaTheme2, PageLayoutType } from '@grafana/data';
import { config } from '@grafana/runtime';
import { Alert, Stack, useStyles2 } from '@grafana/ui';
import { Branding } from 'app/core/components/Branding/Branding';

import { ChangePassword } from '../ForgottenPassword/ChangePassword';
import { Page } from '../Page/Page';

import LoginCtrl from './LoginCtrl';
import { LoginForm } from './LoginForm';
import { LoginLayout, InnerBox } from './LoginLayout';
import { LoginServiceButtons } from './LoginServiceButtons';
import { PasswordlessConfirmation } from './PasswordlessConfirmationForm';
import { PasswordlessLoginForm } from './PasswordlessLoginForm';
import { UserSignup } from './UserSignup';

const LoginPage = () => {
  const styles = useStyles2(getStyles);

  document.title = Branding.AppTitle;

  return (
    <Page layout={PageLayoutType.Custom}>
      <LoginCtrl>
        {({
          loginHint,
          passwordHint,
          disableLoginForm,
          disableUserSignUp,
          login,
          passwordlessStart,
          passwordlessConfirm,
          showPasswordlessConfirmation,
          isLoggingIn,
          changePassword,
          skipPasswordChange,
          isChangingPassword,
          showDefaultPasswordWarning,
          loginErrorMessage,
        }) => (
          <LoginLayout isChangingPassword={isChangingPassword}>
            {!isChangingPassword && !showPasswordlessConfirmation && (
              <InnerBox>
                {loginErrorMessage && (
                  <Alert className={styles.alert} severity="error" title={''}>
                    {loginErrorMessage}
                  </Alert>
                )}

                {!disableLoginForm && !config.auth.passwordlessEnabled && (
                  <LoginForm
                    onSubmit={login}
                    loginHint={loginHint}
                    passwordHint={passwordHint}
                    isLoggingIn={isLoggingIn}
                  >
                    <Stack justifyContent="flex-end"></Stack>
                  </LoginForm>
                )}
                {config.auth.passwordlessEnabled && (
                  <PasswordlessLoginForm onSubmit={passwordlessStart} isLoggingIn={isLoggingIn}></PasswordlessLoginForm>
                )}
                <LoginServiceButtons />
                {!disableUserSignUp && <UserSignup />}
              </InnerBox>
            )}

            {config.auth.passwordlessEnabled && showPasswordlessConfirmation && (
              <InnerBox>
                <PasswordlessConfirmation
                  onSubmit={passwordlessConfirm}
                  isLoggingIn={isLoggingIn}
                ></PasswordlessConfirmation>
              </InnerBox>
            )}

            {isChangingPassword && !config.auth.passwordlessEnabled && (
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
    </Page>
  );
};

export default LoginPage;

const getStyles = (theme: GrafanaTheme2) => {
  return {
    alert: css({
      width: '100%',
    }),
  };
};
