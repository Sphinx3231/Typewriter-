import { Moon, Sun } from "lucide-react";
import type { ThemeName } from "../theme/theme";

/** Compact sun/moon switch for the header. */
export function ThemeSwitch({ theme, onToggle }: { theme: ThemeName; onToggle: () => void }) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={`theme-switch ${dark ? "is-dark" : ""}`}
      onClick={onToggle}
      data-testid="theme-switch"
    >
      <span className="theme-switch__icon theme-switch__icon--sun" aria-hidden="true">
        <Sun size={14} strokeWidth={2.2} />
      </span>
      <span className="theme-switch__icon theme-switch__icon--moon" aria-hidden="true">
        <Moon size={14} strokeWidth={2.2} />
      </span>
      <span className="theme-switch__thumb" aria-hidden="true" />
      <span className="sr-only">{dark ? "Dark" : "Light"}</span>
    </button>
  );
}
