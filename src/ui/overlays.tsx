// ParaForge's own hover boxes and right-click menu, in place of the ones Windows draws, plus a
// guard against browser keys (find, print, save...) that would open the web view's own windows.
//
// Any element with `data-tip="..."` gets a themed tooltip on hover (after a short pause) and on
// keyboard focus. A first line followed by more lines shows as a bold title and a description.
import { KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const SHOW_DELAY_MS = 400;
const GAP = 8;
const EDGE = 8;

type Tip = { anchor: HTMLElement; text: string };

function tipTarget(el: Element | null): HTMLElement | null {
  const found = el?.closest<HTMLElement>("[data-tip]");
  return found && found.dataset.tip ? found : null;
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ tip: Tip; left: number; top: number; below: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = useRef<Tip | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const point = useRef<{ x: number; y: number } | null>(null);
  current.current = tip;

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      setTip(null);
    };
    const showSoon = (anchor: HTMLElement) => {
      window.clearTimeout(timer.current);
      // Moving between items while a tip is up swaps it at once, like the game's own tooltips.
      const delay = current.current ? 0 : SHOW_DELAY_MS;
      timer.current = window.setTimeout(() => {
        if (anchor.isConnected && anchor.dataset.tip) setTip({ anchor, text: anchor.dataset.tip });
      }, delay);
    };
    // The element under the pointer, found from its position so disabled buttons count too.
    const check = () => {
      frame.current = undefined;
      const p = point.current;
      if (!p) return;
      const anchor = tipTarget(document.elementFromPoint(p.x, p.y));
      const shown = current.current;
      if (anchor && shown?.anchor === anchor) {
        // Same element; its text can change (the sync status, say).
        if (anchor.dataset.tip !== shown.text) setTip({ anchor, text: anchor.dataset.tip ?? "" });
        return;
      }
      if (anchor) showSoon(anchor);
      else if (shown || timer.current !== undefined) hide();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      point.current = { x: e.clientX, y: e.clientY };
      if (frame.current === undefined) frame.current = window.requestAnimationFrame(check);
    };
    const onLeave = () => {
      point.current = null;
      hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const anchor = tipTarget(el);
      if (!anchor || !el?.matches(":focus-visible")) return;
      window.clearTimeout(timer.current);
      setTip({ anchor, text: anchor.dataset.tip ?? "" });
    };
    const onBlur = (e: FocusEvent) => {
      if (current.current && e.target === current.current.anchor) hide();
    };
    // Any key but a bare modifier: a shortcut may swap the page or open the palette under a still
    // mouse. A tip shown by Tab focus comes back on the focusin that follows.
    const onKey = (e: KeyboardEvent) => {
      if (current.current && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) hide();
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("wheel", hide, { passive: true, capture: true });
    document.addEventListener("scroll", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.clearTimeout(timer.current);
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    };
  }, []);

  // Above the element when there is room, otherwise below; always inside the window. Each new tip
  // first renders offscreen, so it is measured at its natural width.
  useLayoutEffect(() => {
    if (!tip || !box.current) {
      setPos(null);
      return;
    }
    if (!tip.anchor.isConnected) {
      setTip(null);
      return;
    }
    const a = tip.anchor.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    const below = a.top - GAP - b.height < EDGE;
    const top = below ? a.bottom + GAP : a.top - GAP - b.height;
    const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - b.width / 2), window.innerWidth - b.width - EDGE);
    setPos({ tip, left, top: Math.min(top, window.innerHeight - b.height - EDGE), below });
  }, [tip]);

  if (!tip) return null;
  const [title, ...rest] = tip.text.split("\n");
  const body = rest.join("\n").trim();
  const placed = pos && pos.tip === tip ? pos : null;
  return createPortal(
    <div
      ref={box}
      className="pf-tooltip"
      role="tooltip"
      data-placed={placed ? (placed.below ? "below" : "above") : undefined}
      style={placed ? { left: placed.left, top: placed.top } : { left: -9999, top: -9999 }}
    >
      {body ? (
        <>
          <strong className="pf-tooltip__title">{title}</strong>
          <span className="pf-tooltip__body">{body}</span>
        </>
      ) : (
        title
      )}
    </div>,
    document.body,
  );
}

// ---- Right-click menu ----

type MenuItem = { label: string; icon: LucideIcon; keys: string; run: () => void };

function editable(el: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && ["text", "search", "password", "url", "email", "number", ""].includes(el.type)) {
    return el;
  }
  return null;
}

