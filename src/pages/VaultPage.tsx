// The Vault: every owned copy as a weapon tile (or a row), organised by slot and weapon type,
// with search, verdict filters, grouping, sorting and a detail panel for the selected copy.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { LayoutGrid, List, Search, X } from "lucide-react";
import { META_TIER_LABEL, META_TIER_ORDER, Perk, SLOTS, Verdict, VaultRow, byMeta, metaTier } from "../app/api";
import { PageId } from "../app/pages";
import { useSession } from "../app/session";
import { Dropdown, EmptyState, TierPill, VerdictPill } from "../ui/parts";
import { BungieImage, ElementIcon, PerkIcon, WeaponTile } from "../ui/weapon";
import { FilterButton, FilterPanel, NO_FILTERS, WeaponFilters, activeFilters, applyFilters } from "../ui/filters";
import { WeaponDetail } from "./WeaponDetail";

type View = "grid" | "list";
type GroupBy = "meta" | "slot" | "type" | "verdict";
type SortBy = "score" | "name" | "tier";

const VERDICT_ORDER: (Verdict | "none")[] = ["keep", "upgrade", "replace", "shard", "none"];
const VERDICT_NAMES: Record<Verdict | "none", string> = {
  keep: "Keep",
  upgrade: "Upgrade",
  replace: "Replace",
  shard: "Shard",
  none: "Not scored",
};
const SLOT_ORDER = [1, 2, 3, 0];

// v2: meta first became the default grouping.
const PREFS_KEY = "paraforge.vaultPrefs.v2";

