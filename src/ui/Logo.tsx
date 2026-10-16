import { useId } from "react";

/**
 * Typewriter mark: a "T" built from a typewriter platen (the bar with two
 * knobs) and a type bar, with a text cursor resting at the baseline.
 */
export function LogoMark({ size = 36, title }: { size?: number; title?: string }) {
  const gid = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} className="logo-mark">
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={`lg-${gid}`} x1="6" y1="4" x2="60" y2="62" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--logo-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-to)" }} />
        </linearGradient>
        <linearGradient id={`sh-${gid}`} x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity=".22" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#lg-${gid})`} />
      <rect width="64" height="64" rx="16" fill={`url(#sh-${gid})`} />
      {/* platen with knobs */}
      <circle cx="13" cy="19" r="4.2" fill="#fff" fillOpacity=".8" />
      <circle cx="51" cy="19" r="4.2" fill="#fff" fillOpacity=".8" />
      <rect x="15" y="14.5" width="34" height="9" rx="4.5" fill="#fff" />
      {/* type bar */}
      <rect x="27.5" y="22" width="9" height="27" rx="3.5" fill="#fff" />
      {/* cursor at the baseline */}
      <rect x="39.5" y="44.5" width="11" height="4.5" rx="2.25" fill="#fff" fillOpacity=".72" />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo">
      <LogoMark size={compact ? 30 : 34} />
      {!compact ? (
        <span className="logo__word">
          typewriter<span className="logo__caret" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
}
