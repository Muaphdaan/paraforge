import { ChevronsLeft, ChevronsRight, CloudOff, RefreshCw } from "lucide-react";
import { CONTEXTS } from "../app/api";
import { PAGES, PageId } from "../app/pages";
import { useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { Dropdown, Sparkle } from "../ui/parts";

export function Header(props: {
  page: PageId;
  collapsed: boolean;
  onToggleSidebar: () => void;
  canGoBack: boolean;
  onBack: () => void;
}) {
  const def = PAGES[props.page];
  const session = useSession();
  return (
    <header className="pf-header">
      <div className="pf-header__lead">
        <div className="pf-header__trail">
          <button
            type="button"
            className="pf-iconbtn pf-header__collapse"
            onClick={props.onToggleSidebar}
            title={props.collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
          >
            {props.collapsed ? <ChevronsRight size={18} aria-hidden="true" /> : <ChevronsLeft size={18} aria-hidden="true" />}
            <span className="pf-visually-hidden">{props.collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
          </button>
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

/** The sync pill: when the vault was last synced, live progress while syncing. Click to sync. */
function SyncStatus() {
  const session = useSession();
  const now = useNow();
  const signedIn = Boolean(session.auth?.signed_in);
  if (session.syncStep) {
    return (
      <button type="button" className="pf-status pf-status--busy" aria-disabled="true">
        <RefreshCw size={16} className="pf-spin" aria-hidden="true" />
        Syncing...
      </button>
    );
  }
  if (session.syncError) {
    return (
      <button type="button" className="pf-status pf-status--warn" onClick={session.sync} disabled={!signedIn} title="Sync again">
        <CloudOff size={16} aria-hidden="true" />
        Sync failed
      </button>
    );
  }
  if (session.syncedAt) {
    return (
      <button type="button" className="pf-status pf-status--live" onClick={session.sync} disabled={!signedIn} title="Sync now">
        <span className="pf-status__dot" aria-hidden="true" />
        Synced · {timeAgo(session.syncedAt, now)}
      </button>
    );
  }
  return (
    <button type="button" className="pf-status" onClick={session.sync} disabled={!signedIn} title="Sync now">
      <RefreshCw size={16} aria-hidden="true" />
      Not synced
    </button>
  );
}
