// Ctrl+K: find any weapon you own by name, type or perk and open its page; weapons you don't own
// open in the Codex.
import { Fragment, KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { CodexRow, VaultRow } from "../app/api";
import { useCodex } from "../app/codex";
import { useSession } from "../app/session";
import { VerdictPill } from "../ui/parts";
import { BungieImage, ElementIcon } from "../ui/weapon";

const MAX_RESULTS = 30;
/** Codex results come after your own weapons, and only once something is typed. */
const MAX_CODEX = 10;

type Hit = { row: VaultRow; copies: number; perkMatch: string | null };
type Item = { kind: "owned"; hit: Hit } | { kind: "codex"; row: CodexRow };

export function SearchPalette(props: {
  open: boolean;
  onClose: () => void;
  onOpenWeapon: (instanceId: string) => void;
  onOpenInCodex: (hash: number) => void;
}) {
  const session = useSession();
  const codex = useCodex();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Focus the input on open; give focus back to whatever had it on close.
  useEffect(() => {
    if (!props.open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => input.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      if (opener?.isConnected) opener.focus();
    };
  }, [props.open]);

  const hits = useMemo<Hit[]>(() => {
    const rows = session.vault ?? [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    // One line per weapon: its best matching copy (vault rows come best first), with how many you own.
    const owned = new Map<number, number>();
    for (const row of rows) owned.set(row.weapon, (owned.get(row.weapon) ?? 0) + 1);
    const best = new Map<number, Hit>();
    for (const row of rows) {
      if (best.has(row.weapon)) continue;
      let perkMatch: string | null = null;
      const ok = words.every((w) => {
        if (row.name.toLowerCase().includes(w) || row.type_name.toLowerCase().includes(w)) return true;
        for (const col of row.columns) {
          for (const h of col.options) {
            const name = session.perks[h]?.name;
            if (name && name.toLowerCase().includes(w)) {
              perkMatch = name;
              return true;
            }
          }
        }
        return false;
      });
      if (ok) best.set(row.weapon, { row, copies: owned.get(row.weapon) ?? 1, perkMatch });
    }
    return [...best.values()].slice(0, MAX_RESULTS);
  }, [session.vault, session.perks, query]);

  const items = useMemo<Item[]>(() => {
    const owned: Item[] = hits.map((hit) => ({ kind: "owned", hit }));
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return owned;
    // Name matches first (names that start with the search before the rest), then type or source matches.
    const ranked: { row: CodexRow; rank: number }[] = [];
    const first = words[0];
    for (const row of codex.rows ?? []) {
      if (row.owned > 0) continue;
      const name = row.name.toLowerCase();
      const text = `${name} ${row.type_name} ${row.look.source}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
      ranked.push({ row, rank: name.startsWith(first) ? 0 : words.every((w) => name.includes(w)) ? 1 : 2 });
    }
    ranked.sort((a, b) => a.rank - b.rank);
    const extra: Item[] = ranked.slice(0, MAX_CODEX).map(({ row }) => ({ kind: "codex", row }));
    return [...owned, ...extra];
  }, [hits, codex.rows, query]);

  // A new search starts at the top; a shorter list never leaves the highlight past its end.
  useEffect(() => setActive(0), [query]);
  useEffect(() => setActive((a) => (a < 0 || a >= items.length ? 0 : a)), [items]);
  useEffect(() => {
    if (!props.open) return;
    list.current?.querySelector(`[id="${CSS.escape(`${listId}-${active}`)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [props.open, active, listId]);

  if (!props.open) return null;

  function choose(item: Item | undefined) {
    if (!item) return;
    props.onClose();
    if (item.kind === "owned") props.onOpenWeapon(item.hit.row.instance_id);
    else props.onOpenInCodex(item.row.hash);
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Tab") {
      // The input is the only stop in the dialog.
      e.preventDefault();
      input.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(items.length - 1, a + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <div className="pf-palette" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        className="pf-palette__box"
        role="dialog"
        aria-modal="true"
        aria-label="Search weapons and perks"
        onKeyDown={onKey}
        // Clicks inside keep focus in the input, so the arrow keys keep working.
        onMouseDown={(e) => e.target !== input.current && e.preventDefault()}
      >
        <div className="pf-palette__input">
          <Search size={20} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            aria-label="Search weapons and perks"
            placeholder="Search weapons, types and perks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="pf-palette__list" role="listbox" id={listId} ref={list}>
          {items.length === 0 ? (
            <li className="pf-palette__empty">
              {session.vault === null
                ? session.vaultError
                  ? "Your vault could not be read."
                  : "Loading your vault..."
                : query
                  ? "No weapon matches that."
                  : "Your vault is empty. Sync first."}
            </li>
          ) : (
            items.map((item, i) => {
              const first = item.kind === "codex" && items[i - 1]?.kind !== "codex";
              const itemProps = {
                id: `${listId}-${i}`,
                role: "option" as const,
                "aria-selected": i === active,
                className: "pf-palette__item",
                onMouseMove: () => setActive(i),
                onClick: () => choose(item),
              };
              const row = item.kind === "owned" ? item.hit.row : item.row;
              return (
                <Fragment key={`${item.kind}-${item.kind === "owned" ? item.hit.row.weapon : item.row.hash}`}>
                  {first && (
                    <li className="pf-palette__heading" role="presentation">
                      Not owned, in the Codex
                    </li>
                  )}
                  <li {...itemProps}>
                    <span className="pf-wrow__icon" data-rarity={row.look.rarity}>
                      <span className="pf-tile__fallback" aria-hidden="true">
                        {row.name.slice(0, 1)}
                      </span>
                      <BungieImage path={row.look.icon} className="pf-tile__icon" />
                    </span>
                    <span className="pf-wrow__name">
                      <strong>{row.name}</strong>
                      <span className="pf-muted">
                        <ElementIcon damage={row.look.damage} size={12} /> {row.type_name}
                        {item.kind === "owned" && item.hit.copies > 1 && ` · ${item.hit.copies} copies`}
                        {item.kind === "owned" && item.hit.perkMatch && ` · ${item.hit.perkMatch}`}
                        {item.kind === "codex" && row.look.source && ` · ${row.look.source}`}
                      </span>
                    </span>
                    {item.kind === "owned" ? (
                      <>
                        <span className={`pf-wrow__score pf-v--${item.hit.row.score?.verdict ?? "none"}`}>
                          {item.hit.row.score ? item.hit.row.score.score.toFixed(0) : "-"}
                        </span>
                        {item.hit.row.score && <VerdictPill verdict={item.hit.row.score.verdict} />}
                      </>
                    ) : (
                      <>
                        <span />
                        <span className="pf-palette__tag">Codex</span>
                      </>
                    )}
                  </li>
                </Fragment>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
