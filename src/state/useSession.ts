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
import { tauriBridge, type Bridge, type Support } from "../desktop/bridge";
import { currentHost } from "../platform";
import { ExternalController } from "../desktop/external";
import type { VerifyResult } from "../desktop/verify";
import { humanize, type HumanizeResult, type Tone } from "../humanize";
import { applyReverts, diffText, type TextDiff } from "../humanize/diff";
import { readJSON, readString, removeKey, writeJSON, writeString } from "./storage";

export type Destination = "preview" | "external";

export interface Preferences {
  /** Keep the editor text on this device between visits. Off by default. */
  rememberText: boolean;
  /** Keep a local list of finished sessions (stats only, never the text). */
  keepHistory: boolean;
  volume: number;
  /** Where typing goes: the in-app preview, or the app the user selects (desktop only). */
  destination: Destination;
  /** Seconds between leaving Typewriter and the first keystroke in another app. */
  countdownSec: number;
  /** Minimise Typewriter when external typing is armed, so the previous app comes forward. */
  minimizeWhileTyping: boolean;
  /** Smart Humanization (SPEC §2a): check the writing style and, at 50% or more, type a lightly edited copy. Off by default. */
  smartHumanize: boolean;
  /** The tone the style checklist compares against. */
  humanizeTone: Tone;
}

export const DEFAULT_PREFS: Preferences = {
  rememberText: false,
  keepHistory: true,
  volume: 0.6,
  destination: "preview",
  countdownSec: 5,
  minimizeWhileTyping: true,
  smartHumanize: false,
  humanizeTone: "any",
};

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
  destination?: Destination;
  /** For another app: "sent" until the user verified the document text. */
  verification?: "sent" | "verified" | "mismatch";
}

const MAX_HISTORY = 200;
const DEBOUNCE_ABOVE_CHARS = 20_000;
/** Above this size the editor warns that planning may take a moment. Text is never truncated. */
export const LARGE_TEXT_CHARS = 150_000;

function settingsKey(s: PlaybackSettings) {
  return `${realismKey(s)}|${s.timingMode}|${s.durationSec}|${s.wpm}`;
}