function readPrefs(): { view: View; group: GroupBy; sort: SortBy } {
  const fallback = { view: "grid" as View, group: "meta" as GroupBy, sort: "score" as SortBy };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

// Search and verdict filter survive leaving the Vault (for a weapon page, say) until the app closes.
const kept: { query: string; verdict: Verdict | "all"; filters: WeaponFilters; filtersOpen: boolean } = {
  query: "",
  verdict: "all",
  filters: NO_FILTERS,
  filtersOpen: false,
};

type Section = { key: string; title: string; groups: { key: string; title: string | null; rows: VaultRow[] }[] };

function compare(sort: SortBy) {
  return (a: VaultRow, b: VaultRow) => {
    if (sort === "name") return a.name.localeCompare(b.name) || b.tier - a.tier;
    if (sort === "tier") return b.tier - a.tier || (b.score?.score ?? -1) - (a.score?.score ?? -1);
    return (b.score?.score ?? -1) - (a.score?.score ?? -1) || a.name.localeCompare(b.name);
  };
}

function byKey<T>(rows: VaultRow[], key: (r: VaultRow) => T): Map<T, VaultRow[]> {
  const out = new Map<T, VaultRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Slot sections hold one group per weapon type; the other groupings have one group per section. */
function organise(rows: VaultRow[], group: GroupBy, sort: SortBy): Section[] {
  const cmp = compare(sort);
  if (group === "meta") {
    // Meta picks first; inside each tier, by weapon type so copies of a weapon sit together.
    const tiers = byKey(rows, (r) => metaTier(r.meta));
    return META_TIER_ORDER.filter((t) => tiers.has(t)).map((t) => {
      const types = byKey(tiers.get(t)!, (r) => r.type_name || "Other");
      return {
        key: `meta-${t}`,
        title: META_TIER_LABEL[t],
        groups: [...types.keys()]
          .sort((a, b) => a.localeCompare(b))
          .map((type) => ({ key: `${t}-${type}`, title: type, rows: types.get(type)!.sort((a, b) => byMeta(a, b) || cmp(a, b)) })),
      };
    });
  }
  if (group === "slot") {
    const slots = byKey(rows, (r) => (SLOTS[r.look.slot] ? r.look.slot : 0));
    return SLOT_ORDER.filter((s) => slots.has(s)).map((slot) => {
      const types = byKey(slots.get(slot)!, (r) => r.type_name || "Other");
      return {
        key: `slot-${slot}`,
        title: SLOTS[slot],
        groups: [...types.keys()]
          .sort((a, b) => a.localeCompare(b))
          .map((type) => ({ key: type, title: type, rows: types.get(type)!.sort(cmp) })),
      };
    });
  }
  if (group === "type") {
    const types = byKey(rows, (r) => r.type_name || "Other");
    return [...types.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((type) => ({ key: type, title: type, groups: [{ key: type, title: null, rows: types.get(type)!.sort(cmp) }] }));
  }
  const verdicts = byKey(rows, (r) => r.score?.verdict ?? "none");
  return VERDICT_ORDER.filter((v) => verdicts.has(v)).map((v) => ({
    key: v,
    title: VERDICT_NAMES[v],
    groups: [{ key: v, title: null, rows: verdicts.get(v)!.sort(cmp) }],
  }));
}

function matches(row: VaultRow, words: string[], perks: Record<number, Perk>): boolean {
  if (words.length === 0) return true;
  const perkNames = row.columns.flatMap((c) => c.options.map((h) => perks[h]?.name ?? ""));
  const haystack = [row.name, row.type_name, ...perkNames, row.locked ? "locked" : "", row.look.rarity === 6 ? "exotic" : ""]
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

export function VaultPage({
  onNavigate,
  initialSelectedId = null,
  onOpenWeapon,
}: {
  onNavigate: (page: PageId) => void;
  initialSelectedId?: string | null;
  onOpenWeapon: (instanceId: string) => void;
}) {
  const session = useSession();
  const [prefs, setPrefs] = useState(readPrefs);
  const searchId = useId();
  const [query, setQuery] = useState(kept.query);
  const [verdict, setVerdict] = useState<Verdict | "all">(kept.verdict);
  const [filters, setFilters] = useState<WeaponFilters>(kept.filters);
  const [filtersOpen, setFiltersOpen] = useState(kept.filtersOpen);
  const filterPanelId = useId();
  useEffect(() => {
    kept.query = query;
    kept.verdict = verdict;
    kept.filters = filters;
    kept.filtersOpen = filtersOpen;
  }, [query, verdict, filters, filtersOpen]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Without storage the view just resets next launch.
    }
  }, [prefs]);

  const rows = session.vault;
  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matched = useMemo(
    () => (rows ?? []).filter((r) => matches(r, words, session.perks)),
    [rows, words, session.perks],
  );
  const searched = useMemo(() => applyFilters(matched, filters, session.perks), [matched, filters, session.perks]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: searched.length };
    for (const r of searched) if (r.score) c[r.score.verdict] = (c[r.score.verdict] ?? 0) + 1;
    return c;
  }, [searched]);
  const visible = useMemo(
    () => (verdict === "all" ? searched : searched.filter((r) => r.score?.verdict === verdict)),
    [searched, verdict],
  );
  const sections = useMemo(() => organise([...visible], prefs.group, prefs.sort), [visible, prefs.group, prefs.sort]);

  // Opened with a weapon to select (Home tile, Back from a weapon page): clear kept filters that
  // would hide it, then bring it into view, once per visit.
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !initialSelectedId || !rows?.length) return;
    if (!rows.some((r) => r.instance_id === initialSelectedId)) return;
    if (!visible.some((r) => r.instance_id === initialSelectedId)) {
      setQuery("");
      setVerdict("all");
      setFilters(NO_FILTERS);
      return; // runs again with the unfiltered list
    }
    revealed.current = true;
    document
      .querySelector(`.pf-vault__scroll [data-instance="${CSS.escape(initialSelectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [initialSelectedId, rows, visible]);

  const selected =
    (rows ?? []).find((r) => r.instance_id === selectedId) ?? sections[0]?.groups[0]?.rows[0] ?? null;

  if (session.vaultError) {
    return (
      <EmptyState pose="confused" title="Your vault could not be read">
        {session.vaultError}
      </EmptyState>
    );
  }
  if (rows === null) return null;
  if (rows.length === 0) {
    const signedIn = Boolean(session.auth?.signed_in);
    return (
      <EmptyState
        pose={session.syncStep ? "thinking" : "sleepy"}
        title={session.syncStep ? "Syncing your vault" : "No weapons yet"}
        action={
          session.syncStep ? undefined : signedIn ? (
            <button type="button" className="pf-btn pf-btn--primary" onClick={session.sync}>
              Sync now
            </button>
          ) : (
            <button type="button" className="pf-btn pf-btn--primary" onClick={() => onNavigate("settings")}>
              Open Settings
            </button>
          )
        }
      >
        {session.syncStep
          ? `${session.syncStep}...`
          : signedIn
            ? "Sync with Bungie to bring in every weapon you own."
            : "Sign in to Bungie first, then sync."}
      </EmptyState>
    );
  }

  return (
    <div className="pf-vault">
      <section className="pf-panel pf-vault__main" aria-label="Your weapons">
        <div className="pf-vault__toolbar">
          <div className="pf-search">
            <label htmlFor={searchId} className="pf-search__icon">
              <Search size={18} aria-hidden="true" />
            </label>
            <input
              id={searchId}
              type="search"
              aria-label="Search weapons and perks"
              value={query}
              placeholder="Search weapons and perks"
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
            label="Group by"
            value={prefs.group}
            options={[
              { value: "meta", label: "Meta first" },
              { value: "slot", label: "By slot" },
              { value: "type", label: "By weapon type" },
              { value: "verdict", label: "By verdict" },
            ]}
            onChange={(group) => setPrefs((p) => ({ ...p, group }))}
          />
          <Dropdown
            label="Sort by"
            value={prefs.sort}
            options={[
              { value: "score", label: "Sort: Score" },
              { value: "name", label: "Sort: Name" },
              { value: "tier", label: "Sort: Tier" },
            ]}
            onChange={(sort) => setPrefs((p) => ({ ...p, sort }))}
          />
          <div className="pf-segmented" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={prefs.view === "grid"}
              onClick={() => setPrefs((p) => ({ ...p, view: "grid" }))}
              data-tip="Icon grid"
            >
              <LayoutGrid size={18} aria-hidden="true" />
              <span className="pf-visually-hidden">Icon grid</span>
            </button>
            <button
              type="button"
              aria-pressed={prefs.view === "list"}
              onClick={() => setPrefs((p) => ({ ...p, view: "list" }))}
              data-tip="List"
            >
              <List size={18} aria-hidden="true" />
              <span className="pf-visually-hidden">List</span>
            </button>
          </div>
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

        <div className="pf-filters" role="group" aria-label="Filter by verdict">
          {(["all", "keep", "upgrade", "replace", "shard"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`pf-filter pf-filter--${v}`}
              aria-pressed={verdict === v}
              onClick={() => setVerdict(v)}
            >
              {v === "all" ? "All" : VERDICT_NAMES[v]}
              <span className="pf-filter__count">{counts[v] ?? 0}</span>
            </button>
          ))}
          <span className="pf-filters__note">
            {session.info && session.info.god_rolls > 0
              ? "Scored against community god rolls."
              : "God rolls arrive with your next sync."}
          </span>
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
                    setVerdict("all");
                    setFilters(NO_FILTERS);
                  }}
                >
                  Clear filters
                </button>
              }
            >
              Try fewer words or another verdict.
            </EmptyState>
          ) : (
            sections.map((section) => (
              <section key={section.key} className="pf-vsection" data-view={prefs.view} aria-label={section.title}>
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
                    {prefs.view === "grid" ? (
                      <div className="pf-tiles">
                        {group.rows.map((r) => (
                          <WeaponTile
                            key={r.instance_id}
                            row={r}
                            selected={selected?.instance_id === r.instance_id}
                            onSelect={() => setSelectedId(r.instance_id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="pf-rows">
                        {group.rows.map((r) => (
                          <WeaponRow
                            key={r.instance_id}
                            row={r}
                            perks={session.perks}
                            selected={selected?.instance_id === r.instance_id}
                            onSelect={() => setSelectedId(r.instance_id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                </div>
              </section>
            ))
          )}
        </div>
      </section>

      {selected && (
        <WeaponDetail
          row={selected}
          copies={rows.filter((r) => r.weapon === selected.weapon)}
          perks={session.perks}
          context={session.context}
          onSelect={setSelectedId}
          onOpen={() => onOpenWeapon(selected.instance_id)}
        />
      )}
    </div>
  );
}

/** The list view's row: icon, name and type, element, tier, perk icons, score and verdict. */
function WeaponRow(props: { row: VaultRow; perks: Record<number, Perk>; selected: boolean; onSelect: () => void }) {
  const { row } = props;
  return (
    <button
      type="button"
      className="pf-wrow"
      data-instance={row.instance_id}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <span className="pf-wrow__icon" data-rarity={row.look.rarity}>
        <WeaponTileArt row={row} />
      </span>
      <span className="pf-wrow__name">
        <strong>{row.name}</strong>
        <span className="pf-muted">
          <ElementIcon damage={row.look.damage} size={12} /> {row.type_name}
        </span>
      </span>
      {row.tier === 0 && row.look.rarity === 6 ? (
        <span className="pf-tier pf-tier--exotic">Exotic</span>
      ) : (
        <TierPill tier={row.tier} />
      )}
      <span className="pf-wrow__perks">
        {row.columns.map((c, i) =>
          c.options.slice(0, 2).map((h) => (
            <PerkIcon key={`${i}-${h}`} hash={h} perk={props.perks[h]} enhanced={c.enhanced} size={26} />
          )),
        )}
      </span>
      <span className={`pf-wrow__score pf-v--${row.score?.verdict ?? "none"}`}>
        {row.score ? row.score.score.toFixed(0) : "-"}
      </span>
      <span className="pf-wrow__verdict">{row.score ? <VerdictPill verdict={row.score.verdict} /> : null}</span>
    </button>
  );
}

function WeaponTileArt({ row }: { row: VaultRow }) {
  return (
    <>
      <span className="pf-tile__fallback" aria-hidden="true">
        {row.name.slice(0, 1)}
      </span>
      <BungieImage path={row.look.icon} className="pf-tile__icon" />
    </>
  );
}
