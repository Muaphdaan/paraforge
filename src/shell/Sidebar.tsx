import { Heart, RefreshCw } from "lucide-react";
import logo from "../assets/brand/logo.png";
import { NAV_GROUPS, PAGES, PageId } from "../app/pages";
import { useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { Mascot } from "../ui/parts";
import type { MascotPose } from "../ui/mascot";

export function Sidebar(props: { page: PageId; collapsed: boolean; onNavigate: (page: PageId) => void }) {
  const session = useSession();
  const now = useNow();
  const syncing = session.syncStep !== null;
  // The mascot reacts to the sync: thinking while it runs, puzzled when it fails.
  const pose: MascotPose = syncing ? "thinking" : session.syncError ? "confused" : "neutral";
  const syncLine = syncing
    ? "Syncing..."
    : session.syncedAt
      ? `Synced ${timeAgo(session.syncedAt, now)}`
      : "Not synced yet";

  return (
    <aside className="pf-panel pf-sidebar" aria-label="ParaForge">
      <div className="pf-brand">
        <img className="pf-brand__logo" src={logo} alt="" draggable={false} />
        {!props.collapsed && (
          <>
            <div className="pf-brand__name">ParaForge</div>
            <div className="pf-brand__tagline">Weapon companion</div>
          </>
        )}
      </div>

      <nav className="pf-nav" aria-label="Sections">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} role="group" aria-label={group.label} style={{ display: "contents" }}>
            {!props.collapsed && <div className="pf-nav__group">{group.label}</div>}
            {group.pages.map((id) => (
              <NavItem key={id} id={id} {...props} />
            ))}
          </div>
        ))}
        <hr className="pf-nav__divider" />
        <NavItem id="settings" {...props} />
      </nav>

      <div className="pf-sidebar__foot">
        {!props.collapsed && (
          <>
            <Mascot pose={pose} className="pf-sidebar__mascot" />
            <p className="pf-sidebar__quote pf-muted">
              "Good rolls, brighter nights"
              <Heart size={12} aria-hidden="true" />
            </p>
          </>
        )}
        <div className="pf-syncbox" style={props.collapsed ? { justifyContent: "center", padding: 4 } : undefined}>
          {!props.collapsed && (
            <div className="pf-syncbox__text">
              <div>{syncLine}</div>
              <div>v{session.info?.version ?? ""}</div>
            </div>
          )}
          <button
            type="button"
            className="pf-iconbtn pf-iconbtn--plain"
            onClick={session.sync}
            disabled={!session.auth?.signed_in}
            aria-disabled={syncing || undefined}
            title={session.auth?.signed_in ? "Sync with Bungie now" : "Sign in to Bungie to sync"}
          >
            <RefreshCw size={18} className={syncing ? "pf-spin" : undefined} aria-hidden="true" />
            <span className="pf-visually-hidden">Sync now</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavItem(props: { id: PageId; page: PageId; collapsed: boolean; onNavigate: (page: PageId) => void }) {
  const def = PAGES[props.id];
  const Icon = def.icon;
  return (
    <button
      type="button"
      className="pf-nav__item"
      aria-current={props.page === props.id ? "page" : undefined}
      title={props.collapsed ? def.label : undefined}
      onClick={() => props.onNavigate(props.id)}
    >
      <Icon size={20} aria-hidden="true" />
      {props.collapsed ? <span className="pf-visually-hidden">{def.label}</span> : (
        <span className="pf-nav__label">{def.label}</span>
      )}
    </button>
  );
}
