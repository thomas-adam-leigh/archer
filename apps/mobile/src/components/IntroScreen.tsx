import { type Session, signOut } from '../lib/auth.js';

/** Which onboarding path the user chose at the intro. */
export type OnboardingPath = 'resume' | 'scratch';

/**
 * Meet Archer + the two onboarding paths. The starting point for a brand-new
 * user, before any profile data exists. Choosing a path hands off to that path's
 * flow (résumé upload — ARC-74; guided chat — ARC-80).
 */
export function IntroScreen(props: {
  session: Session;
  onChoosePath: (path: OnboardingPath) => void;
  onLogout: () => void;
}) {
  const { session, onChoosePath, onLogout } = props;

  const logout = () => {
    // Best-effort server revoke, then drop local state regardless.
    signOut(session.accessToken).finally(onLogout);
  };

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">Hi, I'm Archer</text>
        <text className="Auth__subtitle">
          I'm here to help you find your next role. Before I can start searching
          on your behalf, I need to understand who you are, what you've done,
          and where you want to go.
        </text>

        <view className="Button" bindtap={() => onChoosePath('resume')}>
          <text className="Button__label">Upload my résumé</text>
        </view>

        <view
          className="Button Button--secondary"
          bindtap={() => onChoosePath('scratch')}
        >
          <text className="Button__label">Start from scratch</text>
        </view>

        <view className="Auth__switch" bindtap={logout}>
          <text className="Auth__switchText">Sign out</text>
        </view>
      </view>
    </view>
  );
}
