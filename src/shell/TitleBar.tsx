// The window's own title bar: ParaForge's name, the File / Edit / View / Go / Help menus and the
// window buttons. The rest of the bar drags the window; a double click maximises it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "../assets/brand/logo.png";

export type MenuItem =
  | { label: string; keys?: string; run: () => void; disabled?: boolean; checked?: boolean }
  | "separator";

export type MenuDef = {
  id: string;
  label: string;
  /** The letter that opens the menu with Alt, shown underlined. */
  mnemonic: string;
  /** Built when the menu opens, so enabled and checked states are current. `target` is the
   * element that had focus before the menu opened (the field Edit acts on). */
  items: (target: Element | null) => MenuItem[];
};

type Win = ReturnType<typeof getCurrentWindow>;

function appWindow(): Win | null {
  try {
    return getCurrentWindow();
  } catch {
    // Outside the desktop app (a browser preview) there is no window to control.
    return null;
  }
}

export function TitleBar({ menus }: { menus: MenuDef[] }) {
  const win = useRef<Win | null>(null);
  const [maximised, setMaximised] = useState(false);

  useEffect(() => {
    win.current = appWindow();
    const w = win.current;
    if (!w) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    const read = () => w.isMaximized().then((m) => !gone && setMaximised(m)).catch(() => {});
    read();
    w.onResized(read)
      .then((u) => {
        if (!gone) unlisten = u;
        else
          try {
            u();
          } catch {
            // The window is already gone.
          }
      })
      .catch(() => {});
    return () => {
      gone = true;
      try {
        unlisten?.();
      } catch {
        // The window is already gone.
      }
    };
  }, []);

  const act = (f: (w: Win) => Promise<void>) => {
    const w = win.current;
    if (w) f(w).catch(() => {});
  };

  return (
    <div className="pf-titlebar" data-tauri-drag-region>
      <img className="pf-titlebar__logo" src={logo} alt="" draggable={false} data-tauri-drag-region />
      <MenuBar menus={menus} />
      <span className="pf-titlebar__name" data-tauri-drag-region>
        ParaForge
      </span>
      <div className="pf-titlebar__controls">
        <button
          type="button"
          className="pf-winbtn"
          aria-label="Minimise"
          data-tip="Minimise"
          onClick={() => act((w) => w.minimize())}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pf-winbtn"
          aria-label={maximised ? "Restore" : "Maximise"}
          data-tip={maximised ? "Restore" : "Maximise"}
          onClick={() => act((w) => w.toggleMaximize())}
        >
          {maximised ? <Copy size={14} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="pf-winbtn pf-winbtn--close"
          aria-label="Close"
          data-tip="Close"
          onClick={() => act((w) => w.close())}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Closes ParaForge's window (File > Exit). */
export function closeWindow() {
  appWindow()
    ?.close()
    .catch(() => {});
}

function MenuBar({ menus }: { menus: MenuDef[] }) {
  // The open menu, and whether it was opened from the keyboard (its first item then takes focus).
  const [open, setOpen] = useState<{ id: string; keyboard: boolean } | null>(null);
  // Roving focus between the menu titles.
  const [current, setCurrent] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  // What had focus before the menus were used, to give it back when they close (null when the
  // menus were reached by tabbing to a title).
  const origin = useRef<HTMLElement | null>(null);

  const titleButton = (i: number) => bar.current?.querySelectorAll<HTMLElement>("[data-menu-title]")[i] ?? null;

  const openMenu = useCallback(
    (i: number, keyboard: boolean) => {
      // A modal dialog owns the screen; the menus wait until it closes.
      if (document.querySelector(".pf-modal")) return;
      if (!open) {
        const a = document.activeElement;
        origin.current = a instanceof HTMLElement && a !== document.body && !bar.current?.contains(a) ? a : null;
      }
      setCurrent(i);
      setOpen({ id: menus[i].id, keyboard });
    },
    [menus, open],
  );

  /** "back": to where focus was before (or the menu title, when the menus were reached by Tab). */
  const close = useCallback(
    (refocus: "back" | "none") => {
      setOpen(null);
      if (refocus === "back") {
        if (origin.current?.isConnected) origin.current.focus();
        else titleButton(current)?.focus();
      }
      origin.current = null;
    },
    [current],
  );

  // Alt + the underlined letter opens that menu from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const i = menus.findIndex((m) => m.mnemonic.toLowerCase() === e.key.toLowerCase());
      if (i < 0 || document.querySelector(".pf-modal")) return;
      e.preventDefault();
      openMenu(i, true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menus, openMenu]);

  const onBarKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (open) return;
    const i = current;
    const move = (to: number) => {
      e.preventDefault();
      const n = (to + menus.length) % menus.length;
      setCurrent(n);
      titleButton(n)?.focus();
    };
    if (e.key === "ArrowRight") move(i + 1);
    else if (e.key === "ArrowLeft") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(menus.length - 1);
    else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu(i, true);
    }
  };

  const openIndex = open ? menus.findIndex((m) => m.id === open.id) : -1;

  return (
    <div ref={bar} className="pf-menubar" role="menubar" aria-label="Main menu" onKeyDown={onBarKey}>
      {menus.map((m, i) => (
        <button
          key={m.id}
          type="button"
          role="menuitem"
          data-menu-title
          className="pf-menubar__title"
          aria-haspopup="menu"
          aria-expanded={openIndex === i}
          aria-keyshortcuts={`Alt+${m.mnemonic.toUpperCase()}`}
          tabIndex={i === current ? 0 : -1}
          onMouseDown={(e) => {
            // Opening by mouse keeps focus where it was, so Edit acts on the field in use.
            e.preventDefault();
            if (openIndex === i) close("none");
            else openMenu(i, false);
          }}
          onClick={(e) => {
            // Only the keyboard's Enter or Space lands here (the mouse is handled on press).
            if (e.detail === 0) openMenu(i, true);
          }}
          onMouseEnter={() => open && openIndex !== i && openMenu(i, open.keyboard)}
        >
          <Mnemonic label={m.label} letter={m.mnemonic} />
        </button>
      ))}
      {open && openIndex >= 0 && (
        <MenuPopup
          key={open.id}
          def={menus[openIndex]}
          target={origin.current}
          anchor={titleButton(openIndex)}
          keyboard={open.keyboard}
          onClose={close}
          onStep={(dir) => openMenu((openIndex + dir + menus.length) % menus.length, true)}
        />
      )}
    </div>
  );
}

