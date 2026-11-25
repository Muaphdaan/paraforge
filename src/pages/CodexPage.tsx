// The Codex: every Legendary and Exotic weapon in the game as icon tiles, by slot and type, with
// search (name, type, source or any perk it can roll), owned filters and a detail panel where you
// pick the perks you want and chase that roll.
import { memo, useEffect, useId, useMemo, useState } from "react";
import { ArrowRight, Check, Crosshair, MapPin, Search, X } from "lucide-react";
import {
  CodexRow,
  META_TIER_LABEL,
  META_TIER_ORDER,
  Perk,
  ROLE_LABELS,
  SLOTS,
  VaultRow,
  byMeta,
  metaTier,
  metaTip,
} from "../app/api";
import { sameRoll, useChase } from "../app/chase";
import { useCodex } from "../app/codex";
import { useSession } from "../app/session";
import { FilterButton, FilterPanel, NO_FILTERS, WeaponFilters, activeFilters, applyFilters } from "../ui/filters";
import { GodRolls } from "../ui/godrolls";
import { Banner, Dropdown, EmptyState } from "../ui/parts";
import {
  AmmoBadge,
  BungieImage,
  ElementBadge,
  ElementIcon,
  MetaMark,
  PartList,
  PerkIcon,
  weaponParts,
} from "../ui/weapon";

type Owned = "all" | "owned" | "missing";
type Rarity = "all" | "5" | "6";
type GroupBy = "meta" | "slot" | "type" | "source";

const SLOT_ORDER = [1, 2, 3, 0];
// v2: meta first became the default grouping.
const PREFS_KEY = "paraforge.codexPrefs.v2";

function readPrefs(): { group: GroupBy; rarity: Rarity } {
  const fallback = { group: "meta" as GroupBy, rarity: "all" as Rarity };
  try {
    const saved = localStorage.getItem(PREFS_KEY);
    if (saved) return { ...fallback, ...JSON.parse(saved) };
    // Carry the rarity filter over from before meta first existed; only the grouping starts fresh.
    const { rarity } = JSON.parse(localStorage.getItem("paraforge.codexPrefs") ?? "{}");
    return { ...fallback, ...(rarity ? { rarity } : {}) };
  } catch {
    return fallback;
  }
}

// Search, filter, selection and perk picks survive leaving the Codex (for a weapon page, say) until
// the app closes.
const kept: {
  query: string;
  owned: Owned;
  selectedHash: number | null;
  picks: { hash: number; picks: number[][] } | null;
  /** The last open request handled, so coming Back to the Codex keeps the selection made since. */
  focusToken: number | undefined;
  filters: WeaponFilters;
  filtersOpen: boolean;
} = {
  query: "",
  owned: "all",
  selectedHash: null,
  picks: null,
  focusToken: undefined,
  filters: NO_FILTERS,
  filtersOpen: false,
};

type Group = { key: string; title: string | null; rows: CodexRow[] };
type Section = { key: string; title: string; groups: Group[] };

