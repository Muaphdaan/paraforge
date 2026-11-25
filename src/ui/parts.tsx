// Small shared pieces of the design system.
import { KeyboardEvent, ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Diamond,
  LucideIcon,
  Sparkle as SparkleIcon,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Verdict } from "../app/api";
import { MASCOT, MascotPose } from "./mascot";

/** The pink four-point sparkle next to page titles. Decorative. */
export function Sparkle({ size = 20 }: { size?: number }) {
  return <SparkleIcon className="pf-sparkle" size={size} fill="currentColor" aria-hidden="true" />;
}

export function Mascot({ pose, className }: { pose: MascotPose; className?: string }) {
  return <img className={className} src={MASCOT[pose]} alt="" draggable={false} />;
}

export function EmptyState(props: {
  pose: MascotPose;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="pf-empty">
      <Mascot pose={props.pose} className="pf-empty__mascot" />
      <h2 className="pf-empty__title">{props.title}</h2>
      {props.children && <p className="pf-empty__text">{props.children}</p>}
      {props.action && <div className="pf-empty__action">{props.action}</div>}
    </div>
  );
}

const BANNER_ICONS: Record<"error" | "warn" | "info", LucideIcon> = {
  error: CircleAlert,
  warn: TriangleAlert,
  info: CircleCheck,
};

/** A condition that lasts, such as a failed sync or a sign-in that ran out. */
export function Banner(props: {
  tone: "error" | "warn" | "info";
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = BANNER_ICONS[props.tone];
  return (
    <div className={`pf-banner pf-banner--${props.tone}`} role={props.tone === "error" ? "alert" : "status"}>
      <Icon size={20} aria-hidden="true" />
      <div className="pf-banner__text">{props.children}</div>
      {props.action}
      {props.onDismiss && (
        <button type="button" className="pf-iconbtn pf-iconbtn--plain" onClick={props.onDismiss} title="Dismiss">
          <X size={16} aria-hidden="true" />
          <span className="pf-visually-hidden">Dismiss</span>
        </button>
      )}
    </div>
  );
}

const VERDICTS: Record<Verdict, { label: string; icon: LucideIcon }> = {
  keep: { label: "KEEP", icon: CircleCheck },
  upgrade: { label: "UPGRADE", icon: ArrowUp },
  replace: { label: "REPLACE", icon: ArrowLeftRight },
  shard: { label: "SHARD", icon: Diamond },
};

/** Verdicts always pair an icon with the word, never colour alone. */
export function VerdictPill({ verdict }: { verdict: Verdict }) {
  const { label, icon: Icon } = VERDICTS[verdict];
  return (
    <span className={`pf-verdict pf-verdict--${verdict}`}>
      <Icon size={14} strokeWidth={2.5} aria-hidden="true" />
      {label}
    </span>
  );
}

export function TierPill({ tier }: { tier: number }) {
  return tier > 0 ? (
    <span className="pf-tier" title={`Tier ${tier}`}>
      T{tier}
    </span>
  ) : (
    <span className="pf-tier pf-muted" title="No tier">
      -
    </span>
  );
}

/** A pill dropdown with a keyboard-friendly list (arrows, Enter, Esc). */
export function Dropdown<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = props.options.find((o) => o.value === props.value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  function show() {
    setActive(Math.max(0, props.options.findIndex((o) => o.value === props.value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = props.options[index];
    if (option) props.onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(props.options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="pf-dropdown" ref={root}>
      <button
        type="button"
        className="pf-btn pf-dropdown__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${props.label}: ${current?.label ?? ""}`}
        disabled={props.disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        {current?.label}
        <ChevronDown className="pf-dropdown__chevron" size={18} aria-hidden="true" />
      </button>
      {open && (
        <ul className="pf-dropdown__menu" role="listbox" id={listId} aria-label={props.label}>
          {props.options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === props.value}
              data-active={i === active}
              className="pf-dropdown__option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              {o.label}
              {o.value === props.value && <Check className="pf-dropdown__check" size={16} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An on/off switch with a label and an optional description. */
export function Toggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const descId = useId();
  return (
    <label className="pf-toggle" data-disabled={props.disabled || undefined}>
      <input
        type="checkbox"
        role="switch"
        className="pf-toggle__input"
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.description ? descId : undefined}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="pf-toggle__track" aria-hidden="true">
        <span className="pf-toggle__thumb" />
      </span>
      <span className="pf-toggle__text">
        <span className="pf-toggle__label">{props.label}</span>
        {props.description && (
          <span className="pf-toggle__desc" id={descId}>
            {props.description}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * Copies text to the clipboard and reports how it went for 2 seconds: "copied" or "failed"
 * (the clipboard can be blocked), then "idle" again. Each press restarts the 2 seconds.
 */
export function useCopy(): [state: "idle" | "copied" | "failed", copy: (text: string) => void] {
  const [result, setResult] = useState<{ state: "idle" | "copied" | "failed"; at: number }>({ state: "idle", at: 0 });
  useEffect(() => {
    if (result.state === "idle") return;
    const t = window.setTimeout(() => setResult({ state: "idle", at: 0 }), 2000);
    return () => window.clearTimeout(t);
  }, [result]);
  const copy = useCallback((text: string) => {
    const done = (state: "copied" | "failed") => setResult({ state, at: performance.now() });
    try {
      navigator.clipboard.writeText(text).then(
        () => done("copied"),
        () => done("failed"),
      );
    } catch {
      done("failed");
    }
  }, []);
  return [result.state, copy];
}

/** A read-only value with a Copy button, for things like the redirect URL. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [state, copy] = useCopy();
  const id = useId();
  return (
    <div className="pf-field">
      <label className="pf-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pf-copyfield">
        <input id={id} className="pf-input" value={value} readOnly onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="pf-btn pf-btn--small" onClick={() => copy(value)}>
          {state === "copied" ? <Check size={14} aria-hidden="true" /> : null}
          <span role="status">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed, select and copy" : "Copy"}</span>
        </button>
      </div>
    </div>
  );
}