export function useSession() {
  const [prefs, setPrefsState] = useState<Preferences>(() => {
    const p = { ...DEFAULT_PREFS, ...readJSON<Partial<Preferences>>("prefs", {}) };
    // Saved by an older version, or edited by hand: never let a bad value turn rewriting on.
    if (typeof p.smartHumanize !== "boolean") p.smartHumanize = false;
    if (!["any", "casual", "formal"].includes(p.humanizeTone)) p.humanizeTone = "any";
    return p;
  });
  const [settings, setSettingsState] = useState<PlaybackSettings>(() => normalizeSettings(readJSON("settings", null)));
  const [text, setTextState] = useState<string>(() => (prefs.rememberText ? readString("text") ?? "" : ""));
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    const h = readJSON<HistoryEntry[]>("history", []);
    return Array.isArray(h) ? h : [];
  });

  const previewRef = useRef<PlaybackController | null>(null);
  if (!previewRef.current) previewRef.current = new PlaybackController();
  const preview = previewRef.current;

  // Desktop app and Chrome extension: the adapter that types outside the preview.
  const host = currentHost();
  const desktop = host === "desktop";
  const [external, setExternal] = useState<ExternalController | null>(null);
  const [support, setSupport] = useState<Support>(() =>
    host !== "web"
      ? { available: false, state: "unsupported", platform: "", message: "Checking…" }
      : { available: false, state: "browser", platform: "web", message: "Typing into other apps needs the Typewriter desktop app or Chrome extension." },
  );
  const bridgeRef = useRef<Bridge | null>(null);
  useEffect(() => {
    if (host === "web") return;
    let alive = true;
    const make: Promise<Bridge> = host === "desktop" ? tauriBridge() : import("../extension/bridge").then((m) => m.extensionBridge());
    void make.then(async (bridge) => {
      if (!alive) return;
      bridgeRef.current = bridge;
      setExternal(new ExternalController(bridge));
      setSupport(await bridge.support(false));
    });
    return () => {
      alive = false;
    };
  }, [host]);

  const useExternal = prefs.destination === "external" && !!external;
  const controller = useExternal ? external! : preview;
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
  // Short texts re-plan on every change (deferred so typing stays snappy);
  // long texts wait for a short pause in editing before planning.
  const deferred = useDeferredValue(text);
  const [debounced, setDebounced] = useState(text);
  const isLong = text.length > DEBOUNCE_ABOVE_CHARS;
  useEffect(() => {
    if (!isLong) return;
    const id = setTimeout(() => setDebounced(text), 350);
    return () => clearTimeout(id);
  }, [text, isLong]);
  const deferredText = isLong ? debounced : deferred;
  const planning = deferredText !== text;
  const realism = realismKey(settings);
  const graphemesStats = useMemo(() => computeStats(deferredText), [deferredText]);

  // ---- Smart Humanization (SPEC §2a) ----
  // `text` is the immutable original: the editor never shows a rewrite. When the feature is on,
  // the text to type is derived from the original every time, never from a previous rewrite.
  const humanizeOn = prefs.smartHumanize;
  const tone = prefs.humanizeTone;
  /** Bumped by "Re-run": checks the original again from scratch. */
  const [runs, setRuns] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const humanized = useMemo<HumanizeResult | null>(() => (humanizeOn ? humanize(deferredText, tone) : null), [humanizeOn, deferredText, tone, runs]);
  /** What changed, for the Studio (presentation only; never typed). */
  const diff = useMemo<TextDiff | null>(() => (humanized?.status === "humanized" ? diffText(humanized.source, humanized.output) : null), [humanized]);
  /** The original the user chose to type as written while the feature is on (until the text changes). */
  const [originalFor, setOriginalFor] = useState<string | null>(null);
  /** Changes the user put back to the original wording, for this exact result. */
  const [reverted, setReverted] = useState<{ result: HumanizeResult; ids: number[] } | null>(null);
  const revertedIds = useMemo(() => new Set(reverted && reverted.result === humanized ? reverted.ids : []), [reverted, humanized]);
  const prepare = useCallback(
    (src: string): string => {
      if (!humanizeOn || originalFor === src) return src;
      if (humanized && humanized.source === src) return diff ? applyReverts(diff, revertedIds) : humanized.output;
      return humanize(src, tone).output;
    },
    [humanizeOn, originalFor, humanized, diff, revertedIds, tone],
  );
  /** What a session started now would type. */
  const prepared = prepare(deferredText);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const script = useMemo(() => buildScript(prepared, settings), [prepared, realism]);
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
  const loadedFor = useRef<unknown>(null);
  useEffect(() => {
    const st = controller.getStatus();
    if (st === "playing" || st === "paused") return;
    if (loadedFor.current !== controller) {
      loadedFor.current = controller;
      loaded.current = null;
    }
    const textChanged = loaded.current?.text !== prepared;
    const keyChanged = loaded.current?.key !== currentKey;
    if (st === "completed" || st === "stopped" || st === "error") {
      if (!textChanged) return; // keep the finished output on screen until the text changes or playback starts again
    } else if (!textChanged && !keyChanged) return;
    const usable = !isBlank(deferredText) && issues.length === 0;
    controller.load(prepared, usable ? buildTimeline(script, settings) : null);
    loaded.current = { text: prepared, key: currentKey };
  }, [prepared, currentKey, script, issues.length, controller]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const lastEntryId = useRef<string | null>(null);
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
        wpm: snapshot.elapsedMs > 0 ? Math.round(snapshot.sourceDone / 5 / (snapshot.elapsedMs / 60_000)) : 0,
        correction: settings.correction,
        mistakeLevel: settings.mistakes,
        destination: snapshot.external ? "external" : "preview",
        verification: snapshot.external && snapshot.status === "completed" ? "sent" : undefined,
      };
      lastEntryId.current = entry.id;
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
      // Any edit is checked afresh: a choice to type the original, or to revert a change, applies to the text it was made for.
      setOriginalFor(null);
      setReverted(null);
    },
    [controller],
  );

  const updateSettings = useCallback((patch: Partial<PlaybackSettings>) => setSettingsState((s) => ({ ...s, ...patch })), []);
  const updatePrefs = useCallback((patch: Partial<Preferences>) => setPrefsState((p) => ({ ...p, ...patch })), []);
  /** Changes to Smart Humanization wait until no session is running: text never changes mid-session. */
  const idle = useCallback(() => {
    const st = controller.getStatus();
    return st !== "playing" && st !== "paused";
  }, [controller]);

  /** Build a fresh timeline from the current text and settings, then play it from the start. */
  const start = useCallback((): boolean => {
    if (isBlank(text) || validateSettings(settings).length) return false;
    sound.unlock();
    sound.setEnabled(settings.sound);
    const st = controller.getStatus();
    if (st === "playing" || st === "paused") controller.stop();
    // The checklist and any rewrite finish here, synchronously, before anything is typed.
    const out = prepare(text);
    const sc = out === prepared && realismKey(settings) === realism ? script : buildScript(out, settings);
    const tl = buildTimeline(sc, settings);
    if (controller instanceof ExternalController)
      controller.configure({ countdownMs: Math.round(prefs.countdownSec * 1000), minimize: prefs.minimizeWhileTyping });
    controller.load(out, tl);
    loaded.current = { text: out, key: settingsKey(settings) };
    sessionStart.current = { at: new Date().toISOString(), mistakes: sc.mistakes };
    return controller.start();
  }, [text, prepare, prepared, settings, realism, script, controller, sound, prefs.countdownSec, prefs.minimizeWhileTyping]);

  const pause = useCallback(() => controller.pause(), [controller]);
  const resume = useCallback(() => {
    sound.unlock();
    return controller.resume();
  }, [controller, sound]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const restart = useCallback(() => (controller.canRestart ? start() : false), [start, controller]);

  const setDestination = useCallback(
    (d: Destination) => {
      const st = controller.getStatus();
      if (st === "playing" || st === "paused") return;
      setPrefsState((p) => ({ ...p, destination: d }));
    },
    [controller],
  );

  const refreshSupport = useCallback(async (prompt = false) => {
    if (!bridgeRef.current) return;
    setSupport(await bridgeRef.current.support(prompt));
  }, []);

  /** Reads text the user copied from the destination and compares it with the original. */
  const verifyDestination = useCallback(async (): Promise<VerifyResult | null> => {
    if (!external) return null;
    const r = await external.verifyFromClipboard();
    if (r.status !== "empty" && lastEntryId.current) {
      const id = lastEntryId.current;
      setHistory((h) => h.map((e) => (e.id === id ? { ...e, verification: r.status === "verified" ? "verified" : "mismatch" } : e)));
    }
    return r;
  }, [external]);
  const reset = useCallback(() => controller.reset(), [controller]);
  const newVariation = useCallback(() => updateSettings({ seed: randomSeed() }), [updateSettings]);

  const applyDuration = useCallback(
    (durationSec: number) => updateSettings({ timingMode: "duration", durationSec: Math.ceil(durationSec) }),
    [updateSettings],
  );

  const running = snapshot.status === "playing" || snapshot.status === "paused";
  const humanizeState = {
    enabled: humanizeOn,
    tone,
    /** The checklist hasn't caught up with the latest edit yet. */
    checking: humanizeOn && planning,
    /** The checklist result for the current original (null when off). */
    result: humanized,
    /** The user chose to type the original as written. */
    usingOriginal: humanizeOn && originalFor === deferredText,
    /** Exactly what a session started now types. */
    prepared,
    locked: running,
    setEnabled: (on: boolean) => idle() && updatePrefs({ smartHumanize: on }),
    setTone: (t: Tone) => idle() && updatePrefs({ humanizeTone: t }),
    typeOriginal: () => idle() && setOriginalFor(deferredText),
    typeHumanized: () => idle() && setOriginalFor(null),
    /** Exactly what changed between the original and the humanized copy (null unless humanized). */
    diff,
    /** Changes put back to the original wording; the prepared copy already reflects them. */
    reverted: revertedIds,
    /** Put one change back to the original wording (or undo that). Never while a session runs. */
    setChangeReverted: (id: number, revert: boolean) => {
      if (!idle() || !humanized || !diff || !diff.changes.some((c) => c.id === id)) return false;
      const ids = new Set(revertedIds);
      if (revert) ids.add(id);
      else ids.delete(id);
      setReverted({ result: humanized, ids: [...ids].sort((a, b) => a - b) });
      return true;
    },
    /** Check the original again from scratch: clears reverts and the "type my original" choice. Never runs on a previous rewrite. */
    rerun: () => {
      if (!idle()) return false;
      setOriginalFor(null);
      setReverted(null);
      setRuns((n) => n + 1);
      return true;
    },
    /** How many times "Re-run" was used (for a short confirmation in the UI). */
    runs,
  };

  return {
    text,
    setText,
    humanize: humanizeState,
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
    desktop,
    host,
    externalReady: !!external,
    support,
    refreshSupport,
    destination: useExternal ? ("external" as const) : ("preview" as const),
    setDestination,
    verifyDestination,
    showMain: () => bridgeRef.current?.showMain(),
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
