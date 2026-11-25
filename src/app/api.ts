// Types for the commands the Rust side exposes. Tokens and keys never come back to the interface.
export type AppInfo = {
  version: string;
  core_version: string;
  schema_version: number;
  ruleset: string;
  synced_at: number | null;
  /** The player's Bungie Name from the last sync, for example "NightOwl#4821". */
  player: string | null;
  /** The Bungie membership that `player` belongs to. */
  player_membership_id: string | null;
  manifest_version: string | null;
  weapons_known: number;
  perks_known: number;
  copies: number;
  /** Curated god rolls stored, from the community voltron list. */
  god_rolls: number;
  /** Why the last god-roll update failed, if it did. */
  god_roll_error: string | null;
  rules: ScoringRules;
};

export type ScoringRules = {
  ruleset: string;
  keep_at: number;
  shard_below: number;
  duplicate_margin: number;
  [weight: string]: number | string;
};

export type AuthStatus = {
  has_app_keys: boolean;
  signed_in: boolean;
  membership_id: string | null;
  sign_in_expires_at: number | null;
};

export type SyncSummary = {
  weapons_known: number;
  copies: number;
  unreadable: number;
  characters_hidden: boolean;
  not_scored: number;
  manifest_version: string;
  synced_at: number;
};

export type Verdict = "keep" | "upgrade" | "replace" | "shard";

export type CopyScore = {
  instance_id: string;
  score: number;
  potential: number;
  confidence: number;
  verdict: Verdict;
  god_roll: { matched: number; total: number } | null;
  reasons: { kind: string; [key: string]: unknown }[];
};

export type WeaponLook = {
  /** bungie.net paths, empty when Bungie has none. */
  icon: string;
  watermark: string;
  screenshot: string;
  /** 1 Kinetic, 2 Energy, 3 Power, 0 unknown. */
  slot: number;
  /** Bungie DamageType: 1 Kinetic, 2 Arc, 3 Solar, 4 Void, 6 Stasis, 7 Strand. */
  damage: number;
  /** 1 Primary, 2 Special, 3 Heavy. */
  ammo: number;
  /** 5 Legendary, 6 Exotic. */
  rarity: number;
  /** Where it drops, for example "Last Wish raid". Empty when unknown or before the next sync. */
  source: string;
  /** Its Collections entry, 0 when it has none. */
  collectible: number;
};

export type ColumnRole = "barrel" | "magazine" | "trait";

export type CopyColumn = { options: number[]; enhanced: boolean };

/** A weapon socket that is not a random-perk column. */
export type PartKind = "intrinsic" | "origin" | "masterwork" | "mod" | "catalyst";

/**
 * ParaForge's meta measure is curator consensus: how many separate sections of the community
 * god-roll list recommend a weapon. At this many it counts as a meta pick.
 */
export const META_TOP = 3;
export type MetaTier = "meta" | "listed" | "none";
export function metaTier(meta: number | undefined): MetaTier {
  return (meta ?? 0) >= META_TOP ? "meta" : (meta ?? 0) > 0 ? "listed" : "none";
}
export const META_TIER_LABEL: Record<MetaTier, string> = {
  meta: "Meta picks",
  listed: "Also recommended",
  none: "Everything else",
};
export const META_TIER_ORDER: MetaTier[] = ["meta", "listed", "none"];
/** Meta weapons first (most curator sources first), then the rest. */
export const byMeta = (a: { meta?: number }, b: { meta?: number }) => (b.meta ?? 0) - (a.meta ?? 0);
export function metaTip(meta: number | undefined): string {
  const n = meta ?? 0;
  return n === 0 ? "" : `Recommended by ${n} curator ${n === 1 ? "source" : "sources"}`;
}

