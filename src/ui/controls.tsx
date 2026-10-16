import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; icon?: ReactNode }) {
  return (
    <button type="button" className={`btn btn--${variant} btn--${size} ${className}`} {...rest}>
      {icon ? <span className="btn__icon" aria-hidden="true">{icon}</span> : null}
      {children ? <span className="btn__label">{children}</span> : null}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={rest.title ?? label} {...rest}>
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: ReactNode;
  id?: string;
  disabled?: boolean;
}) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <div className="switch-row">
      <div className="switch-row__text">
        <label htmlFor={sid} className="switch-row__label">
          {label}
        </label>
        {description ? (
          <p className="switch-row__desc" id={`${sid}-desc`}>
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${sid}-desc` : undefined}
        className="switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
        <span className="sr-only">{checked ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  id?: string;
  size?: "sm" | "md";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % options.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + options.length) % options.length;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`segmented segmented--${size}`} role="radiogroup" aria-label={label} id={id}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`segmented__opt ${on ? "is-on" : ""}`}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.icon ? <span aria-hidden="true" className="segmented__icon">{o.icon}</span> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className={`field ${error ? "field--error" : ""}`}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

/** Number input that lets the user type freely and commits a clamped value on blur/Enter. */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  step = 1,
  id,
  suffix,
  ariaLabel,
  invalid,
  disabled,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  id?: string;
  suffix?: string;
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className={`num-input ${invalid ? "is-invalid" : ""} ${disabled ? "is-disabled" : ""}`}>
      <input
        id={id}
        inputMode="decimal"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {suffix ? <span className="num-input__suffix" aria-hidden="true">{suffix}</span> : null}
    </div>
  );
}

// ---- toasts ----
type Toast = { id: number; message: string; tone: "info" | "success" | "error" };
const ToastCtx = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Two-step confirm: first click arms the button, second click within 3 s confirms. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  icon,
  variant = "ghost",
  size = "sm",
  disabled,
}: {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel: string;
  icon?: ReactNode;
  variant?: Variant;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <Button
      variant={armed ? "danger" : variant}
      size={size}
      icon={icon}
      disabled={disabled}
      aria-live="polite"
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
