// Toasts (short notes that fade on their own) and the confirmation dialog, both themed.
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

// ---- Toasts ----

export type ToastTone = "info" | "success" | "error";
export type ToastInput = {
  text: string;
  tone?: ToastTone;
  /** One button on the toast, such as Undo or Review. */
  action?: { label: string; run: () => void };
};
type Toast = ToastInput & { id: number };

const TOAST_MS = 5000;
const TOAST_ACTION_MS = 8000;
const MAX_TOASTS = 3;
const TOAST_ICONS = { info: Info, success: CircleCheck, error: CircleAlert };

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

/** Shows a toast. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((toast: ToastInput) => {
    const id = next.current++;
    setToasts((list) => [...list, { ...toast, id }].slice(-MAX_TOASTS));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {createPortal(
        // Always in the page, so screen readers hear toasts added to it.
        <div className="pf-toasts" role="region" aria-label="Notifications" aria-live="polite">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} dismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const tone = toast.tone ?? "info";
  const Icon = TOAST_ICONS[tone];
  // Hovering or focusing the toast holds it open.
  const [held, setHeld] = useState(false);
  const { id } = toast;
  const onDismiss = () => dismiss(id);
  // Each toast keeps its own timer; other toasts coming and going don't restart it.
  useEffect(() => {
    if (held) return;
    const t = window.setTimeout(() => dismiss(id), toast.action ? TOAST_ACTION_MS : TOAST_MS);
    return () => window.clearTimeout(t);
  }, [held, dismiss, id, toast.action]);
  return (
    <div
      className="pf-toast"
      data-tone={tone}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHeld(false)}
    >
      <Icon size={18} className="pf-toast__icon" aria-hidden="true" />
      <span className="pf-toast__text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="pf-btn pf-btn--small"
          onClick={() => {
            onDismiss();
            toast.action?.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="pf-iconbtn pf-toast__close" onClick={onDismiss} aria-label="Dismiss" data-tip="Dismiss">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// ---- Confirmation dialog ----

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** The label of the button that goes ahead, such as "Mark 3 to shard". */
  confirm: string;
  cancel?: string;
  /** "danger" for steps that throw something away. */
  tone?: "danger" | "primary";
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void; origin: HTMLElement | null };

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

/** Asks the player to confirm a step; resolves true when they go ahead. */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPending((old) => {
          old?.resolve(false);
          return { ...options, resolve, origin };
        });
      }),
    [],
  );
  const close = useCallback(
    (ok: boolean) => {
      if (!pending) return;
      pending.resolve(ok);
      setPending(null);
      // Focus goes back to whatever opened the dialog, if it is still there.
      if (pending.origin?.isConnected) pending.origin.focus();
    },
    [pending],
  );
  const value = useMemo(() => ask, [ask]);
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && <ConfirmDialog options={pending} onClose={close} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const danger = options.tone === "danger";

  // The safe choice has focus first: Cancel for a step that throws something away.
  useEffect(() => {
    (danger ? cancelBtn : confirmBtn).current?.focus();
  }, [danger]);

  // The dialog owns the keyboard wherever focus is: Escape cancels, Tab moves between its two
  // buttons, and the app's shortcuts and menus can't act on the page behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose(false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const other = document.activeElement === cancelBtn.current ? confirmBtn.current : cancelBtn.current;
        other?.focus();
      } else if (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key)) {
        // Copying the dialog's text still works.
        if (!(e.ctrlKey && e.key.toLowerCase() === "c")) e.preventDefault();
        e.stopPropagation();
      } else {
        // Plain keys (K, S, L...) must not reach the page behind either; Enter and Space still
        // press the focused button.
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="pf-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div
        ref={box}
        className="pf-modal__box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={options.body ? bodyId : undefined}
        // A click on the text keeps focus in the dialog.
        tabIndex={-1}
      >
        <h2 id={titleId} className="pf-modal__title">
          {options.title}
        </h2>
        {options.body && (
          <div id={bodyId} className="pf-modal__body">
            {options.body}
          </div>
        )}
        <div className="pf-modal__actions">
          <button ref={cancelBtn} type="button" className="pf-btn" onClick={() => onClose(false)}>
            {options.cancel ?? "Cancel"}
          </button>
          <button
            ref={confirmBtn}
            type="button"
            className={`pf-btn ${danger ? "pf-btn--danger" : "pf-btn--primary"}`}
            onClick={() => onClose(true)}
          >
            {options.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
