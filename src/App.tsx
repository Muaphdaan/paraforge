// The ParaForge window: floating sidebar, page header, banners and the current section.
import { useCallback, useEffect, useState } from "react";
import backdrop from "./assets/backdrop.webp";
import { PAGE_ORDER, PageId } from "./app/pages";
import { SessionProvider, useSession } from "./app/session";
import { HomePage } from "./pages/HomePage";
import { ChasePage, CodexPage, CollectionsPage } from "./pages/Placeholders";
import { SettingsPage } from "./pages/SettingsPage";
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

function Shell() {
  // Visited pages, newest last; Back pops one.
  const [history, setHistory] = useState<PageId[]>(["home"]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const page = history[history.length - 1];

  // The weapon to open when the Vault is reached from a Home tile; any other navigation clears it.
  const [vaultFocus, setVaultFocus] = useState<string | null>(null);
  const navigate = useCallback((next: PageId) => {
    setVaultFocus(null);
    setHistory((h) => (h[h.length - 1] === next ? h : [...h.slice(-49), next]));
  }, []);
  const openWeapon = useCallback(
    (instanceId: string) => {
      navigate("vault");
      setVaultFocus(instanceId);
    },
    [navigate],
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

  // Ctrl+B collapses the sidebar, Ctrl+1 to Ctrl+6 open the sections, Alt+Left goes back.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.ctrlKey && !e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        navigate(PAGE_ORDER[Number(e.key) - 1]);
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, back, toggleSidebar]);

  return (
    <>
      <div className="pf-backdrop" style={{ backgroundImage: `url(${backdrop})` }} aria-hidden="true" />
      <div className="pf-app" data-collapsed={collapsed}>
        <Sidebar page={page} collapsed={collapsed} onNavigate={navigate} />
        <main className="pf-main">
          <Header
            page={page}
            collapsed={collapsed}
            onToggleSidebar={toggleSidebar}
            canGoBack={history.length > 1}
            onBack={back}
          />
          <div className="pf-content">
            <Banners page={page} onNavigate={navigate} />
            <div className="pf-page">
              {page === "home" && <HomePage onNavigate={navigate} onOpenWeapon={openWeapon} />}
              {page === "vault" && <VaultPage onNavigate={navigate} initialSelectedId={vaultFocus} />}
              {page === "codex" && <CodexPage />}
              {page === "chase" && <ChasePage onNavigate={navigate} />}
              {page === "collections" && <CollectionsPage />}
              {page === "settings" && <SettingsPage />}
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

/** Conditions that last: a failed sync, a refused sign-in, or no sign-in at all. */
function Banners({ page, onNavigate }: { page: PageId; onNavigate: (page: PageId) => void }) {
  const session = useSession();
  const signedIn = Boolean(session.auth?.signed_in);
  return (
    <>
      {session.syncError && (
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
      <Shell />
    </SessionProvider>
  );
}
