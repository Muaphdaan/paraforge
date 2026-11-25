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
  /** Built when the menu opens, so enabled and checked states are current. */
  items: () => MenuItem[];
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
  // What had focus before the menus were used, to give it back when they close.
  const origin = useRef<HTMLElement | null>(null);

  const titleButton = (i: number) => bar.current?.querySelectorAll<HTMLElement>("[data-menu-title]")[i] ?? null;

  const openMenu = useCallback(
    (i: number, keyboard: boolean) => {
      if (!open && !bar.current?.contains(document.activeElement)) {
        origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      setCurrent(i);
      setOpen({ id: menus[i].id, keyboard });
    },
    [menus, open],
  );

  const close = useCallback((refocus: "title" | "origin" | "none") => {
    setOpen(null);
    if (refocus === "title") titleButton(current)?.focus();
    if (refocus === "origin" && origin.current?.isConnected) origin.current.focus();
  }, [current]);

  // Alt + the underlined letter opens that menu from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const i = menus.findIndex((m) => m.mnemonic.toLowerCase() === e.key.toLowerCase());
      if (i < 0) return;
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
  anchor: HTMLElement | null;
  keyboard: boolean;
  onClose: (refocus: "title" | "origin" | "none") => void;
  onStep: (dir: 1 | -1) => void;
}) {
  // Built once per opening, so the states shown match what the items do.
  const [items] = useState(props.def.items);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const enabled = items.flatMap((it, i) => (it !== "separator" && !it.disabled ? [i] : []));
  const [active, setActive] = useState(props.keyboard ? (enabled[0] ?? -1) : -1);
  const { onClose } = props;

  useLayoutEffect(() => {
    if (!props.anchor || !box.current) return;
    const a = props.anchor.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    setPos({ left: Math.min(a.left, window.innerWidth - b.width - 8), top: a.bottom + 4 });
  }, [props.anchor]);

  useEffect(() => {
    if (active < 0) return;
    box.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active]);

  useEffect(() => {
    const away = (e: Event) => {
      if (e.target instanceof Node && (box.current?.contains(e.target) || props.anchor?.contains(e.target))) return;
      onClose("none");
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape closes only the menu; nothing under it sees the key.
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose(props.keyboard ? "title" : "none");
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
  }, [onClose, props.anchor, props.keyboard]);

  const run = (item: Exclude<MenuItem, "separator">) => {
    if (item.disabled) return;
    // Focus goes back first, so Edit commands act on the field that was in use.
    onClose("origin");
    item.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const at = enabled.indexOf(active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (enabled.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(enabled[(at + step + enabled.length) % enabled.length] ?? enabled[0]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? enabled[0] : enabled[enabled.length - 1]);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      props.onStep(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      onClose("origin");
    }
  };

  return createPortal(
    <div
      ref={box}
      className="pf-menu pf-menu--bar"
      role="menu"
      aria-label={props.def.label}
      style={pos ?? { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
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