function itemsFor(target: Element | null): MenuItem[] {
  const field = editable(target);
  const selected = field
    ? (field.selectionStart ?? 0) !== (field.selectionEnd ?? 0)
    : Boolean(window.getSelection()?.toString());
  const items: MenuItem[] = [];
  const refocus = () => field?.focus();
  if (field && !field.readOnly && !field.disabled && selected && field.type !== "password") {
    items.push({ label: "Cut", icon: Scissors, keys: "Ctrl+X", run: () => (refocus(), document.execCommand("cut")) });
  }
  if (selected && field?.type !== "password") {
    items.push({ label: "Copy", icon: Copy, keys: "Ctrl+C", run: () => (refocus(), document.execCommand("copy")) });
  }
  if (field && !field.readOnly && !field.disabled) {
    items.push({
      label: "Paste",
      icon: ClipboardPaste,
      keys: "Ctrl+V",
      run: () => {
        refocus();
        // insertText keeps undo and tells React about the change.
        navigator.clipboard
          .readText()
          .then((text) => document.execCommand("insertText", false, text))
          .catch(() => document.execCommand("paste"));
      },
    });
  }
  if (field) {
    items.push({ label: "Select all", icon: TextSelect, keys: "Ctrl+A", run: () => (refocus(), field.select()) });
  }
  return items;
}

export function ContextMenu() {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    keyboard: boolean;
    /** What had focus when the menu opened, to give focus back when it closes. */
    origin: HTMLElement | null;
  } | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      // Never the web view's own menu (Back, Refresh, Print, Inspect...).
      e.preventDefault();
      const items = itemsFor(e.target instanceof Element ? e.target : null);
      if (items.length === 0) {
        setMenu(null);
        return;
      }
      // Opened from the keyboard (menu key, Shift+F10): place it at the focused element.
      const keyboard = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
      let { clientX: x, clientY: y } = e;
      if (keyboard && e.target instanceof Element) {
        const r = e.target.getBoundingClientRect();
        x = r.left + 12;
        y = r.bottom;
      }
      setActive(0);
      const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenu({ x, y, items, keyboard, origin });
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      setMenu(null);
    };
    // Escape closes only the menu: the field and the palette under it never see the key.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !box.current) {
      setPos(null);
      return;
    }
    const b = box.current.getBoundingClientRect();
    setPos({
      left: Math.min(menu.x, window.innerWidth - b.width - EDGE),
      top: menu.y + b.height > window.innerHeight - EDGE ? Math.max(EDGE, menu.y - b.height) : menu.y,
    });
    if (!menu.keyboard) return;
    const el = box.current;
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      // Closed without an item moving focus (Escape, outside click, scroll, blur): give it back.
      const a = document.activeElement;
      const origin = menu.origin;
      if (origin?.isConnected && (a === null || a === document.body || el.contains(a))) origin.focus();
    };
  }, [menu]);

  if (!menu) return null;
  const run = (item: MenuItem) => {
    setMenu(null);
    item.run();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const last = menu.items.length - 1;
    const next =
      e.key === "ArrowDown" ? (active + 1) % (last + 1) : e.key === "ArrowUp" ? (active - 1 + last + 1) % (last + 1) : -1;
    if (next >= 0) {
      e.preventDefault();
      setActive(next);
      box.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[next]?.focus();
    } else if (e.key === "Tab") {
      // Tab leaves the menu, back to where focus was.
      e.preventDefault();
      setMenu(null);
    }
  };
  return createPortal(
    <div
      ref={box}
      className="pf-menu"
      role="menu"
      aria-label="Edit"
      style={pos ?? { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
      // Clicks keep focus (and the selection) in the field the menu acts on.
      onMouseDown={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="pf-menu__item"
            tabIndex={i === active ? 0 : -1}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(item)}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{item.label}</span>
            <kbd>{item.keys}</kbd>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * Keys that would open the web view's own windows or bars (find, print, save, source, downloads,
 * history, caret browsing). ParaForge has its own search on Ctrl+K.
 */
export function useBrowserKeyGuard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const blocked =
        e.key === "F3" ||
        e.key === "F7" ||
        (ctrl && !e.shiftKey && ["f", "g", "p", "s", "u", "j", "h", "o", "d", "n", "t"].includes(k)) ||
        (ctrl && e.shiftKey && ["o", "delete", "p", "s", "a", "m"].includes(k));
      if (blocked) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
