// Weapon pieces shared by Vault and Home: the icon tile, element and ammo badges, perk icons.
// Icons and screenshots come from Bungie's servers (bungie.net), like DIM and light.gg.
import { useState } from "react";
import { Circle, Crown, Hammer, Hexagon, Lock, ShieldAlert, Snowflake, Spline, Sun, Trash2, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AMMO, BREAKERS, CopyColumn, CopyPart, ELEMENTS, WeaponLook, PartKind, Perk, VaultRow, WeaponPart, bungieImage, metaTier, metaTip } from "../app/api";
import { SEASONS, seasonLabel } from "../app/seasons";

const ELEMENT_ICONS: Record<number, LucideIcon> = {
  1: Circle,
  2: Zap,
  3: Sun,
  4: Hexagon,
  6: Snowflake,
  7: Spline,
};

/** A bungie.net image that quietly disappears when it cannot load (offline, or Bungie has none). */
export function BungieImage(props: { path: string; className?: string; alt?: string }) {
  const src = bungieImage(props.path);
  // Remember which image failed, so a new path (another weapon) gets its own chance to load.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return null;
  return (
    <img
      className={props.className}
      src={src}
      alt={props.alt ?? ""}
      loading="lazy"
      draggable={false}
      onError={() => setFailedSrc(src)}
    />
  );
}

export function ElementIcon({ damage, size = 14 }: { damage: number; size?: number }) {
  const element = ELEMENTS[damage];
  const Icon = ELEMENT_ICONS[damage];
  if (!element || !Icon) return null;
  return <Icon size={size} strokeWidth={2.5} color={element.color} aria-label={element.name} />;
}

export function ElementBadge({ damage }: { damage: number }) {
  const element = ELEMENTS[damage];
  if (!element) return null;
  return (
    <span className="pf-chip" style={{ color: element.color }}>
      <ElementIcon damage={damage} />
      {element.name}
    </span>
  );
}

export function AmmoBadge({ ammo }: { ammo: number }) {
  const label = AMMO[ammo];
  if (!label) return null;
  return (
    <span className={`pf-chip pf-ammo pf-ammo--${ammo}`}>
      <span className="pf-ammo__mark" aria-hidden="true" />
      {label}
    </span>
  );
}

const VERDICT_LABEL = { keep: "Keep", upgrade: "Upgrade", replace: "Replace", shard: "Shard" } as const;

/**
 * The DIM-style weapon tile: Bungie's icon with its season badge, a gold frame for exotics,
 * the score in the verdict's colour, the element, tier pips and a lock when locked.
 */
export function WeaponTile(props: { row: VaultRow; selected?: boolean; onSelect: () => void }) {
  const { row } = props;
  const verdict = row.score?.verdict;
  const label = [
    row.name,
    row.type_name,
    row.tier > 0 ? `Tier ${row.tier}` : null,
    row.score ? `score ${row.score.score.toFixed(0)}, ${VERDICT_LABEL[row.score.verdict]}` : "not scored",
    row.locked ? "locked" : null,
    metaTier(row.meta) === "meta" ? "meta pick" : null,
    row.mark === "shard" ? "marked to shard" : row.mark === "keep" ? "marked to keep" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className="pf-tile"
      data-rarity={row.look.rarity}
      data-instance={row.instance_id}
      data-masterworked={row.masterworked || undefined}
      data-mark={row.mark ?? undefined}
      aria-pressed={props.selected}
      aria-label={label}
      data-tip={`${row.name}\n${row.look.rarity === 6 ? "Exotic " : ""}${row.type_name}${row.tier > 0 ? ` · Tier ${row.tier}` : ""}${row.score ? ` · ${row.score.score.toFixed(0)} ${VERDICT_LABEL[row.score.verdict]}` : ""}${row.meta ? `\n${metaTip(row.meta)}` : ""}`}
      onClick={props.onSelect}
    >
      <span className="pf-tile__art">
        <span className="pf-tile__fallback" aria-hidden="true">
          {row.name.slice(0, 1)}
        </span>
        <BungieImage path={row.look.icon} className="pf-tile__icon" />
        <BungieImage path={row.look.watermark} className="pf-tile__watermark" />
        {row.locked && (
          <span className="pf-tile__lock" aria-hidden="true">
            <Lock size={10} strokeWidth={3} />
          </span>
        )}
        <MetaMark meta={row.meta} />
        {row.mark === "shard" && (
          <span className="pf-tile__shard" aria-hidden="true">
            <Trash2 size={10} strokeWidth={2.5} />
          </span>
        )}
      </span>
      <span className="pf-tile__bar" aria-hidden="true">
        <span className="pf-tile__element">
          <ElementIcon damage={row.look.damage} size={11} />
        </span>
        <span className={`pf-tile__score pf-v--${verdict ?? "none"}`}>
          {row.score ? row.score.score.toFixed(0) : "-"}
        </span>
      </span>
      {row.tier > 0 && (
        <span className="pf-tile__pips" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} data-on={i < row.tier || undefined} />
          ))}
        </span>
      )}
    </button>
  );
}