/** A curated god roll from the community voltron list, from the `god_rolls` command. */
export type CuratedRoll = {
  weapon: number;
  context: ScoreContext;
  /** Wanted perks per column; an empty column takes any perk. */
  columns: number[][];
  curator: string;
  title: string;
  /** The curator's guide: what the roll is for and how to play it. */
  notes: string;
  /** Lowercase tags such as "god-pve", "mkb", "controller", "pve-boss". */
  tags: string[];
  /** The curator's masterwork pick; empty when not given. */
  masterwork: string;
  /** The curator's mod pick; empty when not given. */
  mods: string;
  /** The list section it came from. */
  source: string;
};

/** A part socket on a weapon definition. `pool` is filled for the frame and the origin trait. */
export type WeaponPart = { kind: PartKind; socket_index: number; pool: number[]; empty: number[] };

/** A part on an owned copy; `plugged` is null when the socket is empty. */
export type CopyPart = { kind: PartKind; plugged: number | null; enhanced: boolean; options: number[] };

export type VaultRow = {
  instance_id: string;
  weapon: number;
  name: string;
  type_name: string;
  tier: number;
  masterworked: boolean;
  locked: boolean;
  score: CopyScore | null;
  look: WeaponLook;
  roles: ColumnRole[];
  columns: CopyColumn[];
  /** Stat values by Bungie stat hash. */
  stats: Record<string, number>;
  location: CopyLocation;
  /** Frame, origin trait, masterwork, mod and catalyst. Missing before the first sync with them. */
  parts?: CopyPart[];
  /** How many curator sources recommend this weapon (ParaForge's meta measure); 0 for none. */
  meta?: number;
};

export type CopyLocation = "vault" | "inventory" | "equipped";

export const LOCATION_LABEL: Record<CopyLocation, string> = {
  vault: "Vault",
  inventory: "On a character",
  equipped: "Equipped",
};

/** One weapon's definition, from the `weapon` command. */
export type WeaponDef = {
  hash: number;
  name: string;
  type_name: string;
  columns: ColumnRole[];
  look: WeaponLook;
  /** Every perk that can currently roll in each column, same order as `columns`. */
  pools: number[][];
  parts?: WeaponPart[];
};

/** One weapon in the Codex, from the `codex` command. */
export type CodexRow = {
  hash: number;
  name: string;
  type_name: string;
  look: WeaponLook;
  roles: ColumnRole[];
  pools: number[][];
  parts?: WeaponPart[];
  /** Copies you own. */
  owned: number;
  /** How many curator sources recommend this weapon (ParaForge's meta measure); 0 for none. */
  meta?: number;
};

/** A roll on the Chase list, from the `chase_list` command. */
export type ChaseRoll = {
  id: number;
  weapon: number;
  /** Wanted perks per column, in column order; an empty column takes any perk. */
  perks: number[][];
  /** When it was added, Unix seconds as text. */
  added: string;
};

/**
 * Weapon stats in the order DIM and the game show them, by Bungie stat hash.
 * `bar: false` stats are counts or times, shown as a number only.
 */
export const WEAPON_STATS: { hash: number; name: string; bar: boolean }[] = [
  { hash: 4284893193, name: "RPM", bar: false },
  { hash: 2961396640, name: "Charge time", bar: false },
  { hash: 447667954, name: "Draw time", bar: false },
  { hash: 4043523819, name: "Impact", bar: true },
  { hash: 3614673599, name: "Blast radius", bar: true },
  { hash: 2523465841, name: "Velocity", bar: true },
  { hash: 1240592695, name: "Range", bar: true },
  { hash: 1591432999, name: "Accuracy", bar: true },
  { hash: 1842278586, name: "Shield duration", bar: true },
  { hash: 155624089, name: "Stability", bar: true },
  { hash: 943549884, name: "Handling", bar: true },
  { hash: 4188031367, name: "Reload speed", bar: true },
  { hash: 2837207746, name: "Swing speed", bar: true },
  { hash: 3022301683, name: "Charge rate", bar: true },
  { hash: 209426660, name: "Guard resistance", bar: true },
  { hash: 2762071195, name: "Guard efficiency", bar: true },
  { hash: 3736848092, name: "Guard endurance", bar: true },
  { hash: 3085395333, name: "Persistence", bar: true },
  { hash: 3481294762, name: "Heat generated", bar: true },
  { hash: 4006394725, name: "Cooling efficiency", bar: true },
  { hash: 602570185, name: "Vent speed", bar: true },
  { hash: 1345609583, name: "Aim assistance", bar: true },
  { hash: 2714457168, name: "Airborne effectiveness", bar: true },
  { hash: 3555269338, name: "Zoom", bar: false },
  { hash: 2715839340, name: "Recoil direction", bar: true },
  { hash: 1931675084, name: "Ammo generation", bar: true },
  { hash: 3871231066, name: "Magazine", bar: false },
  { hash: 925767036, name: "Ammo capacity", bar: false },
];

