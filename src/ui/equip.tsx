// The Equip button: puts an owned copy in a character's hands through Bungie, and can switch its
// perks to a god roll first. Bungie needs the "Move or equip Destiny gear" permission for this.
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Swords } from "lucide-react";
import { KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Character, EquipOutcome } from "../app/api";
import { useSession } from "../app/session";
import { useToast } from "./feedback";
import { BungieImage } from "./weapon";

const SCOPE_HINT = "Move or equip Destiny gear";

function outcomeText(o: EquipOutcome, switching: boolean): string {
  if (o.steps === 0) {
    return switching
      ? `Already equipped on your ${o.character} with this roll's perks.`
      : `Already equipped on your ${o.character}.`;
  }
  const parts = [o.equipped ? `Equipped on your ${o.character}.` : `Moved to your ${o.character}.`];
  if (o.perks_switched > 0) parts.push(`Switched ${o.perks_switched} ${o.perks_switched === 1 ? "perk" : "perks"}.`);
  if (o.perks_missing > 0) {
    parts.push(
      `${o.perks_missing} ${o.perks_missing === 1 ? "column has" : "columns have"} none of this roll's perks on this copy.`,
    );
  }
  return parts.join(" ");
}

export function EquipButton(props: {
  instanceId: string;
  /** Per perk column, the wanted perks best first; empty columns are left alone. Omit to only equip. */
  perks?: number[][];
  /** Button text; "Equip" by default. */
  label?: string;
  small?: boolean;
  /** Also says which weapon, for screen readers, for example "Equip Fatebringer with this roll". */
  ariaLabel?: string;
}) {
  const session = useSession();
  const toast = useToast();
  const characters = session.info?.characters ?? [];
  const signedIn = Boolean(session.auth?.signed_in);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const switching = (props.perks ?? []).some((c) => c.length > 0);

  const blocked = !signedIn
    ? "Sign in to Bungie in Settings first."
    : characters.length === 0
      ? "Sync once so ParaForge knows your characters."
      : null;
  const tip =
    blocked ??
    (switching
      ? "Switch this copy's perks to this roll where it has them, and equip it"
      : "Equip this copy, moving it from the vault or another character if needed");

  async function run(character: Character) {
    setOpen(false);
    setBusy(true);
    try {
      const outcome = await invoke<EquipOutcome>("equip_copy", {
        instanceId: props.instanceId,
        characterId: character.id,
        perks: props.perks ?? [],
        equip: true,
      });
      toast({ tone: "success", text: outcomeText(outcome, switching) });
      // Where the weapon is and which perks it shows changed in the game; read them again.
      if (outcome.steps > 0) void session.syncQuietly();
    } catch (e) {
      const text = String(e);
      toast({
        tone: "error",
        text,
        action: text.includes(SCOPE_HINT)
          ? { label: "Open Bungie apps", run: () => void invoke("open_bungie_apps").catch(() => {}) }
          : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`pf-btn${props.small ? " pf-btn--small" : ""} pf-equip`}
        aria-disabled={blocked || busy ? true : undefined}
        aria-haspopup={characters.length > 1 ? "menu" : undefined}
        aria-expanded={characters.length > 1 ? open : undefined}
        aria-controls={open ? menuId : undefined}
        aria-label={props.ariaLabel}
        data-tip={busy ? "Talking to Bungie" : tip}
        onClick={() => {
          if (blocked) {
            toast({ tone: "info", text: blocked });
            return;
          }
          if (busy) return;
          if (characters.length === 1) void run(characters[0]);
          else setOpen(!open);
        }}
      >
        {busy ? <Loader2 size={14} className="pf-spin" aria-hidden="true" /> : <Swords size={14} aria-hidden="true" />}
        {busy ? "Equipping..." : (props.label ?? "Equip")}
      </button>
      {open && (
        <CharacterMenu
          id={menuId}
          anchor={button.current}
          characters={characters}
          onPick={run}
          onClose={(back) => {
            setOpen(false);
            if (back) button.current?.focus();
          }}
        />
      )}
    </>
  );
}

function CharacterMenu(props: {
  id: string;
  anchor: HTMLElement | null;
  characters: Character[];
  onPick: (c: Character) => void;
  onClose: (focusBack: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { anchor, onClose } = props;

  // Under the button, kept inside the window.
  useLayoutEffect(() => {
    if (!anchor || !menu.current) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8));
    const below = a.bottom + 4;
    const top = below + m.height > window.innerHeight - 8 ? Math.max(8, a.top - m.height - 4) : below;
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(false);
    };
    const gone = () => onClose(false);
    document.addEventListener("mousedown", away, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      document.removeEventListener("mousedown", away, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    };
  }, [anchor, onClose]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    // The page's own shortcuts must not act while the menu has the keyboard.
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(items.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      onClose(true);
    }
  }

  return createPortal(
    <div
      ref={menu}
      id={props.id}
      className="pf-menu pf-equip__menu"
      role="menu"
      aria-label="Equip on"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      onKeyDown={onKey}
    >
      <span className="pf-equip__menuhead" aria-hidden="true">
        Equip on
      </span>
      {props.characters.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className="pf-menu__item pf-equip__char"
          onClick={() => props.onPick(c)}
        >
          <span className="pf-equip__emblem">{c.emblem && <BungieImage path={c.emblem} />}</span>
          <span>{c.class}</span>
          <span className="pf-equip__light">{c.light}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
