interface BadgeSource {
  badge: string
  accent: string
}

interface Props {
  profile?: BadgeSource | null
  size?: number
  className?: string
}

export function ProfileBadge({ profile, size = 22, className }: Props) {
  const accent = profile?.accent ?? '#8b8b96'
  const badge = profile?.badge ?? '>_'
  return (
    <span
      className={`profile-badge${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.42)),
        color: accent,
        background: `color-mix(in srgb, ${accent} 18%, transparent)`,
        borderColor: `color-mix(in srgb, ${accent} 40%, transparent)`
      }}
      aria-hidden="true"
    >
      {badge}
    </span>
  )
}
