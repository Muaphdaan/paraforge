// Types for the commands the Rust side exposes. Tokens and keys never come back to the interface.
export type AppInfo = {
  version: string;
  core_version: string;
  schema_version: number;
  ruleset: string;
  synced_at: number | null;
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
};

export type ColumnRole = "barrel" | "magazine" | "trait";

export type CopyColumn = { options: number[]; enhanced: boolean };

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
};

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
