import { History, PenLine, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { APP_VERSION } from "./build";
import { markReady } from "./ready";
import { useSession } from "./state/useSession";
import { useTheme } from "./theme/theme";
import { ActivityLog } from "./ui/ActivityLog";
import { useToast } from "./ui/controls";
import { Editor } from "./ui/Editor";
import { StudioPanel } from "./ui/AnalysisStudio";
import { ExternalGuide } from "./ui/ExternalPanel";
import { HistoryView } from "./ui/HistoryView";
import { Logo } from "./ui/Logo";
import { PlaybackSurface } from "./ui/PlaybackSurface";
import { PreferencesView } from "./ui/PreferencesView";
import { QuitGuard } from "./ui/QuitGuard";
import { copyText, SessionBar } from "./ui/SessionBar";
import { SettingsPanel } from "./ui/SettingsPanel";
import { StatusPill } from "./ui/StatusPill";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { nf } from "./ui/format";

type View = "workspace" | "history" | "settings";

const VIEWS: { id: View; label: string; title: string; sub: string; icon: JSX.Element }[] = [
  { id: "workspace", label: "Workspace", title: "Workspace", sub: "Paste your text, set the pace, and watch it typed out.", icon: <PenLine size={18} /> },
  { id: "history", label: "History", title: "History", sub: "Sessions you have run on this device.", icon: <History size={18} /> },
  { id: "settings", label: "Settings", title: "Settings", sub: "Appearance, sound, privacy and shortcuts.", icon: <Settings size={18} /> },
];

function viewFromHash(): View {
  const h = location.hash.replace(/^#\/?/, "");
  return h === "history" || h === "settings" ? h : "workspace";
}

const isTyping = (el: Element | null) =>
  !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "range"].includes(el.type)) || (el as HTMLElement).isContentEditable);

export default function App() {
  const session = useSession();
  const { theme, preference, setPreference, toggle } = useTheme();
  const toast = useToast();
  const [view, setView] = useState<View>(viewFromHash);
  const { snapshot } = session;

  useEffect(() => markReady(), []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((v: View) => {
    setView(v);
    const hash = v === "workspace" ? "" : `#/${v}`;
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
  }, []);

  const copy = useCallback(async () => {
    if (session.snapshot.status !== "completed") return;
    const text = session.controller.getSource();
    const ok = await copyText(text);
    toast(ok ? `Copied ${nf.format(text.length)} characters` : "Couldn't copy. Select the text and copy it manually.", ok ? "success" : "error");
  }, [session, toast]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = session.snapshot.status;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (st === "paused") session.resume();
        else if (st !== "playing") {
          if (session.start()) go("workspace");
        }
        return;
      }
      if (mod && e.shiftKey && (e.key === "C" || e.key === "c") && st === "completed") {
        e.preventDefault();
        void copy();
        return;
      }
      if (e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        go(VIEWS[Number(e.key) - 1].id);
        return;
      }
      const target = document.activeElement;
      if (e.key === " " && !mod && !isTyping(target) && !(target instanceof HTMLButtonElement) && !(target?.getAttribute("role") === "switch")) {
        if (st === "playing") {
          e.preventDefault();
          session.pause();
        } else if (st === "paused") {
          e.preventDefault();
          session.resume();
        }
        return;
      }
      if (e.key === "Escape" && (st === "playing" || st === "paused")) {
        e.preventDefault();
        session.stop();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [session, copy, go]);

  // Title reflects progress so a background tab still shows it.
  useEffect(() => {
    const pct = Math.floor(snapshot.progress * 100);
    document.title =
      snapshot.status === "playing" ? `${pct}% · Typewriter` : snapshot.status === "completed" ? "Done · Typewriter" : snapshot.status === "paused" ? `Paused ${pct}% · Typewriter` : "Typewriter";
  }, [snapshot.status, snapshot.progress]);

  const current = VIEWS.find((v) => v.id === view)!;
  const running = snapshot.status === "playing" || snapshot.status === "paused";

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar__brand">
          <Logo />
        </div>
        <nav className="nav">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={`nav__item ${view === v.id ? "is-active" : ""}`}
              aria-current={view === v.id ? "page" : undefined}
              onClick={() => go(v.id)}
              data-testid={`nav-${v.id}`}
            >
              <span aria-hidden="true">{v.icon}</span>
              {v.label}
              {v.id === "workspace" && running ? <span className="nav__live" aria-label="Playback running" /> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">
          <p className="sidebar__tag">Type naturally. Write effortlessly.</p>
          <p className="sidebar__meta" data-testid="sidebar-version">Runs on your device · v{APP_VERSION}</p>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="topbar__brand-mobile">
            <Logo compact />
          </div>
          <div className="topbar__titles">
            <h1 className="topbar__title">{current.title}</h1>
            <p className="topbar__sub">{current.sub}</p>
          </div>
          <div className="topbar__actions">
            {view !== "workspace" && running ? (
              <button type="button" className="topbar__live" onClick={() => go("workspace")}>
                <StatusPill status={snapshot.status} compact /> {Math.floor(snapshot.progress * 100)}%
              </button>
            ) : null}
            <ThemeSwitch theme={theme} onToggle={toggle} />
            <button
              type="button"
              className={`icon-btn icon-btn--bordered ${view === "settings" ? "is-active" : ""}`}
              aria-label="Settings"
              title="Settings (Alt + 3)"
              onClick={() => go(view === "settings" ? "workspace" : "settings")}
              data-testid="header-settings"
            >
              <Settings size={17} />
            </button>
          </div>
        </header>

        <main id="main" className="content" tabIndex={-1}>
          {/* The workspace stays mounted so switching views never interrupts playback. */}
          <div className="workspace" hidden={view !== "workspace"}>
            <SessionBar session={session} onCopy={copy} />
            <div className="workspace__grid">
              <div className={`workspace__texts ${snapshot.status === "ready" || snapshot.status === "empty" ? "" : "has-session"}`}>
                <Editor session={session} />
                <section className={`panel playback ${snapshot.status === "playing" ? "is-live" : ""}`} aria-labelledby="playback-title">
                  <header className="panel__head">
                    <div className="panel__title-group">
                      <h2 className="panel__title" id="playback-title">
                        Playback
                      </h2>
                      <p className="panel__sub">
                        {session.destination === "external" ? "What has been sent to the other app, key by key." : "Typed out keystroke by keystroke."}
                      </p>
                    </div>
                    <StatusPill status={snapshot.status} />
                  </header>
                  <PlaybackSurface
                    controller={session.controller}
                    snapshot={snapshot}
                    estimateMs={session.estimate.totalMs}
                    words={session.stats.words}
                    blank={session.blank}
                    guide={session.destination === "external" ? <ExternalGuide session={session} /> : undefined}
                  />
                  <ActivityLog snapshot={snapshot} />
                </section>
              </div>
              <StudioPanel session={session} />
              <SettingsPanel session={session} />
            </div>
          </div>
          {view === "history" ? <HistoryView session={session} /> : null}
          {view === "settings" ? <PreferencesView session={session} themePreference={preference} onThemePreference={setPreference} /> : null}
        </main>
      </div>

      <nav className="tabbar" aria-label="Main navigation">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`tabbar__item ${view === v.id ? "is-active" : ""}`}
            aria-current={view === v.id ? "page" : undefined}
            onClick={() => go(v.id)}
          >
            <span aria-hidden="true">{v.icon}</span>
            {v.label}
          </button>
        ))}
      </nav>
      {session.host === "desktop" ? <QuitGuard session={session} /> : null}
    </div>
  );
}
