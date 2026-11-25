import { CloudCheck, CloudOff, RefreshCw, Search } from "lucide-react";
import { CONTEXTS } from "../app/api";
import { PAGES, PageId } from "../app/pages";
import { useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { Dropdown, Sparkle } from "../ui/parts";

export function Header(props: {
  page: PageId;
  canGoBack: boolean;
  onBack: () => void;
  /** Breadcrumb trail after the group, for example ["Vault", "Static Verdict"]. */
  crumbs?: string[];
  title?: string;
  subtitle?: string;
  onSearch: () => void;
}) {
  const def = PAGES[props.page];
  const session = useSession();
  const crumbs = props.crumbs ?? [def.label];
  return (
    <header className="pf-header">
      <div className="pf-header__lead">
        {(props.canGoBack || def.group) && (
          <div className="pf-header__trail">
            {props.canGoBack && (
              <button
                type="button"
                className="pf-btn pf-btn--primary pf-btn--small"
                onClick={props.onBack}
                data-tip="Back (Alt+Left)"
                aria-keyshortcuts="Alt+ArrowLeft"
              >
                Back
              </button>
            )}
            {def.group && (
              <nav className="pf-crumbs" aria-label="Breadcrumb">
                {def.group}
                {crumbs.map((c, i) => (
                  <span key={i}>
                    {" / "}
                    <span aria-current={i === crumbs.length - 1 ? "page" : undefined}>{c}</span>
                  </span>
                ))}
              </nav>
            )}
          </div>
        )}
        <h1 className="pf-header__title">
          <span>{props.title ?? def.title}</span>
          <Sparkle size={22} />
        </h1>
        <p className="pf-header__subtitle">{props.subtitle ?? def.subtitle}</p>
      </div>
      <div className="pf-header__tools">
        <button
          type="button"
          className="pf-searchbtn"
          onClick={props.onSearch}
          aria-keyshortcuts="Control+K"
          data-tip="Search weapons and perks (Ctrl+K)"
        >
          <Search size={18} aria-hidden="true" />
          <span>Search weapons and perks</span>
          <kbd>Ctrl K</kbd>
        </button>
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
      data-tip={label}
    >
      <Icon size={18} className={busy ? "pf-spin" : undefined} aria-hidden="true" />
    </button>
  );
}
