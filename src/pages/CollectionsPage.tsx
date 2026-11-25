// Collections: how close you are to owning every Legendary and Exotic weapon, overall and by
// where it drops. A weapon counts as owned while a copy is in your vault or on a character.
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { CodexRow } from "../app/api";
import { useCodex } from "../app/codex";
import { useSession } from "../app/session";
import { Dropdown, EmptyState, Toggle } from "../ui/parts";
import { BungieImage, ElementIcon } from "../ui/weapon";

type SortBy = "closest" | "missing" | "name";
const UNKNOWN = "Other sources";

type Source = { name: string; weapons: CodexRow[]; owned: number };

/** One entry per weapon name, so a reissue or a second version with the same name counts once. */
function distinct(rows: CodexRow[]): CodexRow[] {
  const byName = new Map<string, CodexRow>();
  for (const r of rows) {
    const seen = byName.get(r.name);
    if (!seen || (seen.owned === 0 && r.owned > 0)) byName.set(r.name, r);
  }
  return [...byName.values()];
}

function percent(owned: number, total: number): number {
  return total === 0 ? 0 : Math.round((owned / total) * 100);
}

export function CollectionsPage(props: { onOpenInCodex: (hash: number) => void }) {
  const session = useSession();
  const codex = useCodex();
  const [sort, setSort] = useState<SortBy>("closest");
  const [hideDone, setHideDone] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const sources = useMemo<Source[]>(() => {
    const all = codex.rows ?? [];
    // A name owned in any version counts as owned in every source that has a version of it.
    const best = new Map(distinct(all).map((r) => [r.name, r] as const));
    const groups = new Map<string, CodexRow[]>();
    for (const r of all) {
      const key = r.look.source || UNKNOWN;
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
    return [...groups.entries()].map(([name, rows]) => {
      const weapons = distinct(rows)
        .map((r) => (r.owned > 0 ? r : (best.get(r.name) ?? r)))
        .sort((a, b) => Number(b.owned > 0) - Number(a.owned > 0) || a.name.localeCompare(b.name));
      return { name, weapons, owned: weapons.filter((w) => w.owned > 0).length };
    });
  }, [codex.rows]);

  const totals = useMemo(() => {
    const all = distinct(codex.rows ?? []);
    const count = (rarity: number) => {
      const of = all.filter((w) => w.look.rarity === rarity);
      return { owned: of.filter((w) => w.owned > 0).length, total: of.length };
    };
    return { owned: all.filter((w) => w.owned > 0).length, total: all.length, exotic: count(6), legendary: count(5) };
  }, [codex.rows]);

  const shown = useMemo(() => {
    const list = sources.filter((s) => !hideDone || s.owned < s.weapons.length);
    const last = (s: Source) => (s.name === UNKNOWN ? 1 : 0);
    const sorters: Record<SortBy, (a: Source, b: Source) => number> = {
      closest: (a, b) =>
        b.owned / b.weapons.length - a.owned / a.weapons.length || b.owned - a.owned || a.name.localeCompare(b.name),
      missing: (a, b) => b.weapons.length - b.owned - (a.weapons.length - a.owned) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return list.sort((a, b) => last(a) - last(b) || sorters[sort](a, b));
  }, [sources, sort, hideDone]);

  const current = shown.find((s) => s.name === selected) ?? shown[0] ?? null;

  if (codex.error) {
    return (
      <EmptyState pose="confused" title="Collections could not be read">
        {codex.error}
      </EmptyState>
    );
  }
  if (codex.rows === null) return null;
  if (codex.rows.length === 0) {
    return (
      <EmptyState pose="sleepy" title="Nothing to collect yet">
        Every weapon in the game comes in with your first sync.
      </EmptyState>
    );
  }
  const noSources = sources.length === 1 && sources[0].name === UNKNOWN;

  return (
    <div className="pf-collections">
      <section className="pf-panel pf-collections__summary" aria-label="Overall">
        <div className="pf-collections__big">
          <span className="pf-collections__pct">{percent(totals.owned, totals.total)}%</span>
          <span className="pf-muted">
            {totals.owned} of {totals.total} weapons owned
          </span>
        </div>
        <Meter label="Exotics" owned={totals.exotic.owned} total={totals.exotic.total} tone="exotic" />
        <Meter label="Legendaries" owned={totals.legendary.owned} total={totals.legendary.total} tone="legendary" />
        <p className="pf-muted pf-collections__note">
          A weapon counts as owned while a copy is in your vault or on a character. Versions with the same name count
          once.
        </p>
      </section>

      <section className="pf-panel pf-collections__sources" aria-label="By source">
        <div className="pf-row pf-row--between">
          <h2 className="pf-panel__title">By source</h2>
          <div className="pf-row">
            <Toggle label="Hide complete" checked={hideDone} onChange={setHideDone} />
            <Dropdown
              label="Sort by"
              value={sort}
              options={[
                { value: "closest", label: "Closest to complete" },
                { value: "missing", label: "Most missing" },
                { value: "name", label: "Name" },
              ]}
              onChange={setSort}
            />
          </div>
        </div>
        {noSources && <p className="pf-muted">Sources come in with your next sync.</p>}
        {shown.length > 0 && (
          <ul
            className="pf-sources"
            role="listbox"
            aria-label="Sources"
            onKeyDown={(e) => {
              // One Tab stop for the list; the arrow keys, Home and End move the selection.
              const i = shown.findIndex((s) => s.name === current?.name);
              const last = shown.length - 1;
              const next =
                e.key === "ArrowDown"
                  ? Math.min(i + 1, last)
                  : e.key === "ArrowUp"
                    ? Math.max(i - 1, 0)
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? last
                        : -1;
              if (next < 0) return;
              e.preventDefault();
              setSelected(shown[next].name);
              (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
            }}
          >
            {shown.map((s) => {
              const done = s.owned === s.weapons.length;
              const isCurrent = current?.name === s.name;
              return (
                <li
                  key={s.name}
                  role="option"
                  aria-selected={isCurrent}
                  tabIndex={isCurrent ? 0 : -1}
                  className="pf-source"
                  data-done={done || undefined}
                  onClick={() => setSelected(s.name)}
                >
                  <span className="pf-source__name">
                    {done && <Check size={14} strokeWidth={3} aria-hidden="true" />}
                    {s.name}
                  </span>
                  <span className="pf-source__count">
                    {s.owned}/{s.weapons.length}
                  </span>
                  <span className="pf-source__bar" aria-hidden="true">
                    <span style={{ width: `${percent(s.owned, s.weapons.length)}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {shown.length === 0 && <p className="pf-muted">Every source is complete. Well done, Guardian.</p>}
      </section>

      {current && (
        <section className="pf-panel pf-collections__detail" aria-labelledby="col-detail">
          <div className="pf-row pf-row--between">
            <h2 className="pf-panel__title" id="col-detail">
              {current.name}
            </h2>
            <span className="pf-muted">
              {current.owned} of {current.weapons.length} owned
            </span>
          </div>
          <div className="pf-tiles pf-collections__tiles">
            {current.weapons.map((w) => (
              <button
                key={w.hash}
                type="button"
                className="pf-tile pf-tile--codex"
                data-rarity={w.look.rarity}
                data-owned={w.owned > 0 || undefined}
                aria-label={`${w.name}, ${w.type_name}, ${w.owned > 0 ? "owned" : "not owned"}. Open in the Codex`}
                data-tip={`${w.name}\n${w.look.rarity === 6 ? "Exotic " : ""}${w.type_name} · ${w.owned > 0 ? "Owned" : "Not owned"}`}
                onClick={() => props.onOpenInCodex(w.hash)}
              >
                <span className="pf-tile__art">
                  <span className="pf-tile__fallback" aria-hidden="true">
                    {w.name.slice(0, 1)}
                  </span>
                  <BungieImage path={w.look.icon} className="pf-tile__icon" />
                  <BungieImage path={w.look.watermark} className="pf-tile__watermark" />
                </span>
                <span className="pf-tile__bar" aria-hidden="true">
                  <span className="pf-tile__element">
                    <ElementIcon damage={w.look.damage} size={11} />
                  </span>
                  {w.owned > 0 && (
                    <span className="pf-tile__owned">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          {session.syncStep && <p className="pf-muted">Syncing; counts update when it finishes.</p>}
        </section>
      )}
    </div>
  );
}

function Meter(props: { label: string; owned: number; total: number; tone: "exotic" | "legendary" }) {
  return (
    <div className="pf-meter" data-tone={props.tone}>
      <div className="pf-row pf-row--between">
        <span>{props.label}</span>
        <span className="pf-muted">
          {props.owned}/{props.total}
        </span>
      </div>
      <span className="pf-meter__bar" aria-hidden="true">
        <span style={{ width: `${percent(props.owned, props.total)}%` }} />
      </span>
    </div>
  );
}
