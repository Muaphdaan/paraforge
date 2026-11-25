// The strip along the bottom of the window: sync state, the signed-in player, what needs attention
// in the vault, the god-roll list and the scoring mode.
import {
  CircleAlert,
  CloudCheck,
  CloudOff,
  Crown,
  Download,
  Gamepad2,
  Inbox,
  RefreshCw,
  Trash2,
  UserRound,
} from "lucide-react";
import { useMemo } from "react";
import { CONTEXTS } from "../app/api";
import { PageId } from "../app/pages";
import { useSession } from "../app/session";
import { useUpdates } from "../app/updates";
import { timeAgo, useNow } from "../app/time";

export function StatusBar({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const session = useSession();
  const updates = useUpdates();
  const now = useNow();
  const info = session.info;
  const signedIn = Boolean(session.auth?.signed_in);
  const counts = useMemo(() => {
    const rows = session.vault ?? [];
    return {
      weapons: rows.length,
      drops: rows.filter((r) => (r.first_seen ?? 0) > 0 && !r.mark).length,
      shard: rows.filter((r) => r.mark === "shard").length,
    };
  }, [session.vault]);

  let sync: { tone: string; Icon: typeof RefreshCw; text: string; tip: string };
  if (session.syncStep) {
    sync = { tone: "busy", Icon: RefreshCw, text: session.syncStep, tip: "Syncing with Bungie" };
  } else if (session.syncError) {
    sync = { tone: "warn", Icon: CloudOff, text: "Sync failed", tip: `${session.syncError}. Click to try again.` };
  } else if (session.syncedAt) {
    sync = {
      tone: "live",
      Icon: CloudCheck,
      text: `Synced ${timeAgo(session.syncedAt, now)}`,
      tip: `Bungie answered on the last sync. ${
        session.syncPrefs.interval > 0
          ? `ParaForge syncs every ${session.syncPrefs.interval} minutes while it is open.`
          : "Automatic sync is off."
      } Click to sync now.`,
    };
  } else {
    sync = {
      tone: "idle",
      Icon: CloudOff,
      text: signedIn ? "Not synced yet" : "Not signed in",
      tip: signedIn ? "Click to sync now." : "Sign in to Bungie in Settings.",
    };
  }
  const busy = sync.tone === "busy";
  const contextLabel = CONTEXTS.find((c) => c.value === session.context)?.label ?? "";
  const rollError = info?.god_roll_error;

  return (
    <footer className="pf-statusbar" aria-label="Status">
      <button
        type="button"
        className={`pf-statusbar__item pf-statusbar__sync pf-statusbar--${sync.tone}`}
        onClick={busy ? undefined : signedIn ? session.sync : () => onNavigate("settings")}
        aria-disabled={busy || undefined}
        data-tip={sync.tip}
        aria-description={sync.tip}
      >
        <sync.Icon size={14} className={busy ? "pf-spin" : undefined} aria-hidden="true" />
        <span>{sync.text}</span>
      </button>
      {/* Announces the sync state when it changes, without the ticking "3 min ago". */}
      <span className="pf-visually-hidden" aria-live="polite">
        {session.syncStep ?? (session.syncError ? "Sync failed" : "")}
      </span>
      {info?.player && signedIn && (
        <span className="pf-statusbar__item" data-tip="The Bungie account ParaForge reads">
          <UserRound size={14} aria-hidden="true" />
          {info.player}
        </span>
      )}
      {session.playing && (
        <span className="pf-statusbar__item pf-statusbar--live" data-tip="Destiny 2 is running: ParaForge syncs more often">
          <Gamepad2 size={14} aria-hidden="true" />
          In game
        </span>
      )}
      <span className="pf-statusbar__spacer" />
      {session.vault && <span className="pf-statusbar__item">{counts.weapons.toLocaleString()} weapons</span>}
      {counts.drops > 0 && (
        <button
          type="button"
          className="pf-statusbar__item pf-statusbar--accent"
          onClick={() => onNavigate("triage")}
          data-tip="Review your new drops"
         
        >
          <Inbox size={14} aria-hidden="true" />
          {counts.drops} new {counts.drops === 1 ? "drop" : "drops"}
        </button>
      )}
      {counts.shard > 0 && (
        <button
          type="button"
          className="pf-statusbar__item"
          onClick={() => onNavigate("triage")}
          data-tip="Copies you marked to shard; dismantle them in the game"
         
        >
          <Trash2 size={14} aria-hidden="true" />
          {counts.shard} to shard
        </button>
      )}
      {info && (
        <span
          className={`pf-statusbar__item${rollError ? " pf-statusbar--warn" : ""}`}
          // Reachable by Tab when there is an error, so its tooltip can be read.
          tabIndex={rollError ? 0 : undefined}
          data-tip={
            rollError
              ? `The god-roll list could not be updated: ${rollError}. ParaForge keeps the last good rolls.`
              : "Community god rolls from the voltron list, checked every six hours"
          }
         
        >
          {rollError ? <CircleAlert size={14} aria-hidden="true" /> : <Crown size={14} aria-hidden="true" />}
          {info.god_rolls > 0 ? `${info.god_rolls.toLocaleString()} god rolls` : "No god rolls yet"}
          {rollError && (
            <span className="pf-visually-hidden">
              {`. The god-roll list could not be updated: ${rollError}. ParaForge keeps the last good rolls.`}
            </span>
          )}
        </span>
      )}
      <span className="pf-statusbar__item" data-tip="Scores are for this mode; change it in the header or View menu">
        Scoring: {contextLabel}
      </span>
      {(updates.state.status === "ready" || updates.state.status === "installing") && (
        <button
          type="button"
          className="pf-statusbar__item pf-statusbar--accent"
          onClick={updates.state.status === "ready" ? () => void updates.restart() : undefined}
          aria-disabled={updates.state.status === "installing" || undefined}
          data-tip={`ParaForge ${updates.state.version} is downloaded. Restart to install it.`}
        >
          <Download size={14} aria-hidden="true" />
          {updates.state.status === "installing" ? "Updating..." : "Restart to update"}
        </button>
      )}
      {info && <span className="pf-statusbar__item pf-statusbar__version">v{info.version}</span>}
    </footer>
  );
}
