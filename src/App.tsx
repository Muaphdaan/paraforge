// The ParaForge window: floating sidebar, page header, banners and the current section.
import { useCallback, useEffect, useState } from "react";
import backdrop from "./assets/backdrop.webp";
import { PAGE_ORDER, PageId } from "./app/pages";
import { SessionProvider, useSession } from "./app/session";
import { HomePage } from "./pages/HomePage";
import { ChasePage, CodexPage, CollectionsPage } from "./pages/Placeholders";
import { SETTINGS_SECTIONS, SettingsPage, SettingsSection } from "./pages/SettingsPage";
import { FirstRun } from "./pages/FirstRun";
import { WeaponPage } from "./pages/WeaponPage";
import { SearchPalette } from "./shell/SearchPalette";
import { CONTEXTS } from "./app/api";
import { VaultPage } from "./pages/VaultPage";
import { Header } from "./shell/Header";
import { Sidebar } from "./shell/Sidebar";
import { Banner } from "./ui/parts";

const COLLAPSED_KEY = "paraforge.sidebarCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

type Route = { page: PageId; weapon?: string };

function Shell() {
  const session = useSession();
  // Visited pages, newest last; Back pops one.
  const [history, setHistory] = useState<Route[]>([{ page: "home" }]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  const [searchOpen, setSearchOpen] = useState(false);
  const route = history[history.length - 1];
  const page = route.page;

  const push = useCallback((next: Route) => {
    setHistory((h) => {
      const top = h[h.length - 1];
      return top.page === next.page && top.weapon === next.weapon ? h : [...h.slice(-49), next];
    });
  }, []);
  // The weapon to select when the Vault is reached from a Home tile; any other navigation clears it.
  const [vaultFocus, setVaultFocus] = useState<string | null>(null);
  const navigate = useCallback(
    (next: PageId) => {
      setVaultFocus(null);
      push({ page: next });
    },
    [push],
  );
  const selectInVault = useCallback(
    (instanceId: string) => {
      navigate("vault");
      setVaultFocus(instanceId);
    },
    [navigate],
  );
  const openWeaponPage = useCallback((instanceId: string) => push({ page: "weapon", weapon: instanceId }), [push]);
  // Switching copies on a weapon page replaces it, so Back still leads out of the weapon.
  const switchCopy = useCallback(
    (instanceId: string) => setHistory((h) => [...h.slice(0, -1), { page: "weapon", weapon: instanceId }]),
    [],
  );
  const back = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);
  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage can be unavailable; the sidebar then just opens expanded next time.
    }
  }, [collapsed]);

  // Ctrl+K searches, Ctrl+B collapses the sidebar, Ctrl+1 to Ctrl+6 open the sections, Alt+Left goes back.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.ctrlKey && !e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        setSearchOpen(false);
        navigate(PAGE_ORDER[Number(e.key) - 1]);
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, back, toggleSidebar]);

  // What the header shows for the current page.
  const weaponRow = page === "weapon" ? session.vault?.find((r) => r.instance_id === route.weapon) : undefined;
  const weaponCopies = weaponRow ? (session.vault ?? []).filter((r) => r.weapon === weaponRow.weapon) : [];
  const contextLabel = CONTEXTS.find((c) => c.value === session.context)?.label ?? "";
  const rank = weaponRow ? weaponCopies.findIndex((r) => r.instance_id === weaponRow.instance_id) + 1 : 0;
  const header =
    page === "weapon"
      ? {
          crumbs: ["Vault", weaponRow?.name ?? "Weapon"],
          title: weaponRow?.name ?? "Weapon",
          subtitle: !weaponRow
            ? ""
            : weaponCopies.length > 1
              ? `${rank === 1 ? "Your best" : `Number ${rank}`} of ${weaponCopies.length} copies, scored for ${contextLabel}.`
              : `Scored for ${contextLabel}.`,
        }
      : page === "settings"
        ? { crumbs: [SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? "Account"] }
        : {};

  return (
    <>
      <div className="pf-backdrop" style={{ backgroundImage: `url(${backdrop})` }} aria-hidden="true" />
      <div className="pf-app" data-collapsed={collapsed}>
        <Sidebar page={page === "weapon" ? "vault" : page} collapsed={collapsed} onNavigate={navigate} />
        <main className="pf-main">
          <Header
            page={page}
            canGoBack={history.length > 1}
            onBack={back}
            onSearch={() => setSearchOpen(true)}
            {...header}
          />
          <div className="pf-content">
            <Banners page={page} onNavigate={navigate} />
            <div className="pf-page">
              {page === "home" && <HomePage onNavigate={navigate} onOpenWeapon={selectInVault} />}
              {page === "vault" && (
                <VaultPage onNavigate={navigate} initialSelectedId={vaultFocus} onOpenWeapon={openWeaponPage} />
              )}
              {page === "weapon" && route.weapon && (
                <WeaponPage key={route.weapon} instanceId={route.weapon} onSelect={switchCopy} />
              )}
              {page === "codex" && <CodexPage />}
              {page === "chase" && <ChasePage onNavigate={navigate} />}
              {page === "collections" && <CollectionsPage />}
              {page === "settings" && <SettingsPage section={settingsSection} onSection={setSettingsSection} />}
            </div>
          </div>
        </main>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onOpenWeapon={openWeaponPage} />
    </>
  );
}

/** First run until the first sync is done and Finish is pressed; then the app. */
function Root() {
  const session = useSession();
  // Decided once, when ParaForge knows whether it has ever synced.
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => {
    if (firstRun === null && session.info && session.auth) setFirstRun(session.info.synced_at === null);
  }, [firstRun, session.info, session.auth]);
  if (firstRun === null) {
    // app_info failed: show the app (with its error banner) rather than nothing.
    if (session.auth && !session.info && session.syncError) return <Shell />;
    return null;
  }
  return firstRun ? (
    <>
      <div className="pf-backdrop" style={{ backgroundImage: `url(${backdrop})` }} aria-hidden="true" />
      <FirstRun onFinish={() => setFirstRun(false)} />
    </>
  ) : (
    <Shell />
  );
}

/** Conditions that last: a failed sync, a refused sign-in, or no sign-in at all. */
function Banners({ page, onNavigate }: { page: PageId; onNavigate: (page: PageId) => void }) {
  const session = useSession();
  const signedIn = Boolean(session.auth?.signed_in);
  return (
    <>
      {session.syncError && !session.syncErrorAuto && (
        <Banner
          tone="error"
          onDismiss={session.clearSyncError}
          action={
            signedIn && (
              <button type="button" className="pf-btn pf-btn--small" onClick={session.sync}>
                Try again
              </button>
            )
          }
        >
          Sync failed: {session.syncError}
        </Banner>
      )}
      {session.authError && (
        <Banner
          tone="error"
          onDismiss={session.auth ? session.clearAuthError : undefined}
          action={
            !session.auth && (
              <button type="button" className="pf-btn pf-btn--small" onClick={session.refreshAuth}>
                Try again
              </button>
            )
          }
        >
          {session.auth ? "Sign-in failed" : "Could not read your sign-in"}: {session.authError}
        </Banner>
      )}
      {session.auth && !signedIn && page !== "settings" && page !== "home" && (
        <Banner
          tone="warn"
          action={
            <button type="button" className="pf-btn pf-btn--primary pf-btn--small" onClick={() => onNavigate("settings")}>
              Sign in
            </button>
          }
        >
          You're not signed in to Bungie. Your saved data still works; sign in to sync.
        </Banner>
      )}
    </>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Root />
    </SessionProvider>
  );
}
