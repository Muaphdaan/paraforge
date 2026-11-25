// Ctrl+K: find any weapon you own by name, type or perk, and open its page.
import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { VaultRow } from "../app/api";
import { useSession } from "../app/session";
import { VerdictPill } from "../ui/parts";
import { BungieImage, ElementIcon } from "../ui/weapon";

const MAX_RESULTS = 30;

type Hit = { row: VaultRow; copies: number; perkMatch: string | null };

export function SearchPalette(props: { open: boolean; onClose: () => void; onOpenWeapon: (instanceId: string) => void }) {
  const session = useSession();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (props.open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => input.current?.focus(), 0);
    }
  }, [props.open]);

  const hits = useMemo<Hit[]>(() => {
    const rows = session.vault ?? [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    // One line per weapon: its best copy (vault rows come best first).
    const best = new Map<number, Hit>();
    for (const row of rows) {
      const seen = best.get(row.weapon);
      if (seen) {
        seen.copies += 1;
        continue;
      }
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
      if (ok) best.set(row.weapon, { row, copies: 1, perkMatch });
    }
    return [...best.values()].slice(0, MAX_RESULTS);
  }, [session.vault, session.perks, query]);

  useEffect(() => setActive(0), [query]);

  if (!props.open) return null;

  function choose(hit: Hit | undefined) {
    if (!hit) return;
    props.onClose();
    props.onOpenWeapon(hit.row.instance_id);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(hits[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <div className="pf-palette" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="pf-palette__box" role="dialog" aria-modal="true" aria-label="Search weapons and perks">
        <div className="pf-palette__input">
          <Search size={20} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
            aria-label="Search weapons and perks"
            placeholder="Search weapons, types and perks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="pf-palette__list" role="listbox" id={listId}>
          {session.vault === null ? (
            <li className="pf-palette__empty">Loading your vault...</li>
          ) : hits.length === 0 ? (
            <li className="pf-palette__empty">{query ? "No weapon you own matches that." : "Your vault is empty. Sync first."}</li>
          ) : (
            hits.map((hit, i) => (
              <li
                key={hit.row.weapon}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="pf-palette__item"
                onMouseMove={() => setActive(i)}
                onClick={() => choose(hit)}
              >
                <span className="pf-wrow__icon" data-rarity={hit.row.look.rarity}>
                  <span className="pf-tile__fallback" aria-hidden="true">
                    {hit.row.name.slice(0, 1)}
                  </span>
                  <BungieImage path={hit.row.look.icon} className="pf-tile__icon" />
                </span>
                <span className="pf-wrow__name">
                  <strong>{hit.row.name}</strong>
                  <span className="pf-muted">
                    <ElementIcon damage={hit.row.look.damage} size={12} /> {hit.row.type_name}
                    {hit.copies > 1 && ` · ${hit.copies} copies`}
                    {hit.perkMatch && ` · ${hit.perkMatch}`}
                  </span>
                </span>
                <span className={`pf-wrow__score pf-v--${hit.row.score?.verdict ?? "none"}`}>
                  {hit.row.score ? hit.row.score.score.toFixed(0) : "-"}
                </span>
                {hit.row.score && <VerdictPill verdict={hit.row.score.verdict} />}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
