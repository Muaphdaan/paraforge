// The vault list. Phase 2 replaces this table with the approved weapon cards and detail panel.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VaultRow } from "../app/api";
import { PageId } from "../app/pages";
import { useSession } from "../app/session";
import { EmptyState, TierPill, VerdictPill } from "../ui/parts";

export function VaultPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const session = useSession();
  const [rows, setRows] = useState<VaultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest load may update the table, so a slow reply for the old context is dropped.
  const loadSeq = useRef(0);
  const context = session.context;

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    invoke<VaultRow[]>("vault", { context }).then(
      (r) => {
        if (seq === loadSeq.current) {
          setRows(r);
          setError(null);
        }
      },
      (e) => {
        if (seq === loadSeq.current) setError(String(e));
      },
    );
  }, [context]);

  useEffect(load, [load, session.dataVersion]);

  if (error) {
    return (
      <EmptyState pose="confused" title="Your vault could not be read">
        {error}
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
    <section className="pf-panel">
      <div className="pf-vault__toolbar">
        <p className="pf-vault__summary">
          {rows.length} weapons. Scores use placeholder rules until the data pack arrives, so they will change.
        </p>
      </div>
      <table className="pf-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Tier</th>
            <th className="pf-table__num">Score</th>
            <th>Verdict</th>
            <th className="pf-table__num">Confidence</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.instance_id}>
              <td className="pf-table__name">{r.name}</td>
              <td className="pf-muted">{r.type_name}</td>
              <td>
                <TierPill tier={r.tier} />
              </td>
              <td className="pf-table__num">{r.score ? r.score.score.toFixed(0) : "-"}</td>
              <td>{r.score ? <VerdictPill verdict={r.score.verdict} /> : <span className="pf-muted">-</span>}</td>
              <td className="pf-table__num pf-muted">
                {r.score ? `${Math.round(r.score.confidence * 100)}%` : "-"}
              </td>
              <td className="pf-muted">
                {[r.masterworked && "masterworked", r.locked && "locked"].filter(Boolean).join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
