import { useCallback, useEffect, useState } from "react";
import { readString, writeString } from "../state/storage";

export type ThemeName = "light" | "dark";
export type ThemePreference = ThemeName | "system";

const KEY = "theme";
const media = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);

function systemTheme(): ThemeName {
  return media()?.matches ? "dark" : "light";
}

function readPreference(): ThemePreference {
  const v = readString(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function apply(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0a0a0d" : "#f6f6fb");
}

/**
 * Theme state. Follows the OS setting until the user picks one explicitly;
 * the explicit choice is saved and wins from then on.
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<ThemeName>(systemTheme);
  const theme: ThemeName = preference === "system" ? system : preference;

  useEffect(() => {
    const m = media();
    if (!m) return;
    const onChange = () => setSystem(m.matches ? "dark" : "light");
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  useEffect(() => apply(theme), [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    writeString(KEY, p === "system" ? null : p);
  }, []);

  const toggle = useCallback(() => setPreference(theme === "dark" ? "light" : "dark"), [theme, setPreference]);

  return { theme, preference, setPreference, toggle };
}
