// Unstyled vault list and Sync button for the code track. Styling comes with the design system.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Reason = { kind: string; [key: string]: unknown };
type CopyScore = {
  score: number;
  potential: number;
  confidence: number;
  verdict: "keep" | "upgrade" | "replace" | "shard";
  god_roll: { matched: number; total: number } | null;
  reasons: Reason[];
};
type VaultRow = {
  instance_id: string;
  weapon: number;
  name: string;
  type_name: string;
  tier: number;
  masterworked: boolean;
  locked: boolean;
  score: CopyScore | null;
};
type SyncSummary = {
  weapons_known: number;
  copies: number;
  unreadable: number;
  characters_hidden: boolean;
  not_scored: number;
  manifest_version: string;
  synced_at: number;
};

export function Vault({ signedIn }: { signedIn: boolean }) {
  const [context, setContext] = useState<"pve" | "pvp">("pve");
  const [rows, setRows] = useState<VaultRow[]>([]);
  const [step, setStep] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The context shown now, and a counter so only the newest load updates the table. Without them,
  // a sync that ends after the context changed would show the old context's rows.
  const contextRef = useRef(context);
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    invoke<VaultRow[]>("vault", { context: contextRef.current }).then(
      (r) => {
        if (seq === loadSeq.current) setRows(r);
      },
      (e) => {
        if (seq === loadSeq.current) setError(String(e));
      },
    );
  }, []);

  useEffect(() => {
    contextRef.current = context;
    load();
  }, [context, load]);

  useEffect(() => {
    const unlisten = listen<string>("sync-progress", (e) => setStep(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  async function sync() {
    setError(null);
    setStep("Starting");
    try {
      setSummary(await invoke<SyncSummary>("sync_now"));
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setStep(null);
    }
  }

  return (
    <section>
      <h2>Vault</h2>
      <p>
        <button onClick={sync} disabled={!signedIn || step !== null}>
          {step ? "Syncing..." : "Sync with Bungie"}
        </button>{" "}
        <label>
          Context{" "}
          <select value={context} onChange={(e) => setContext(e.target.value as "pve" | "pvp")}>
            <option value="pve">PvE</option>
            <option value="pvp">PvP</option>
          </select>
        </label>
      </p>
      {!signedIn && <p>Sign in with Bungie to sync your vault.</p>}
      {step && <p role="status">{step}...</p>}
      {error && <p role="alert">Sync failed: {error}</p>}
      {summary && (
        <p>
          Synced {summary.copies} weapons at {new Date(summary.synced_at * 1000).toLocaleTimeString()} (Bungie
          item database {summary.manifest_version}, {summary.weapons_known} weapons known).
          {summary.unreadable > 0 && ` ${summary.unreadable} weapons had no perk data.`}
          {summary.characters_hidden && " Bungie hid your characters' inventories; check your privacy settings."}
          {summary.not_scored > 0 && ` ${summary.not_scored} could not be scored.`}
        </p>
      )}
      <p>
        {rows.length} weapons. Scores use placeholder rules until the data pack exists, so every weapon shows "no
        curated roll yet".
      </p>
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Tier</th>
              <th>Score</th>
              <th>Verdict</th>
              <th>Confidence</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.instance_id}>
                <td>{r.name}</td>
                <td>{r.type_name}</td>
                <td>{r.tier || "-"}</td>
                <td>{r.score ? r.score.score.toFixed(0) : "-"}</td>
                <td>{r.score ? r.score.verdict.toUpperCase() : "-"}</td>
                <td>{r.score ? `${Math.round(r.score.confidence * 100)}%` : "-"}</td>
                <td>
                  {[r.masterworked && "masterworked", r.locked && "locked"].filter(Boolean).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
