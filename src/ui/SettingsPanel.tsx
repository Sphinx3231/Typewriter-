import { AlertTriangle, Clock3, Gauge, Shuffle } from "lucide-react";
import { useId } from "react";
import { LIMITS, type PlaybackSettings } from "../engine";
import type { Session } from "../state/useSession";
import { Button, Field, NumberInput, Segmented, Switch } from "./controls";
import { OutputSettings } from "./ExternalPanel";
import { clockDuration, longDuration, nf } from "./format";

const PRESETS: { id: string; label: string; title: string; patch: Partial<PlaybackSettings> }[] = [
  { id: "clean", label: "Clean", title: "Even keystrokes, no pauses, no mistakes", patch: { rhythm: false, pauses: false, mistakes: "off" } },
  {
    id: "natural",
    label: "Natural",
    title: "Varied rhythm, natural pauses, the odd typo",
    patch: { rhythm: true, variation: "medium", pauses: true, mistakes: "low", correction: "mixed" },
  },
  {
    id: "human",
    label: "Very human",
    title: "More variation and more corrections",
    patch: { rhythm: true, variation: "high", pauses: true, mistakes: "medium", correction: "mixed" },
  },
];

function presetOf(s: PlaybackSettings): string | null {
  for (const p of PRESETS) if (Object.entries(p.patch).every(([k, v]) => s[k as keyof PlaybackSettings] === v)) return p.id;
  return null;
}

