// The advanced filters shared by the Codex and the Vault: slot, element, ammo, champion, weapon
// type, frame, source, season, craftable, adept, meta picks and weapons with god rolls.
import { useMemo } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { AMMO, BREAKERS, CopyPart, ELEMENTS, Perk, SLOTS, WeaponLook, WeaponPart, metaTier } from "../app/api";
import { seasonLabel } from "../app/seasons";
import { Dropdown, Toggle } from "./parts";
import { ElementIcon } from "./weapon";

export type WeaponFilters = {
  /** 1 Kinetic, 2 Energy, 3 Power. */
  slots: number[];
  elements: number[];
  ammo: number[];
  /** Champions it stuns on its own (see `BREAKERS`). */
  breakers: number[];
  type: string;
  frame: string;
  source: string;
  /** Bungie's season number as text, "" for any. */
  season: string;
  craftable: boolean;
  adept: boolean;
  metaOnly: boolean;
  withRolls: boolean;
};

export const NO_FILTERS: WeaponFilters = {
  slots: [],
  elements: [],
  ammo: [],
  breakers: [],
  type: "",
  frame: "",
  source: "",
  season: "",
  craftable: false,
  adept: false,
  metaOnly: false,
  withRolls: false,
};

type Filterable = { look: WeaponLook; type_name: string; parts?: (WeaponPart | CopyPart)[]; meta?: number };

/** The weapon's frame (its intrinsic perk) by name, or "" when unknown. */
export function frameOf(row: Filterable, perks: Record<number, Perk>): string {
  const part = row.parts?.find((p) => p.kind === "intrinsic");
  if (!part) return "";
  const hash = "pool" in part ? part.pool[0] : part.plugged;
  return hash != null ? (perks[hash]?.name ?? "") : "";
}

export function activeFilters(f: WeaponFilters): number {
  return (
    f.slots.length +
    f.elements.length +
    f.ammo.length +
    f.breakers.length +
    [f.type, f.frame, f.source, f.season, f.craftable, f.adept, f.metaOnly, f.withRolls].filter(Boolean).length
  );
}

export function applyFilters<T extends Filterable>(rows: T[], f: WeaponFilters, perks: Record<number, Perk>): T[] {
  if (activeFilters(f) === 0) return rows;
  const season = Number(f.season);
  return rows.filter(
    (r) =>
      (f.slots.length === 0 || f.slots.includes(r.look.slot)) &&
      (f.elements.length === 0 || f.elements.includes(r.look.damage)) &&
      (f.ammo.length === 0 || f.ammo.includes(r.look.ammo)) &&
      (f.breakers.length === 0 || f.breakers.includes(r.look.breaker ?? 0)) &&
      (!f.type || r.type_name === f.type) &&
      (!f.frame || frameOf(r, perks) === f.frame) &&
      (!f.source || r.look.source === f.source) &&
      (!f.season || r.look.season === season) &&
      (!f.craftable || r.look.craftable === true) &&
      (!f.adept || r.look.adept === true) &&
      (!f.metaOnly || metaTier(r.meta) === "meta") &&
      (!f.withRolls || (r.meta ?? 0) > 0),
  );
}