function byKey(rows: CodexRow[], key: (r: CodexRow) => string | number): Map<string | number, CodexRow[]> {
  const out = new Map<string | number, CodexRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

const alpha = (a: string | number, b: string | number) => String(a).localeCompare(String(b));

/** Rows arrive sorted by name; every group puts meta weapons first and keeps name order after that. */
function organise(input: CodexRow[], group: GroupBy): Section[] {
  const rows = [...input].sort(byMeta);
  if (group === "meta") {
    const tiers = byKey(rows, (r) => metaTier(r.meta));
    return META_TIER_ORDER.filter((t) => tiers.has(t)).map((t) => ({
      key: `meta-${t}`,
      title: META_TIER_LABEL[t],
      groups: [{ key: t, title: null, rows: tiers.get(t)! }],
    }));
  }
  if (group === "slot") {
    const slots = byKey(rows, (r) => (SLOTS[r.look.slot] ? r.look.slot : 0));
    return SLOT_ORDER.filter((s) => slots.has(s)).map((slot) => {
      const types = byKey(slots.get(slot)!, (r) => r.type_name || "Other");
      return {
        key: `slot-${slot}`,
        title: SLOTS[slot],
        groups: [...types.keys()].sort(alpha).map((t) => ({ key: String(t), title: String(t), rows: types.get(t)! })),
      };
    });
  }
  const keyOf = group === "type" ? (r: CodexRow) => r.type_name || "Other" : (r: CodexRow) => r.look.source || "Unknown source";
  const groups = byKey(rows, keyOf);
  return [...groups.keys()]
    .sort((a, b) => (a === "Unknown source" ? 1 : b === "Unknown source" ? -1 : alpha(a, b)))
    .map((k) => ({ key: String(k), title: String(k), groups: [{ key: String(k), title: null, rows: groups.get(k)! }] }));
}

/** Everything a Codex search looks through, lower case: name, type, source and every perk it can roll. */
function haystack(row: CodexRow, perks: Record<number, Perk>): string {
  const perkNames = row.pools.flatMap((pool) => pool.map((h) => perks[h]?.name ?? ""));
  return [row.name, row.type_name, row.look.source, row.look.rarity === 6 ? "exotic" : "legendary", ...perkNames]
    .join(" ")
    .toLowerCase();
}

export function CodexPage(props: {
  initialHash?: number | null;
  /** Changes on every request to open a weapon, so opening the same one again still selects it. */
  focusToken?: number;
  onOpenWeapon: (instanceId: string) => void;
}) {
  const session = useSession();
  const codex = useCodex();
  const [prefs, setPrefs] = useState(readPrefs);
  const [query, setQuery] = useState(kept.query);
  const [owned, setOwned] = useState<Owned>(kept.owned);
  const [filters, setFilters] = useState<WeaponFilters>(kept.filters);
  const [filtersOpen, setFiltersOpen] = useState(kept.filtersOpen);
  const filterPanelId = useId();
  useEffect(() => {
    kept.filters = filters;
    kept.filtersOpen = filtersOpen;
  }, [filters, filtersOpen]);
  const [selectedHash, setSelectedHash] = useState<number | null>(props.initialHash ?? kept.selectedHash);
  useEffect(() => {
    kept.query = query;
    kept.owned = owned;
    kept.selectedHash = selectedHash;
  }, [query, owned, selectedHash]);
  const searchId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Without storage the view resets next launch.
    }
  }, [prefs]);

  // Opened on a weapon (search, Collections, Chase list): select it, clear any filter that would
  // hide its tile, then bring the tile into view. Runs once per request, not on every sync.
  const byHash = codex.byHash;
  const [reveal, setReveal] = useState<number | null>(null);
  useEffect(() => {
    if (!props.initialHash || kept.focusToken === props.focusToken) return;
    kept.focusToken = props.focusToken;
    setSelectedHash(props.initialHash);
    setReveal(props.initialHash);
  }, [props.initialHash, props.focusToken]);

  const indexed = useMemo(
    () => (codex.rows ?? []).map((row) => ({ row, text: haystack(row, session.perks) })),
    [codex.rows, session.perks],
  );
  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matched = useMemo(
    () =>
      indexed
        .filter(({ row, text }) => (prefs.rarity === "all" || String(row.look.rarity) === prefs.rarity) && words.every((w) => text.includes(w)))
        .map(({ row }) => row),
    [indexed, words, prefs.rarity],
  );
  const searched = useMemo(() => applyFilters(matched, filters, session.perks), [matched, filters, session.perks]);
  const counts = useMemo(() => {
    const have = searched.filter((r) => r.owned > 0).length;
    return { all: searched.length, owned: have, missing: searched.length - have };
  }, [searched]);
  const visible = useMemo(
    () => (owned === "all" ? searched : searched.filter((r) => (owned === "owned" ? r.owned > 0 : r.owned === 0))),
    [searched, owned],
  );
  const sections = useMemo(() => organise(visible, prefs.group), [visible, prefs.group]);
  useEffect(() => {
    if (reveal === null) return;
    const tile = document.querySelector(`.pf-vault__scroll [data-hash="${reveal}"]`);
    if (tile) {
      tile.scrollIntoView({ block: "nearest" });
      setReveal(null);
      return;
    }
    const row = byHash.get(reveal);
    if (!row) return; // the Codex is still loading
    // Hidden by a filter: clear them, and this runs again with the tile on screen.
    setQuery("");
    setOwned("all");
    setFilters(NO_FILTERS);
    setPrefs((p) => (p.rarity === "all" || String(row.look.rarity) === p.rarity ? p : { ...p, rarity: "all" }));
  }, [reveal, sections, byHash]);

  const selected =
    (selectedHash !== null ? codex.byHash.get(selectedHash) : undefined) ?? sections[0]?.groups[0]?.rows[0] ?? null;

  if (codex.error) {
    return (
      <EmptyState pose="confused" title="The Codex could not be read">
        {codex.error}
      </EmptyState>
    );
  }
  if (codex.rows === null) return null;
  if (codex.rows.length === 0) {
    return (
      <EmptyState
        pose={session.syncStep ? "thinking" : "sleepy"}
        title={session.syncStep ? "Reading Bungie's item database" : "The Codex is empty"}
        action={
          !session.syncStep && session.auth?.signed_in ? (
            <button type="button" className="pf-btn pf-btn--primary" onClick={session.sync}>
              Sync now
            </button>
          ) : undefined
        }
      >
        Every weapon in the game comes in with your first sync.
      </EmptyState>
    );
  }

  const noSources = codex.rows.every((r) => !r.look.source);

  return (
    <div className="pf-vault">
      <section className="pf-panel pf-vault__main" aria-label="Every weapon">
        <div className="pf-vault__toolbar">
          <div className="pf-search">
            <label htmlFor={searchId} className="pf-search__icon">
              <Search size={18} aria-hidden="true" />
            </label>
            <input
              id={searchId}
              type="search"
              aria-label="Search by name, type, source or perk"
              value={query}
              placeholder="Search by name, type, source or perk"
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            {query && (
              <button type="button" className="pf-search__clear" onClick={() => setQuery("")} data-tip="Clear search">
                <X size={16} aria-hidden="true" />
                <span className="pf-visually-hidden">Clear search</span>
              </button>
            )}
          </div>
          <Dropdown
            label="Rarity"
            value={prefs.rarity}
            options={[
              { value: "all", label: "All rarities" },
              { value: "5", label: "Legendary" },
              { value: "6", label: "Exotic" },
            ]}
            onChange={(rarity) => setPrefs((p) => ({ ...p, rarity }))}
          />
          <Dropdown
            label="Group by"
            value={prefs.group}
            options={[
              { value: "meta", label: "Meta first" },
              { value: "slot", label: "By slot" },
              { value: "type", label: "By weapon type" },
              { value: "source", label: "By source" },
            ]}
            onChange={(group) => setPrefs((p) => ({ ...p, group }))}
          />
          <FilterButton
            open={filtersOpen}
            count={activeFilters(filters)}
            onClick={() => setFiltersOpen(!filtersOpen)}
            controls={filterPanelId}
          />
        </div>
        {filtersOpen && (
          <div id={filterPanelId}>
            <FilterPanel rows={matched} value={filters} onChange={setFilters} perks={session.perks} />
          </div>
        )}

        <div className="pf-filters" role="group" aria-label="Filter by ownership">
          {(
            [
              ["all", "All"],
              ["owned", "Owned"],
              ["missing", "Not owned"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="pf-filter"
              aria-pressed={owned === value}
              onClick={() => setOwned(value)}
            >
              {label}
              <span className="pf-filter__count">{counts[value]}</span>
            </button>
          ))}
          {noSources && <span className="pf-filters__note">Sources appear after your next sync.</span>}
        </div>

        <div className="pf-vault__scroll">
          {sections.length === 0 ? (
            <EmptyState
              pose="confused"
              title="No weapons match"
              action={
                <button
                  type="button"
                  className="pf-btn"
                  onClick={() => {
                    setQuery("");
                    setOwned("all");
                    setFilters(NO_FILTERS);
                    setPrefs((p) => ({ ...p, rarity: "all" }));
                  }}
                >
                  Clear filters
                </button>
              }
            >
              Try fewer words. Perk names work too, like "outlaw rampage".
            </EmptyState>
          ) : (
            sections.map((section) => (
              <section key={section.key} className="pf-vsection" data-view="grid" aria-label={section.title}>
                <h2 className="pf-vsection__title">
                  {section.title}
                  <span className="pf-vsection__count">{section.groups.reduce((n, g) => n + g.rows.length, 0)}</span>
                </h2>
                <div className="pf-vsection__body">
                  {section.groups.map((group) => (
                    <div key={group.key} className="pf-vgroup">
                      {group.title && (
                        <h3 className="pf-vgroup__title">
                          {group.title} <span>{group.rows.length}</span>
                        </h3>
                      )}
                      <div className="pf-tiles">
                        {group.rows.map((r) => (
                          <CodexTile key={r.hash} row={r} selected={selected?.hash === r.hash} onSelect={setSelectedHash} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </section>

      {selected && (
        <CodexDetail
          key={selected.hash}
          row={selected}
          perks={session.perks}
          copies={(session.vault ?? []).filter((c) => c.weapon === selected.hash)}
          onOpenWeapon={props.onOpenWeapon}
        />
      )}
    </div>
  );
}

/** A Codex tile: the icon with its season badge, the element, and how many you own. Unowned tiles are dimmed. */
const CodexTile = memo(function CodexTile(props: { row: CodexRow; selected: boolean; onSelect: (hash: number) => void }) {
  const { row } = props;
  const label = [
    row.name,
    row.type_name,
    row.look.source,
    metaTier(row.meta) === "meta" ? "meta pick" : "",
    row.owned > 0 ? `you own ${row.owned}` : "not owned",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className="pf-tile pf-tile--codex"
      data-rarity={row.look.rarity}
      data-hash={row.hash}
      data-owned={row.owned > 0 || undefined}
      aria-pressed={props.selected}
      aria-label={label}
      data-tip={`${row.name}\n${row.look.rarity === 6 ? "Exotic " : ""}${row.type_name}${row.look.source ? ` · ${row.look.source}` : ""}${row.owned > 0 ? ` · You own ${row.owned}` : ""}${row.meta ? `\n${metaTip(row.meta)}` : ""}`}
      onClick={() => props.onSelect(row.hash)}
    >
      <span className="pf-tile__art">
        <span className="pf-tile__fallback" aria-hidden="true">
          {row.name.slice(0, 1)}
        </span>
        <BungieImage path={row.look.icon} className="pf-tile__icon" />
        <BungieImage path={row.look.watermark} className="pf-tile__watermark" />
        <MetaMark meta={row.meta} />
      </span>
      <span className="pf-tile__bar" aria-hidden="true">
        <span className="pf-tile__element">
          <ElementIcon damage={row.look.damage} size={11} />
        </span>
        {row.owned > 0 && (
          <span className="pf-tile__owned">
            <Check size={10} strokeWidth={3} />
            {row.owned > 1 ? row.owned : null}
          </span>
        )}
      </span>
    </button>
  );
});

function CodexDetail(props: {
  row: CodexRow;
  perks: Record<number, Perk>;
  copies: VaultRow[];
  onOpenWeapon: (instanceId: string) => void;
}) {
  const { row, perks, copies } = props;
  const chase = useChase();
  const session = useSession();
  const exotic = row.look.rarity === 6;
  const [rawPicks, setPicks] = useState<number[][]>(() =>
    kept.picks?.hash === row.hash ? kept.picks.picks : row.pools.map(() => []),
  );
  // Matched to the current pools on every render: a sync can change them under an open panel.
  const picks = row.pools.map((pool, i) => (rawPicks[i] ?? []).filter((h) => pool.includes(h)));
  useEffect(() => {
    kept.picks = { hash: row.hash, picks: rawPicks };
  }, [row.hash, rawPicks]);
  const [status, setStatus] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = picks.some((c) => c.length > 0);
  const chased = chase.list?.some((c) => c.weapon === row.hash && sameRoll(c.perks, picks)) ?? false;
  const best = copies[0];

  function toggle(column: number, hash: number) {
    setStatus(null);
    setPicks(picks.map((c, i) => (i !== column ? c : c.includes(hash) ? c.filter((h) => h !== hash) : [...c, hash])));
  }

  async function chaseIt() {
    setBusy(true);
    try {
      await chase.add(row.hash, picks);
      setStatus({ tone: "info", text: "Added to your Chase list." });
    } catch (e) {
      setStatus({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="pf-panel pf-detail" aria-label={`${row.name} details`}>
      <div className="pf-detail__hero" data-rarity={row.look.rarity}>
        <BungieImage path={row.look.screenshot} className="pf-detail__shot" />
        <div className="pf-detail__heroinfo">
          <span className="pf-detail__icon" data-rarity={row.look.rarity}>
            <span className="pf-tile__fallback" aria-hidden="true">
              {row.name.slice(0, 1)}
            </span>
            <BungieImage path={row.look.icon} className="pf-tile__icon" />
            <BungieImage path={row.look.watermark} className="pf-tile__watermark" />
          </span>
          <div className="pf-detail__titles">
            <div className="pf-detail__kicker">
              {exotic ? "Exotic " : ""}
              {row.type_name}
            </div>
            <h2 className="pf-detail__name" data-selectable>
              {row.name}
            </h2>
          </div>
        </div>
      </div>

      <div className="pf-detail__body">
        <div className="pf-detail__chips">
          <ElementBadge damage={row.look.damage} />
          <AmmoBadge ammo={row.look.ammo} />
          {row.look.slot > 0 && SLOTS[row.look.slot] && <span className="pf-chip">{SLOTS[row.look.slot]} slot</span>}
        </div>

        <p className="pf-codex__source">
          <MapPin size={16} aria-hidden="true" />
          {row.look.source || <span className="pf-muted">Source shows after your next sync.</span>}
        </p>

        {best ? (
          <div className="pf-codex__owned">
            <span>
              <strong>You own {copies.length === 1 ? "1 copy" : `${copies.length} copies`}.</strong>
              {best.score && (
                <span className="pf-muted"> Best scores {best.score.score.toFixed(0)}.</span>
              )}
            </span>
            <button type="button" className="pf-btn pf-btn--small" onClick={() => props.onOpenWeapon(best.instance_id)}>
              Open your best copy
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <p className="pf-muted">You don't own this weapon yet.</p>
        )}

        {weaponParts(row.parts).length > 0 && (
          <>
            <h3 className="pf-detail__heading">Frame and origin</h3>
            <PartList parts={weaponParts(row.parts)} perks={perks} exotic={row.look.rarity === 6} size={30} describe />
          </>
        )}

        {row.pools.length > 0 && (
          <>
            <h3 className="pf-detail__heading">God rolls and guide</h3>
            <GodRolls
              weapon={row.hash}
              roles={row.roles}
              perks={perks}
              context={session.context}
              copies={copies.map((c) => c.columns)}
              limit={3}
              compact
              onChase={(roll) => chase.add(row.hash, roll.columns).then(() => undefined)}
              isChased={(roll) => chase.list?.some((c) => c.weapon === row.hash && sameRoll(c.perks, roll.columns)) ?? false}
            />
          </>
        )}

        <h3 className="pf-detail__heading">{row.pools.length > 0 ? "Or pick your own roll" : "Perks"}</h3>
        {row.pools.length === 0 ? (
          <p className="pf-muted">This weapon has fixed perks, so there is no roll to chase.</p>
        ) : (
          <>
            <div className="pf-perkcols">
              {row.pools.map((pool, i) => (
                <div key={i} className="pf-perkcol" role="group" aria-label={ROLE_LABELS[row.roles[i]] ?? "Perk"}>
                  <div className="pf-perkcol__label">{ROLE_LABELS[row.roles[i]] ?? "Perk"}</div>
                  {pool.length === 0 ? (
                    <span className="pf-muted">Nothing rolls here any more.</span>
                  ) : (
                    pool.map((hash) => (
                      <button
                        key={hash}
                        type="button"
                        className="pf-perkpick"
                        aria-pressed={picks[i]?.includes(hash)}
                        onClick={() => toggle(i, hash)}
                      >
                        <PerkIcon hash={hash} perk={perks[hash]} size={30} decorative />
                        <span className="pf-perkrow__name">{perks[hash]?.name ?? "Unknown perk"}</span>
                        {picks[i]?.includes(hash) && <Check size={16} strokeWidth={3} className="pf-perkpick__check" aria-hidden="true" />}
                      </button>
                    ))
                  )}
                </div>
              ))}
            </div>
            <p className="pf-muted pf-codex__hint">
              Pick one or more perks per column; a column left empty takes any perk.
            </p>
            {status && <Banner tone={status.tone}>{status.text}</Banner>}
            <div className="pf-row">
              <button
                type="button"
                className="pf-btn pf-btn--primary"
                disabled={!picked || busy || chased}
                onClick={chaseIt}
              >
                <Crosshair size={16} aria-hidden="true" />
                {chased ? "On your Chase list" : "Chase this roll"}
              </button>
              {picked && (
                <button
                  type="button"
                  className="pf-btn"
                  onClick={() => {
                    setPicks(row.pools.map(() => []));
                    setStatus(null);
                  }}
                >
                  Clear picks
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