/** A perk as a round icon, with its name and description on hover. */
/** `decorative` hides it from screen readers where the perk's name is already shown as text. */
export function PerkIcon(props: {
  perk: Perk | undefined;
  hash: number;
  enhanced?: boolean;
  size?: number;
  decorative?: boolean;
}) {
  const size = props.size ?? 32;
  const name = props.perk?.name ?? `Perk ${props.hash}`;
  const title = props.perk?.description ? `${name}${props.enhanced ? " (enhanced)" : ""}\n${props.perk.description}` : name;
  return (
    <span
      className="pf-perk"
      data-enhanced={props.enhanced || undefined}
      style={{ width: size, height: size }}
      data-tip={title}
      {...(props.decorative
        ? { "aria-hidden": true }
        : {
            role: "img",
            "aria-label": props.enhanced ? `${name} (enhanced)` : name,
            "aria-description": props.perk?.description || undefined,
          })}
    >
      {props.perk?.icon ? <BungieImage path={props.perk.icon} className="pf-perk__icon" /> : null}
    </span>
  );
}

const PART_LABEL: Record<PartKind, string> = {
  intrinsic: "Frame",
  origin: "Origin trait",
  masterwork: "Masterwork",
  mod: "Mod",
  catalyst: "Catalyst",
};

const PART_EMPTY: Record<PartKind, string> = {
  intrinsic: "None",
  origin: "None",
  masterwork: "Not masterworked",
  mod: "No mod",
  catalyst: "Catalyst not finished or not found yet",
};

/** One part as shown: its kind and the perks in it (both options for a two-choice origin trait). */
export type ShownPart = {
  kind: PartKind;
  perks: number[];
  /** The perk that is enhanced, if any. */
  enhanced?: number;
  /** The perk in use on this copy, when it has a choice (origin traits) or for the masterwork and mod. */
  selected?: number;
};

/** A copy's frame, origin trait, masterwork, mod and catalyst. */
export function copyParts(parts: CopyPart[] | undefined): ShownPart[] {
  return (parts ?? []).map((p) => ({
    kind: p.kind,
    perks: p.options.length > 0 ? p.options : p.plugged !== null ? [p.plugged] : [],
    enhanced: p.enhanced && p.plugged !== null ? p.plugged : undefined,
    // The frame never changes, so only parts that can differ between copies are marked.
    selected: p.kind === "intrinsic" ? undefined : (p.plugged ?? undefined),
  }));
}

/** What every copy of a weapon gets: its frame and origin trait. Masterwork and mod are your pick. */
export function weaponParts(parts: WeaponPart[] | undefined): ShownPart[] {
  return (parts ?? [])
    .filter((p) => p.kind === "intrinsic" || p.kind === "origin")
    .map((p) => ({ kind: p.kind, perks: p.pool.filter((h) => !p.empty.includes(h)) }));
}

/** The non-column parts of a weapon, one row each, in the same panel style as the perk columns. */
export function PartList(props: {
  parts: ShownPart[];
  perks: Record<number, Perk>;
  exotic?: boolean;
  size?: number;
  /** Show each perk's description under its name. */
  describe?: boolean;
}) {
  if (props.parts.length === 0) return null;
  return (
    <div className="pf-perkcols pf-parts">
      {props.parts.map((part, i) => {
        const label = part.kind === "intrinsic" && props.exotic ? "Intrinsic" : PART_LABEL[part.kind];
        return (
          <div key={i} className="pf-perkcol" role="group" aria-label={label}>
            <div className="pf-perkcol__label">{label}</div>
            {part.perks.length === 0 ? (
              <span className="pf-muted">{PART_EMPTY[part.kind]}</span>
            ) : (
              part.perks.map((hash) => {
                const perk = props.perks[hash];
                const enhanced = part.enhanced === hash;
                const selected = part.selected === hash;
                return (
                  <div key={hash} className="pf-perkrow" data-selected={selected || undefined}>
                    <PerkIcon hash={hash} perk={perk} enhanced={enhanced} size={props.size ?? 34} decorative />
                    <span className="pf-perkrow__name">
                      {perk?.name ?? "Unknown perk"}
                      {enhanced && <span className="pf-perkrow__enh">Enhanced</span>}
                      {selected && part.perks.length > 1 && <ActiveTag />}
                      {props.describe && perk?.description && (
                        <span className="pf-part__desc">{perk.description}</span>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Champion breaker, season, craftable and adept chips for a weapon's fact list. */
export function WeaponExtraChips({ look }: { look: WeaponLook }) {
  const breaker = look.breaker ? BREAKERS[look.breaker] : undefined;
  return (
    <>
      {breaker && (
        <span className="pf-chip pf-chip--champion" data-breaker={look.breaker} data-tip={`Stuns ${breaker} champions on its own`}>
          <ShieldAlert size={12} aria-hidden="true" />
          {breaker}
        </span>
      )}
      {look.craftable && (
        <span className="pf-chip" data-tip="Has a crafting pattern">
          <Hammer size={12} aria-hidden="true" />
          Craftable
        </span>
      )}
      {look.adept && <span className="pf-chip pf-chip--gold">Adept</span>}
      {look.season ? (
        <span className="pf-chip" data-tip={`Came out in ${seasonLabel(look.season)}`}>
          {SEASONS[look.season]?.name ?? `Season ${look.season}`}
        </span>
      ) : null}
    </>
  );
}

/** "Active" next to the perk a copy is using right now. */
export function ActiveTag() {
  return <span className="pf-perkrow__on">Active</span>;
}

/** A copy's perks in one column with the selected one first. */
export function selectedFirst(col: CopyColumn): number[] {
  const on = col.plugged;
  return on != null && col.options.includes(on) ? [on, ...col.options.filter((h) => h !== on)] : col.options;
}

/** A small crown on the tiles of meta weapons (see `META_TOP`). */
export function MetaMark(props: { meta: number | undefined }) {
  if (metaTier(props.meta) !== "meta") return null;
  return (
    <span className="pf-tile__meta" aria-hidden="true">
      <Crown size={10} strokeWidth={2.5} />
    </span>
  );
}