const toggle = (list: number[], value: number) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/** The filter panel. `rows` are the weapons before these filters, used to list types and frames. */
export function FilterPanel(props: {
  rows: Filterable[];
  value: WeaponFilters;
  onChange: (value: WeaponFilters) => void;
  perks: Record<number, Perk>;
}) {
  const f = props.value;
  const set = (patch: Partial<WeaponFilters>) => props.onChange({ ...f, ...patch });
  const types = useMemo(
    () => [...new Set(props.rows.map((r) => r.type_name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [props.rows],
  );
  const frames = useMemo(
    () =>
      [
        ...new Set(
          props.rows
            .filter((r) => !f.type || r.type_name === f.type)
            .map((r) => frameOf(r, props.perks))
            .concat(f.frame ? [f.frame] : [])
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [props.rows, props.perks, f.type, f.frame],
  );
  // A choice still on is always listed, even when a search hides every weapon it matches, so the
  // dropdown shows it and it can be cleared.
  const sources = useMemo(() => {
    const list = new Set(props.rows.map((r) => r.look.source).filter(Boolean));
    if (f.source) list.add(f.source);
    return [...list].sort((a, b) => a.localeCompare(b));
  }, [props.rows, f.source]);
  // Newest first, since recent seasons are the ones people look for.
  const seasons = useMemo(() => {
    const list = new Set(props.rows.map((r) => r.look.season ?? 0).filter((n) => n > 0));
    if (Number(f.season) > 0) list.add(Number(f.season));
    return [...list].sort((a, b) => b - a);
  }, [props.rows, f.season]);
  // Weapons read before this version have every new field at its default until the next sync, and
  // almost every weapon has a known season, so none at all means the data has not arrived yet.
  const hasExtras = props.rows.length === 0 || props.rows.some((r) => (r.look.season ?? 0) > 0);
  return (
    <div className="pf-filterpanel" role="group" aria-label="Filters">
      <ChipRow
        label="Slot"
        options={[1, 2, 3].map((n) => ({ value: n, label: SLOTS[n] }))}
        value={f.slots}
        onChange={(slots) => set({ slots })}
      />
      <div className="pf-filterpanel__row">
        <span className="pf-filterpanel__label">Element</span>
        <div className="pf-chips">
          {Object.entries(ELEMENTS).map(([damage, el]) => (
            <button
              key={damage}
              type="button"
              className="pf-chipbtn pf-chipbtn--small pf-chipbtn--icon"
              aria-pressed={f.elements.includes(Number(damage))}
              onClick={() => set({ elements: toggle(f.elements, Number(damage)) })}
            >
              <span aria-hidden="true">
                <ElementIcon damage={Number(damage)} size={14} />
              </span>
              {el.name}
            </button>
          ))}
        </div>
      </div>
      <div className="pf-filterpanel__row">
        <span className="pf-filterpanel__label">Ammo</span>
        <div className="pf-chips">
          {Object.entries(AMMO).map(([ammo, name]) => (
            <button
              key={ammo}
              type="button"
              className="pf-chipbtn pf-chipbtn--small"
              aria-pressed={f.ammo.includes(Number(ammo))}
              onClick={() => set({ ammo: toggle(f.ammo, Number(ammo)) })}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <ChipRow
        label="Champion"
        options={Object.entries(BREAKERS).map(([n, name]) => ({ value: Number(n), label: name }))}
        value={f.breakers}
        onChange={(breakers) => set({ breakers })}
        note="Weapons that stun on their own, without an artifact mod."
      />
      <div className="pf-filterpanel__row pf-filterpanel__row--controls">
        <Dropdown
          label="Weapon type"
          value={f.type}
          options={[{ value: "", label: "Every weapon type" }, ...types.map((t) => ({ value: t, label: t }))]}
          onChange={(type) => set({ type, frame: "" })}
        />
        <Dropdown
          label="Frame"
          value={f.frame}
          options={[{ value: "", label: "Every frame" }, ...frames.map((t) => ({ value: t, label: t }))]}
          onChange={(frame) => set({ frame })}
          disabled={frames.length === 0}
        />
        <Dropdown
          label="Source"
          value={f.source}
          options={[{ value: "", label: "Every source" }, ...sources.map((t) => ({ value: t, label: t }))]}
          onChange={(source) => set({ source })}
          disabled={sources.length === 0}
        />
        <Dropdown
          label="Season"
          value={f.season}
          options={[
            { value: "", label: "Every season" },
            ...seasons.map((n) => ({ value: String(n), label: seasonLabel(n) })),
          ]}
          onChange={(season) => set({ season })}
          disabled={seasons.length === 0}
        />
      </div>
      <div className="pf-filterpanel__row pf-filterpanel__row--controls">
        <Toggle label="Craftable" checked={f.craftable} onChange={(craftable) => set({ craftable })} />
        <Toggle label="Adept only" checked={f.adept} onChange={(adept) => set({ adept })} />
        {!hasExtras && <span className="pf-muted pf-filterpanel__note">Champion, season, craftable and adept appear after your next sync.</span>}
        <Toggle label="Meta picks only" checked={f.metaOnly} onChange={(metaOnly) => set({ metaOnly })} />
        <Toggle label="Has god rolls" checked={f.withRolls} onChange={(withRolls) => set({ withRolls })} />
        {activeFilters(f) > 0 && (
          <button type="button" className="pf-btn pf-btn--small" onClick={() => props.onChange(NO_FILTERS)}>
            <X size={14} aria-hidden="true" />
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

/** A labelled row of on/off chips; none on means any. */
function ChipRow(props: {
  label: string;
  options: { value: number; label: string }[];
  value: number[];
  onChange: (value: number[]) => void;
  note?: string;
}) {
  return (
    <div className="pf-filterpanel__row">
      <span className="pf-filterpanel__label">{props.label}</span>
      <div className="pf-chips">
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="pf-chipbtn pf-chipbtn--small"
            aria-pressed={props.value.includes(o.value)}
            onClick={() => props.onChange(toggle(props.value, o.value))}
          >
            {o.label}
          </button>
        ))}
        {props.note && <span className="pf-muted pf-filterpanel__note">{props.note}</span>}
      </div>
    </div>
  );
}

/** The toolbar button that shows and hides the filter panel, with how many filters are on. */
export function FilterButton(props: { open: boolean; count: number; onClick: () => void; controls: string }) {
  return (
    <button
      type="button"
      className="pf-btn pf-filterbtn"
      aria-expanded={props.open}
      aria-controls={props.controls}
      onClick={props.onClick}
      data-tip="Filter by slot, element, ammo, champion, type, frame, source, season and more"
    >
      <SlidersHorizontal size={16} aria-hidden="true" />
      Filters
      {props.count > 0 && <span className="pf-badge pf-filterbtn__count">{props.count}</span>}
    </button>
  );
}
