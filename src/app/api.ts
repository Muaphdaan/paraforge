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

export type VaultRow = {
  instance_id: string;
  weapon: number;
  name: string;
  type_name: string;
  tier: number;
  masterworked: boolean;
  locked: boolean;
  score: CopyScore | null;
};

export type ScoreContext = "pve" | "pvp";

export const CONTEXTS: { value: ScoreContext; label: string }[] = [
  { value: "pve", label: "PvE" },
  { value: "pvp", label: "PvP" },
];