export function SettingsPanel({ session }: { session: Session }) {
  const { settings: s, updateSettings: set, estimate: est, issues, equivalents, snapshot } = session;
  const ids = { dmin: useId(), dsec: useId(), wpm: useId(), cmin: useId(), cmax: useId() };
  const running = snapshot.status === "playing" || snapshot.status === "paused";
  const issue = (f: keyof PlaybackSettings) => issues.find((i) => i.field === f)?.message ?? null;
  const minutes = Math.floor(s.durationSec / 60);
  const seconds = Math.round(s.durationSec % 60);
  const preset = presetOf(s);
  const hasText = !session.blank;
  const breakdown = [
    { key: "typing", label: "Typing", ms: est.typingMs },
    { key: "pauses", label: "Pauses", ms: est.pauseMs },
    { key: "fixes", label: "Corrections", ms: est.correctionMs },
  ];
  const sum = Math.max(1, est.totalMs);

  return (
    <section className="panel settings" aria-labelledby="settings-title">
      <header className="panel__head">
        <div className="panel__title-group">
          <h2 className="panel__title" id="settings-title">
            Session settings
          </h2>
          <p className="panel__sub">{running ? "Changes apply when you restart." : "Saved automatically on this device."}</p>
        </div>
      </header>

      <OutputSettings session={session} />

      {/* ---- timing ---- */}
      <div className="settings__group">
        <h3 className="settings__heading">Timing</h3>
        <Segmented
          label="Set the timing by"
          value={s.timingMode}
          onChange={(timingMode) => {
            // Carry the current estimate over so switching modes doesn't jump.
            if (timingMode === "duration" && est.totalMs > 0) set({ timingMode, durationSec: Math.max(1, Math.round(est.totalMs / 1000)) });
            else if (timingMode === "speed" && hasText && s.timingMode === "duration") {
              const w = Math.round(est.keystrokeWpm);
              set({ timingMode, wpm: Math.min(LIMITS.wpm.max, Math.max(LIMITS.wpm.min, w || s.wpm)) });
            } else set({ timingMode });
          }}
          options={[
            { value: "duration", label: "Total duration", icon: <Clock3 size={15} /> },
            { value: "speed", label: "Typing speed", icon: <Gauge size={15} /> },
          ]}
        />

        {s.timingMode === "duration" ? (
          <Field
            label="Type the whole text in"
            htmlFor={ids.dmin}
            error={issue("durationSec")}
            hint={hasText && !est.conflict ? `About ${Math.round(est.keystrokeWpm)} WPM while typing` : undefined}
          >
            <div className="duration-inputs">
              <NumberInput
                id={ids.dmin}
                ariaLabel="Minutes"
                value={minutes}
                min={0}
                max={1440}
                suffix="min"
                invalid={!!issue("durationSec")}
                onCommit={(m) => set({ durationSec: Math.max(1, m * 60 + seconds) })}
              />
              <NumberInput
                id={ids.dsec}
                ariaLabel="Seconds"
                value={seconds}
                min={0}
                max={59}
                suffix="sec"
                invalid={!!issue("durationSec")}
                onCommit={(sec) => set({ durationSec: Math.max(1, minutes * 60 + sec) })}
              />
            </div>
          </Field>
        ) : (
          <Field
            label="Typing speed"
            htmlFor={ids.wpm}
            error={issue("wpm")}
            hint={hasText ? `Takes about ${longDuration(equivalents.durationForWpm(s.wpm) * 1000)} with your realism settings` : "Words per minute while typing (5 characters = 1 word)"}
          >
            <div className="wpm-row">
              <input
                type="range"
                className="range"
                min={10}
                max={200}
                step={1}
                value={Math.min(200, Math.max(10, s.wpm))}
                aria-label="Typing speed in words per minute"
                aria-valuetext={`${s.wpm} words per minute`}
                onChange={(e) => set({ wpm: Number(e.target.value) })}
                style={{ ["--fill" as string]: `${((Math.min(200, Math.max(10, s.wpm)) - 10) / 190) * 100}%` }}
              />
              <NumberInput id={ids.wpm} value={s.wpm} min={LIMITS.wpm.min} max={LIMITS.wpm.max} suffix="WPM" invalid={!!issue("wpm")} onCommit={(wpm) => set({ wpm })} />
            </div>
          </Field>
        )}

        {hasText ? (
          <div className="estimate" data-testid="estimate">
            <div className="estimate__row">
              <span className="estimate__label">Estimated total</span>
              <strong className="estimate__value" data-testid="estimate-total">
                {clockDuration(est.totalMs)}
              </strong>
            </div>
            <div className="estimate__bar" aria-hidden="true">
              {breakdown.map((b) => (
                <span key={b.key} className={`estimate__seg estimate__seg--${b.key}`} style={{ width: `${(b.ms / sum) * 100}%` }} />
              ))}
            </div>
            <ul className="estimate__legend">
              {breakdown.map((b) => (
                <li key={b.key}>
                  <span className={`dot dot--${b.key}`} aria-hidden="true" />
                  {b.label} <span className="estimate__ms">{longDuration(b.ms)}</span>
                </li>
              ))}
            </ul>
            <p className="estimate__note">
              {s.timingMode === "duration"
                ? "Pauses and corrections are fitted inside your duration, so the keystrokes get a little faster."
                : `Pauses and corrections add time on top of ${s.wpm} WPM. Average over the session: ${Math.round(est.effectiveWpm)} WPM.`}
              {session.script.mistakes > 0 ? ` This take includes ${nf.format(session.script.mistakes)} typo${session.script.mistakes === 1 ? "" : "s"}.` : ""}
            </p>
          </div>
        ) : null}

        {est.conflict ? (
          <div className="callout callout--warning" role="alert" data-testid="conflict">
            <AlertTriangle size={16} aria-hidden="true" className="callout__icon" />
            <div>
              <p>
                <strong>{longDuration(est.conflict.requestedMs)} is too short</strong> for this text with these pauses and corrections. Playback needs at
                least {longDuration(est.conflict.minimumMs)}, so it will take that long.
              </p>
              <div className="callout__actions">
                <Button size="sm" variant="secondary" onClick={() => session.applyDuration(est.conflict!.minimumMs / 1000)}>
                  Use {longDuration(est.conflict.minimumMs)}
                </Button>
                {(s.mistakes !== "off" || s.pauses) && est.conflict.minimumCleanMs <= est.conflict.requestedMs ? (
                  <Button size="sm" variant="ghost" onClick={() => set({ mistakes: "off", pauses: false })}>
                    Turn off mistakes and pauses
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {!est.conflict && hasText && est.superhuman ? (
          <div className="callout callout--info" role="status" data-testid="superhuman">
            <Gauge size={16} aria-hidden="true" className="callout__icon" />
            <div>
              <p>
                That's about <strong>{nf.format(Math.round(est.keystrokeWpm))} WPM</strong>, far faster than anyone types, so pauses and typos
                will be hard to see. Playback still works.
              </p>
              {s.timingMode === "duration" ? (
                <div className="callout__actions">
                  <Button size="sm" variant="secondary" onClick={() => session.applyDuration(est.humanMinimumMs / 1000)}>
                    Use {longDuration(est.humanMinimumMs)} (fast human pace)
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- realism ---- */}
      <div className="settings__group">
        <h3 className="settings__heading">Realism</h3>
        <Field label="Preset" hint={preset ? undefined : "Custom mix. Pick a preset to reset."}>
          <Segmented
            label="Realism preset"
            value={(preset ?? "custom") as string}
            onChange={(id) => {
              const p = PRESETS.find((x) => x.id === id);
              if (p) set(p.patch);
            }}
            options={[...PRESETS.map((p) => ({ value: p.id, label: p.label, title: p.title }))]}
          />
        </Field>

        <Switch checked={s.rhythm} onChange={(rhythm) => set({ rhythm })} label="Realistic rhythm" description="Small natural variations between keystrokes." />
        <fieldset className="settings__sub settings__sub--flat" disabled={!s.rhythm}>
          <legend className="sr-only">Speed variation</legend>
          <Field label="Speed variation" hint={!s.rhythm ? "Turn on realistic rhythm to vary the speed." : undefined}>
          <Segmented
            label="Speed variation"
            value={s.variation}
            onChange={(variation) => set({ variation })}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
          </Field>
        </fieldset>
        <Switch checked={s.pauses} onChange={(pauses) => set({ pauses })} label="Natural pauses" description="After sentences, between paragraphs, before long words." />

        <Field label="Typing mistakes" hint="Typos are always fixed during playback. Your own wording is never changed.">
          <Segmented
            label="Typing mistakes"
            value={s.mistakes}
            onChange={(mistakes) => set({ mistakes })}
            options={[
              { value: "off", label: "Off" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
            ]}
          />
        </Field>

        <fieldset className="settings__sub" disabled={s.mistakes === "off"} aria-describedby={s.mistakes === "off" ? "mistakes-off-note" : undefined}>
          <legend className="sr-only">Correction settings</legend>
          <Field label="How typos get fixed">
            <Segmented
              label="How typos get fixed"
              value={s.correction}
              onChange={(correction) => set({ correction })}
              options={[
                { value: "autocorrect", label: "Autocorrect", title: "The wrong word flashes, then snaps to the right one" },
                { value: "backspace", label: "Backspace", title: "Backspace and retype, sometimes going back with the arrow keys" },
                { value: "mixed", label: "Mixed", title: "A mix of both" },
              ]}
            />
          </Field>
          <Field label="Time to notice a typo" htmlFor={ids.cmin} error={issue("correctionDelayMinMs")}>
            <div className="range-pair">
              <NumberInput
                id={ids.cmin}
                ariaLabel="Shortest delay in milliseconds"
                value={s.correctionDelayMinMs}
                min={LIMITS.correctionDelayMs.min}
                max={LIMITS.correctionDelayMs.max}
                step={50}
                suffix="ms"
                invalid={!!issue("correctionDelayMinMs")}
                onCommit={(v) => set({ correctionDelayMinMs: v })}
              />
              <span className="range-pair__to" aria-hidden="true">
                to
              </span>
              <NumberInput
                id={ids.cmax}
                ariaLabel="Longest delay in milliseconds"
                value={s.correctionDelayMaxMs}
                min={LIMITS.correctionDelayMs.min}
                max={LIMITS.correctionDelayMs.max}
                step={50}
                suffix="ms"
                invalid={!!issue("correctionDelayMinMs")}
                onCommit={(v) => set({ correctionDelayMaxMs: v })}
              />
            </div>
          </Field>
          {s.mistakes === "off" ? (
            <p className="field__hint" id="mistakes-off-note">
              Turn on typing mistakes to use these.
            </p>
          ) : null}
        </fieldset>

        <Switch checked={s.sound} onChange={(sound) => set({ sound })} label="Typing sounds" description="Soft key clicks. Turning this off silences them at once." />

        <div className="seed-row">
          <div>
            <p className="seed-row__label">Variation #{(s.seed % 100000).toString().padStart(5, "0")}</p>
            <p className="seed-row__desc">Restart replays the same typing. Shuffle for a different take.</p>
          </div>
          <Button size="sm" variant="secondary" icon={<Shuffle size={14} />} onClick={session.newVariation} data-testid="btn-shuffle">
            Shuffle
          </Button>
        </div>
      </div>
    </section>
  );
}
