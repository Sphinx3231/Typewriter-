import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { TypingSound } from "../audio/sound";
import {
  buildScript,
  buildTimeline,
  computeStats,
  durationForWpm,
  estimate,
  isBlank,
  normalizeSettings,
  PlaybackController,
  randomSeed,
  realismKey,
  validateSettings,
  wpmForDuration,
  type PlaybackSettings,
  type PlaybackStatus,
} from "../engine";
import { readJSON, readString, removeKey, writeJSON, writeString } from "./storage";

export interface Preferences {
  /** Keep the editor text on this device between visits. Off by default. */
  rememberText: boolean;
  /** Keep a local list of finished sessions (stats only, never the text). */
  keepHistory: boolean;
  volume: number;
}

export const DEFAULT_PREFS: Preferences = { rememberText: false, keepHistory: true, volume: 0.6 };

export interface HistoryEntry {
  id: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "stopped";
  characters: number;
  words: number;
  plannedMs: number;
  elapsedMs: number;
  mistakes: number;
  timingMode: PlaybackSettings["timingMode"];
  wpm: number;
  correction: PlaybackSettings["correction"];
  mistakeLevel: PlaybackSettings["mistakes"];
}

const MAX_HISTORY = 200;
/** Above this size the editor warns that planning may take a moment. Text is never truncated. */
export const LARGE_TEXT_CHARS = 150_000;

function settingsKey(s: PlaybackSettings) {
  return `${realismKey(s)}|${s.timingMode}|${s.durationSec}|${s.wpm}`;
}

