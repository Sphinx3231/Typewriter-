/**
 * The Typewriter logo. The supplied artwork (src/assets/brand/logo.png) holds both
 * variants side by side: light on the left half, dark on the right. The file is
 * shown unmodified; CSS picks the half for the active theme (see .logo-mark in
 * app.css and --logo-pos in tokens.css), so switching themes swaps the variant in
 * the same frame with no reload, flicker or layout shift.
 */
export function LogoMark({ size = 40, title }: { size?: number; title?: string }) {
  return (
    <span
      className="logo-mark"
      style={{ ["--logo-size" as string]: `${size}px` }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="logo-mark"
    >
      <span className="logo-mark__art" />
    </span>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="logo">
      <LogoMark size={compact ? 36 : 44} title="Typewriter logo" />
      {!compact ? <span className="logo__word">typewriter</span> : null}
    </span>
  );
}
