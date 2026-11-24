// Weapon pieces shared by Vault and Home: the icon tile, element and ammo badges, perk icons.
// Icons and screenshots come from Bungie's servers (bungie.net), like DIM and light.gg.
import { useState } from "react";
import { Circle, Hexagon, Lock, Snowflake, Spline, Sun, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AMMO, ELEMENTS, Perk, VaultRow, bungieImage } from "../app/api";

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
      aria-pressed={props.selected}
      aria-label={label}
      title={`${row.name} · ${row.type_name}`}
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
export function PerkIcon(props: { perk: Perk | undefined; hash: number; enhanced?: boolean; size?: number }) {
  const size = props.size ?? 32;
  const name = props.perk?.name ?? `Perk ${props.hash}`;
  const title = props.perk?.description ? `${name}${props.enhanced ? " (enhanced)" : ""}\n${props.perk.description}` : name;
  return (
    <span
      className="pf-perk"
      data-enhanced={props.enhanced || undefined}
      style={{ width: size, height: size }}
      title={title}
      aria-label={name}
      role="img"
    >
      {props.perk?.icon ? <BungieImage path={props.perk.icon} className="pf-perk__icon" /> : null}
    </span>
  );
}