export function useSession() {
  const [prefs, setPrefsState] = useState<Preferences>(() => ({ ...DEFAULT_PREFS, ...readJSON<Partial<Preferences>>("prefs", {}) }));
  const [settings, setSettingsState] = useState<PlaybackSettings>(() => normalizeSettings(readJSON("settings", null)));
  const [text, setTextState] = useState<string>(() => (prefs.rememberText ? readString("text") ?? "" : ""));
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    const h = readJSON<HistoryEntry[]>("history", []);
    return Array.isArray(h) ? h : [];
  });

  const controllerRef = useRef<PlaybackController | null>(null);
  if (!controllerRef.current) controllerRef.current = new PlaybackController();
  const controller = controllerRef.current;
  const soundRef = useRef<TypingSound | null>(null);
  if (!soundRef.current) soundRef.current = new TypingSound();
  const sound = soundRef.current;

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  // ---- persistence ----
  useEffect(() => {
    const id = setTimeout(() => writeJSON("settings", settings), 250);
    return () => clearTimeout(id);
  }, [settings]);
  useEffect(() => {
    writeJSON("prefs", prefs);
    if (!prefs.rememberText) removeKey("text");
  }, [prefs]);
  useEffect(() => {
    if (!prefs.rememberText) return;
    const id = setTimeout(() => writeString("text", text), 400);
    return () => clearTimeout(id);
  }, [text, prefs.rememberText]);
  useEffect(() => {
    writeJSON("history", history);
  }, [history]);

  // ---- derived planning ----
  const deferredText = useDeferredValue(text);
  const planning = deferredText !== text;
  const realism = realismKey(settings);
  const graphemesStats = useMemo(() => computeStats(deferredText), [deferredText]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const script = useMemo(() => buildScript(deferredText, settings), [deferredText, realism]);
  const est = useMemo(
    () => estimate(script, settings),
    [script, settings.timingMode, settings.durationSec, settings.wpm], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const issues = useMemo(() => validateSettings(settings), [settings]);
  const blank = isBlank(text);

  // The settings and text the current playback was built from.
  const loaded = useRef<{ text: string; key: string } | null>(null);
  const currentKey = settingsKey(settings);

  // Keep the controller's ready/empty state in sync with the editor while idle.
  useEffect(() => {
    const st = controller.getStatus();
    if (st === "playing" || st === "paused") return;
    const textChanged = loaded.current?.text !== deferredText;
    const keyChanged = loaded.current?.key !== currentKey;
    if (st === "completed" || st === "stopped" || st === "error") {
      if (!textChanged) return; // keep the finished output on screen until the text changes or playback starts again
    } else if (!textChanged && !keyChanged) return;
    const usable = !isBlank(deferredText) && issues.length === 0;
    controller.load(deferredText, usable ? buildTimeline(script, settings) : null);
    loaded.current = { text: deferredText, key: currentKey };
  }, [deferredText, currentKey, script, issues.length, controller]); // eslint-disable-line react-hooks/exhaustive-deps

  const settingsChangedSinceStart =
    !!loaded.current && (snapshot.status === "playing" || snapshot.status === "paused" || snapshot.status === "completed" || snapshot.status === "stopped") &&
    loaded.current.key !== currentKey;

  // ---- sound ----
  useEffect(() => {
    sound.setEnabled(settings.sound);
  }, [settings.sound, sound]);
  useEffect(() => {
    sound.setVolume(prefs.volume);
  }, [prefs.volume, sound]);
  useEffect(() => controller.onKeystroke((ev) => sound.play(ev)), [controller, sound]);

  // ---- history ----
  const sessionStart = useRef<{ at: string; mistakes: number } | null>(null);
  const prevStatus = useRef<PlaybackStatus>(snapshot.status);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = snapshot.status;
    if (prev === snapshot.status) return;
    if ((snapshot.status === "completed" || snapshot.status === "stopped") && sessionStart.current && prefs.keepHistory) {
      const src = controller.getSource();
      const st = computeStats(src);
      const entry: HistoryEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        startedAt: sessionStart.current.at,
        endedAt: new Date().toISOString(),
        status: snapshot.status,
        characters: st.characters,
        words: st.words,
        plannedMs: snapshot.totalMs,
        elapsedMs: snapshot.elapsedMs,
        mistakes: sessionStart.current.mistakes,
        timingMode: settings.timingMode,
        wpm: Math.round(est.keystrokeWpm),
        correction: settings.correction,
        mistakeLevel: settings.mistakes,
      };
      setHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
      sessionStart.current = null;
    }
  }, [snapshot.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- commands ----
  const setText = useCallback(
    (t: string) => {
      const st = controller.getStatus();
      if (st === "playing" || st === "paused") return; // the editor is locked during playback
      setTextState(t);
    },
    [controller],
  );

  const updateSettings = useCallback((patch: Partial<PlaybackSettings>) => setSettingsState((s) => ({ ...s, ...patch })), []);
  const updatePrefs = useCallback((patch: Partial<Preferences>) => setPrefsState((p) => ({ ...p, ...patch })), []);

  /** Build a fresh timeline from the current text and settings, then play it from the start. */
  const start = useCallback((): boolean => {
    if (isBlank(text) || validateSettings(settings).length) return false;
    sound.unlock();
    sound.setEnabled(settings.sound);
    const st = controller.getStatus();
    if (st === "playing" || st === "paused") controller.stop();
    const sc = text === deferredText && realismKey(settings) === realism ? script : buildScript(text, settings);
    const tl = buildTimeline(sc, settings);
    controller.load(text, tl);
    loaded.current = { text, key: settingsKey(settings) };
    sessionStart.current = { at: new Date().toISOString(), mistakes: sc.mistakes };
    return controller.start();
  }, [text, deferredText, settings, realism, script, controller, sound]);

  const pause = useCallback(() => controller.pause(), [controller]);
  const resume = useCallback(() => {
    sound.unlock();
    return controller.resume();
  }, [controller, sound]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const restart = useCallback(() => start(), [start]);
  const reset = useCallback(() => controller.reset(), [controller]);
  const newVariation = useCallback(() => updateSettings({ seed: randomSeed() }), [updateSettings]);

  const applyDuration = useCallback(
    (durationSec: number) => updateSettings({ timingMode: "duration", durationSec: Math.ceil(durationSec) }),
    [updateSettings],
  );

  return {
    text,
    setText,
    stats: graphemesStats,
    planning,
    blank,
    settings,
    updateSettings,
    issues,
    script,
    estimate: est,
    equivalents: {
      wpmForDuration: (sec: number) => wpmForDuration(script, sec),
      durationForWpm: (wpm: number) => durationForWpm(script, wpm),
    },
    prefs,
    updatePrefs,
    history,
    clearHistory: () => setHistory([]),
    deleteHistoryEntry: (id: string) => setHistory((h) => h.filter((e) => e.id !== id)),
    controller,
    snapshot,
    settingsChangedSinceStart,
    start,
    pause,
    resume,
    stop,
    restart,
    reset,
    newVariation,
    applyDuration,
    resetPreferences: () => {
      setSettingsState(normalizeSettings(null));
      setPrefsState(DEFAULT_PREFS);
    },
  };
}

export type Session = ReturnType<typeof useSession>;
