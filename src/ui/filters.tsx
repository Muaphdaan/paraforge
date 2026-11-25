// The advanced filters shared by the Codex and the Vault: element, ammo, weapon type, frame,
// meta picks and weapons with god rolls.
import { useMemo } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { AMMO, CopyPart, ELEMENTS, Perk, WeaponLook, WeaponPart, metaTier } from "../app/api";
import { Dropdown, Toggle } from "./parts";
import { ElementIcon } from "./weapon";

export type WeaponFilters = {
  elements: number[];
  ammo: number[];
  type: string;
  frame: string;
  metaOnly: boolean;
  withRolls: boolean;
};

export const NO_FILTERS: WeaponFilters = { elements: [], ammo: [], type: "", frame: "", metaOnly: false, withRolls: false };

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
    f.elements.length + f.ammo.length + (f.type ? 1 : 0) + (f.frame ? 1 : 0) + (f.metaOnly ? 1 : 0) + (f.withRolls ? 1 : 0)
  );
}

export function applyFilters<T extends Filterable>(rows: T[], f: WeaponFilters, perks: Record<number, Perk>): T[] {
  if (activeFilters(f) === 0) return rows;
  return rows.filter(
    (r) =>
      (f.elements.length === 0 || f.elements.includes(r.look.damage)) &&
      (f.ammo.length === 0 || f.ammo.includes(r.look.ammo)) &&
      (!f.type || r.type_name === f.type) &&
      (!f.frame || frameOf(r, perks) === f.frame) &&
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
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [props.rows, props.perks, f.type],
  );
  return (
    <div className="pf-filterpanel" role="group" aria-label="Filters">
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
      <div className="pf-filterpanel__row pf-filterpanel__row--controls">
        <Dropdown
          label="Weapon type"
          value={f.type}
          options={[{ value: "", label: "Every weapon type" }, ...types.map((t) => ({ value: t, label: t }))]}
          onChange={(type) => set({ type, frame: "" })}
        />
        <Dropdown
          label="Frame"
          value={frames.includes(f.frame) ? f.frame : ""}
          options={[{ value: "", label: "Every frame" }, ...frames.map((t) => ({ value: t, label: t }))]}
          onChange={(frame) => set({ frame })}
          disabled={frames.length === 0}
        />
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

/** The toolbar button that shows and hides the filter panel, with how many filters are on. */
export function FilterButton(props: { open: boolean; count: number; onClick: () => void; controls: string }) {
  return (
    <button
      type="button"
      className="pf-btn pf-filterbtn"
      aria-expanded={props.open}
      aria-controls={props.controls}
      onClick={props.onClick}
      data-tip="Filter by element, ammo, type, frame and meta"
    >
      <SlidersHorizontal size={16} aria-hidden="true" />
      Filters
      {props.count > 0 && <span className="pf-badge pf-filterbtn__count">{props.count}</span>}
    </button>
  );
}
