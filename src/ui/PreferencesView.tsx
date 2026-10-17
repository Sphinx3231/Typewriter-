import { Monitor, Moon, RotateCcw, Sun, Trash2, Volume2 } from "lucide-react";
import { useId } from "react";
import { TypingSound } from "../audio/sound";
import type { Session } from "../state/useSession";
import type { ThemePreference } from "../theme/theme";
import { Button, ConfirmButton, Field, Segmented, Switch, useToast } from "./controls";
import { LogoMark } from "./Logo";
import { APP_COMMIT, APP_VERSION } from "../build";

const SHORTCUTS: [string, string][] = [
  ["Ctrl / ⌘ + Enter", "Start, or start again"],
  ["Space", "Pause or resume (outside text fields)"],
  ["Esc", "Stop playback"],
  ["Ctrl / ⌘ + Shift + C", "Copy the finished text"],
  ["Alt + 1 / 2 / 3", "Workspace, history, settings"],
];

let previewSound: TypingSound | null = null;

export function PreferencesView({
  session,
  themePreference,
  onThemePreference,
}: {
  session: Session;
  themePreference: ThemePreference;
  onThemePreference: (p: ThemePreference) => void;
}) {
  const toast = useToast();
  const volId = useId();
  const { prefs, updatePrefs, settings, updateSettings } = session;

  const testSound = () => {
    previewSound ??= new TypingSound();
    previewSound.unlock();
    previewSound.setEnabled(true);
    previewSound.setVolume(prefs.volume);
    const word = "typewriter ";
    [...word].forEach((ch, i) => setTimeout(() => previewSound?.play({ kind: "type", text: ch, at: 0, u: 1, p: 0, ms: 0, fix: false, src: 0 }), i * 110));
  };

  return (
    <div className="view view--prefs">
      <section className="panel prefs" aria-labelledby="prefs-appearance">
        <h2 className="panel__title" id="prefs-appearance">
          Appearance
        </h2>
        <Field label="Theme" hint="System follows your device until you pick light or dark.">
          <Segmented
            label="Theme"
            value={themePreference}
            onChange={onThemePreference}
            options={[
              { value: "system", label: "System", icon: <Monitor size={15} /> },
              { value: "light", label: "Light", icon: <Sun size={15} /> },
              { value: "dark", label: "Dark", icon: <Moon size={15} /> },
            ]}
          />
        </Field>
      </section>

      <section className="panel prefs" aria-labelledby="prefs-sound">
        <h2 className="panel__title" id="prefs-sound">
          Sound
        </h2>
        <Switch checked={settings.sound} onChange={(sound) => updateSettings({ sound })} label="Typing sounds" description="Generated on your device. No audio files are downloaded." />
        <Field label="Volume" htmlFor={volId}>
          <div className="wpm-row">
            <input
              id={volId}
              type="range"
              className="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.volume}
              onChange={(e) => updatePrefs({ volume: Number(e.target.value) })}
              aria-valuetext={`${Math.round(prefs.volume * 100)}%`}
              style={{ ["--fill" as string]: `${prefs.volume * 100}%` }}
            />
            <Button size="sm" icon={<Volume2 size={14} />} onClick={testSound}>
              Test
            </Button>
          </div>
        </Field>
      </section>

      <section className="panel prefs" aria-labelledby="prefs-privacy">
        <h2 className="panel__title" id="prefs-privacy">
          Privacy and data
        </h2>
        <p className="panel__sub">Everything stays in this browser. Typewriter has no account, no server and no AI.</p>
        <Switch
          checked={prefs.rememberText}
          onChange={(rememberText) => updatePrefs({ rememberText })}
          label="Remember my text on this device"
          description="Off by default. When off, your text is gone when you close the app."
        />
        <Switch
          checked={prefs.keepHistory}
          onChange={(keepHistory) => updatePrefs({ keepHistory })}
          label="Keep session history"
          description="Saves dates, lengths and speeds. Never the text itself."
        />
        <div className="prefs__actions">
          <ConfirmButton
            variant="secondary"
            size="md"
            icon={<Trash2 size={15} />}
            confirmLabel="Delete all history?"
            onConfirm={() => {
              session.clearHistory();
              toast("History cleared", "success");
            }}
            disabled={!session.history.length}
          >
            Clear history
          </ConfirmButton>
          <ConfirmButton
            variant="secondary"
            size="md"
            icon={<RotateCcw size={15} />}
            confirmLabel="Reset all settings?"
            onConfirm={() => {
              session.resetPreferences();
              onThemePreference("system");
              toast("Settings reset to defaults", "success");
            }}
          >
            Reset settings
          </ConfirmButton>
        </div>
      </section>

      <section className="panel prefs" aria-labelledby="prefs-keys">
        <h2 className="panel__title" id="prefs-keys">
          Keyboard shortcuts
        </h2>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="shortcuts__row">
              <dt>
                {k.split(" + ").map((part, i) => (
                  <span key={part}>
                    {i > 0 ? " + " : ""}
                    <kbd>{part}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel prefs prefs--about" aria-labelledby="prefs-about">
        <LogoMark size={40} />
        <div>
          <h2 className="panel__title" id="prefs-about">
            Typewriter {APP_VERSION}
          </h2>
          <p className="panel__sub">Type naturally. Write effortlessly. Runs entirely in your browser.</p>
          <p className="panel__sub" data-testid="build-id">
            Build {APP_COMMIT}
          </p>
        </div>
      </section>
    </div>
  );
}
