/**
 * A minimal, reusable stage screen: a titled card with an optional subtitle and
 * up to two actions. The router uses it for the states whose full screens are
 * built in later milestones — loading, a load error (with retry), a resumed step
 * (processing/review/titles — ARC-74→78), and the just-chosen path before its
 * flow exists. Each is replaced by its real screen as that issue lands.
 */
export function StageScreen(props: {
  title: string;
  subtitle?: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const {
    title,
    subtitle,
    primaryLabel,
    onPrimary,
    secondaryLabel,
    onSecondary,
  } = props;

  return (
    <view className="Auth">
      <view className="Auth__card">
        <text className="Auth__title">{title}</text>
        {subtitle ? <text className="Auth__subtitle">{subtitle}</text> : null}

        {primaryLabel && onPrimary ? (
          <view className="Button" bindtap={onPrimary}>
            <text className="Button__label">{primaryLabel}</text>
          </view>
        ) : null}

        {secondaryLabel && onSecondary ? (
          <view className="Auth__switch" bindtap={onSecondary}>
            <text className="Auth__switchText">{secondaryLabel}</text>
          </view>
        ) : null}
      </view>
    </view>
  );
}