/** "High", "Medium" or "Low", from a score's 0 to 1 confidence. */
export function confidenceLabel(confidence: number): string {
  return confidence >= 0.8 ? "High" : confidence >= 0.5 ? "Medium" : "Low";
}

export type Perk = {
  hash: number;
  name: string;
  plug_category: string;
  icon: string;
  description: string;
};

/** Full URL of a bungie.net image path, or null when there is none. */
export function bungieImage(path: string | undefined): string | null {
  return path ? `https://www.bungie.net${path}` : null;
}

export const SLOTS: Record<number, string> = { 1: "Kinetic", 2: "Energy", 3: "Power", 0: "Other" };

export const AMMO: Record<number, string> = { 1: "Primary", 2: "Special", 3: "Heavy" };

export const ELEMENTS: Record<number, { name: string; color: string }> = {
  1: { name: "Kinetic", color: "#e8eaf6" },
  2: { name: "Arc", color: "#7aecf3" },
  3: { name: "Solar", color: "#f2a33a" },
  4: { name: "Void", color: "#c49bff" },
  6: { name: "Stasis", color: "#6f9bff" },
  7: { name: "Strand", color: "#3fe08a" },
};

export const ROLE_LABELS: Record<ColumnRole, string> = { barrel: "Barrel", magazine: "Magazine", trait: "Trait" };

const CONTEXT_LABEL: Record<ScoreContext, string> = { pve: "PvE", pvp: "PvP" };

function joinRoles(roles: ColumnRole[]): string {
  const words = [...new Set(roles.map((r) => (r === "trait" ? "traits" : r)))];
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A whole number the way Rust's `{:.0}` prints it: exact halves round to even. */
function whole(x: unknown): string {
  const v = Number(x);
  const f = Math.floor(v);
  const d = v - f;
  const n = d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
  return String(Object.is(n, -0) ? 0 : n);
}

/** Plain English for a score reason; mirrors Reason::text in the Rust core. */
export function reasonText(reason: CopyScore["reasons"][number], context: ScoreContext): string {
  const ctx = CONTEXT_LABEL[context];
  const r = reason as Record<string, unknown>;
  switch (reason.kind) {
    case "top_traits": {
      const count = Number(r.count);
      const of = Number(r.of);
      if (count === of && of === 2) return `Has both top ${ctx} perks`;
      if (count === of) return `Has all top ${ctx} perks`;
      if (count === 1) return `Has a top ${ctx} perk`;
      return `Has ${count} of ${of} top ${ctx} perks`;
    }
    case "enhanced":
      return `Enhanced ${joinRoles((r.roles as ColumnRole[]) ?? [])}`;
    case "roll_match":
      return `Matches the curated roll in ${r.matched} of ${r.total} columns`;
    case "no_curated_roll":
      return "No curated roll yet, scored on perk ratings only";
    case "best_of_copies":
      return `Best of your ${r.copies} copies`;
    case "better_copy_owned":
      return `You own a better copy (${whole(r.score)})`;
    case "upgrade_potential":
      return `Masterwork and enhanced perks would take it to ${whole(r.potential)}`;
    default:
      return reason.kind.replace(/_/g, " ");
  }
}

export type ScoreContext = "pve" | "pvp";

export const CONTEXTS: { value: ScoreContext; label: string }[] = [
  { value: "pve", label: "PvE" },
  { value: "pvp", label: "PvP" },
];
