import { CloudCheck, CloudOff, RefreshCw } from "lucide-react";
import { CONTEXTS } from "../app/api";
import { PAGES, PageId } from "../app/pages";
import { useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { Dropdown, Sparkle } from "../ui/parts";

export function Header(props: { page: PageId; canGoBack: boolean; onBack: () => void }) {
  const def = PAGES[props.page];
  const session = useSession();
  return (
    <header className="pf-header">
      <div className="pf-header__lead">
        {(props.canGoBack || def.group) && (
        <div className="pf-header__trail">
          {props.canGoBack && (
            <button type="button" className="pf-btn pf-btn--primary pf-btn--small" onClick={props.onBack} title="Back (Alt+Left)">
              Back
            </button>
          )}
          {def.group && (
            <nav className="pf-crumbs" aria-label="Breadcrumb">
              {def.group} / <span aria-current="page">{def.id === "settings" ? "Account" : def.label}</span>
            </nav>
          )}
        </div>
        )}
        <h1 className="pf-header__title">
          <span>{def.title}</span>
          <Sparkle size={22} />
        </h1>
        <p className="pf-header__subtitle">{def.subtitle}</p>
      </div>
      <div className="pf-header__tools">
        <Dropdown label="Score context" value={session.context} options={CONTEXTS} onChange={session.setContext} />
        <SyncStatus />
      </div>
    </header>
  );
}

/**
 * Sync as a single round icon: green when synced, spinning while syncing, amber when it failed.
 * The time of the last sync is in the tooltip. Click to sync now.
 */
function SyncStatus() {
  const session = useSession();
  const now = useNow();
  const signedIn = Boolean(session.auth?.signed_in);
  let tone: string;
  let Icon = RefreshCw;
  let label: string;
  if (session.syncStep) {
    tone = "busy";
    label = `Syncing: ${session.syncStep}`;
  } else if (session.syncError) {
    tone = "warn";
    Icon = CloudOff;
    label = `Sync failed: ${session.syncError}. Click to try again.`;
  } else if (session.syncedAt) {
    tone = "live";
    Icon = CloudCheck;
    label = `Synced ${timeAgo(session.syncedAt, now)}. Click to sync now.`;
  } else {
    tone = "idle";
    label = signedIn ? "Not synced yet. Click to sync now." : "Sign in to Bungie in Settings to sync.";
  }
  const busy = tone === "busy";
  return (
    <button
      type="button"
      className={`pf-status pf-status--icon pf-status--${tone}`}
      onClick={busy ? undefined : session.sync}
      disabled={!signedIn && !busy}
      aria-disabled={busy || undefined}
      aria-label={label}
      title={label}
    >
      <Icon size={18} className={busy ? "pf-spin" : undefined} aria-hidden="true" />
    </button>
  );
}