function Mnemonic({ label, letter }: { label: string; letter: string }) {
  const i = label.toLowerCase().indexOf(letter.toLowerCase());
  if (i < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, i)}
      <span className="pf-mnemonic">{label[i]}</span>
      {label.slice(i + 1)}
    </>
  );
}

function MenuPopup(props: {
  def: MenuDef;
  /** The element the menu acts on (the field in use), for Edit. */
  target: Element | null;
  anchor: HTMLElement | null;
  keyboard: boolean;
  onClose: (refocus: "back" | "none") => void;
  onStep: (dir: 1 | -1) => void;
}) {
  // Built once per opening, so the states shown match what the items do.
  const [items] = useState(() => props.def.items(props.target));
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const enabled = items.flatMap((it, i) => (it !== "separator" && !it.disabled ? [i] : []));
  const [active, setActive] = useState(props.keyboard ? (enabled[0] ?? -1) : -1);
  // Focus moves into the menu only once the keyboard is used; hovering just highlights.
  const [keyboard, setKeyboard] = useState(props.keyboard);
  const { onClose, onStep } = props;

  // The key handler reads the latest state through a ref, so it is registered once.
  const live = useRef({ active, enabled, items });
  live.current = { active, enabled, items };

  useLayoutEffect(() => {
    if (!props.anchor || !box.current) return;
    const a = props.anchor.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    setPos({ left: Math.min(a.left, window.innerWidth - b.width - 8), top: a.bottom + 4 });
  }, [props.anchor]);

  useEffect(() => {
    if (!keyboard || active < 0) return;
    box.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active, keyboard]);

  const run = useCallback(
    (item: Exclude<MenuItem, "separator">) => {
      if (item.disabled) return;
      // Focus goes back first, so Edit commands act on the field that was in use.
      onClose("back");
      item.run();
    },
    [onClose],
  );

  useEffect(() => {
    const away = (e: Event) => {
      if (e.target instanceof Node && (box.current?.contains(e.target) || props.anchor?.contains(e.target))) return;
      // A click elsewhere moves focus itself; a blur or resize leaves it where it was.
      onClose("none");
    };
    // The menu's keys work wherever focus is (a menu opened by mouse leaves it in the field).
    // Only the keys the menu uses are stopped; the rest reach the app's own shortcuts.
    const onKey = (e: KeyboardEvent) => {
      const { active: at, enabled: on, items: list } = live.current;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const go = (i: number | undefined) => {
        setKeyboard(true);
        if (i !== undefined) setActive(i);
      };
      const pos = on.indexOf(at);
      switch (e.key) {
        case "Escape":
          take();
          onClose("back");
          break;
        case "ArrowDown":
          take();
          go(on[pos < 0 ? 0 : (pos + 1) % on.length]);
          break;
        case "ArrowUp":
          take();
          go(on[pos < 0 ? on.length - 1 : (pos - 1 + on.length) % on.length]);
          break;
        case "Home":
          take();
          go(on[0]);
          break;
        case "End":
          take();
          go(on[on.length - 1]);
          break;
        case "ArrowRight":
        case "ArrowLeft":
          take();
          onStep(e.key === "ArrowRight" ? 1 : -1);
          break;
        case "Tab":
          take();
          onClose("back");
          break;
        case "Enter":
        case " ": {
          const item = list[at];
          // A focused item runs from its own click; this covers a highlighted one without focus.
          if (item && item !== "separator" && !box.current?.contains(document.activeElement)) {
            take();
            run(item);
          }
          break;
        }
      }
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [onClose, onStep, run, props.anchor]);

  return createPortal(
    <div
      ref={box}
      className="pf-menu pf-menu--bar"
      role="menu"
      aria-label={props.def.label}
      style={pos ?? { left: -9999, top: -9999 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={`sep-${i}`} className="pf-menu__sep" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            data-index={i}
            data-active={i === active || undefined}
            className="pf-menu__item"
            tabIndex={i === active ? 0 : -1}
            onMouseEnter={() => !item.disabled && setActive(i)}
            onClick={() => run(item)}
          >
            <span className="pf-menu__check" aria-hidden="true">
              {item.checked && <Check size={16} strokeWidth={3} />}
            </span>
            <span>{item.label}</span>
            {item.keys ? <kbd>{item.keys}</kbd> : <span />}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
