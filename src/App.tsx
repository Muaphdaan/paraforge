// The ParaForge window: floating sidebar, page header, banners and the current section.
import { useCallback, useEffect, useState } from "react";
import backdrop from "./assets/backdrop.webp";
import { PAGE_ORDER, PageId } from "./app/pages";
import { SessionProvider, useSession } from "./app/session";
import { HomePage } from "./pages/HomePage";
import { ChaseProvider } from "./app/chase";
import { ContextMenu, Tooltips, useBrowserKeyGuard } from "./ui/overlays";
import { ChasePage } from "./pages/ChasePage";
import { CodexPage } from "./pages/CodexPage";
import { CollectionsPage } from "./pages/CollectionsPage";
import { SETTINGS_SECTIONS, SettingsPage, SettingsSection } from "./pages/SettingsPage";
import { FirstRun } from "./pages/FirstRun";
import { WeaponPage } from "./pages/WeaponPage";
import { SearchPalette } from "./shell/SearchPalette";
import { CONTEXTS } from "./app/api";
import { TriagePage } from "./pages/TriagePage";
import { VaultPage } from "./pages/VaultPage";
import { Header } from "./shell/Header";
import { Sidebar } from "./shell/Sidebar";
import { Banner } from "./ui/parts";
import { ConfirmProvider, ToastProvider, useToast } from "./ui/feedback";
import { MenuDef, MenuItem, TitleBar, closeWindow } from "./shell/TitleBar";
import { StatusBar } from "./shell/StatusBar";
import { PAGES } from "./app/pages";
import { editCommands } from "./ui/overlays";

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
  // The copy on a weapon page is also the one the Vault selects when Back leads there.
  const openWeaponPage = useCallback(
    (instanceId: string) => {
      setVaultFocus(instanceId);
      push({ page: "weapon", weapon: instanceId });
    },
    [push],
  );
  const [codexFocus, setCodexFocus] = useState(0);
  const openInCodex = useCallback(
    (hash: number) => {
      setCodexFocus((n) => n + 1);
      push({ page: "codex", weapon: String(hash) });
    },
    [push],
  );
  // Switching copies on a weapon page replaces it, so Back still leads out of the weapon.
  const switchCopy = useCallback(
    (instanceId: string) => {
      setVaultFocus(instanceId);
      setHistory((h) => [...h.slice(0, -1), { page: "weapon", weapon: instanceId }]);
    },
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

  const openSettings = useCallback(
    (section: SettingsSection) => {
      setSettingsSection(section);
      navigate("settings");
    },
    [navigate],
  );

  // Ctrl+K searches, Ctrl+B collapses the sidebar, Ctrl+1 to Ctrl+7 open the sections, Ctrl+, opens
  // Settings, Alt+Left goes back and F5 syncs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F5" || (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r")) {
        // Never reload the web view; F5 syncs instead.
        e.preventDefault();
        if (e.key === "F5" && !e.repeat && session.auth?.signed_in && !session.syncStep) session.sync();
        return;
      }
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setSearchOpen(false);
        navigate("settings");
        return;
      }
      // Ctrl+F too, so it opens ParaForge's search rather than the web view's find bar.
      if (e.ctrlKey && !e.altKey && !e.shiftKey && ["k", "f"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.ctrlKey && !e.altKey && /^[1-7]$/.test(e.key)) {
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
  }, [navigate, back, toggleSidebar, session]);

  const menus: MenuDef[] = [
    {
      id: "file",
      label: "File",
      mnemonic: "F",
      items: () => [
        {
          label: session.syncStep ? "Syncing..." : "Sync now",
          keys: "F5",
          run: session.sync,
          disabled: !session.auth?.signed_in || Boolean(session.syncStep),
        },
        { label: "Settings", keys: "Ctrl+,", run: () => navigate("settings") },
        "separator",
        { label: "Exit", keys: "Alt+F4", run: closeWindow },
      ],
    },
    { id: "edit", label: "Edit", mnemonic: "E", items: (target) => [...editCommands(target), "separator", { label: "Find", keys: "Ctrl+F", run: () => setSearchOpen(true) }] },
    {
      id: "view",
      label: "View",
      mnemonic: "V",
      items: () => [
        { label: collapsed ? "Expand the sidebar" : "Collapse the sidebar", keys: "Ctrl+B", run: toggleSidebar },
        "separator",
        ...CONTEXTS.map(
          (c): MenuItem => ({
            label: `Score for ${c.label}`,
            checked: session.context === c.value,
            run: () => session.setContext(c.value),
          }),
        ),
      ],
    },
    {
      id: "go",
      label: "Go",
      mnemonic: "G",
      items: () => [
        { label: "Back", keys: "Alt+Left", run: back, disabled: history.length < 2 },
        "separator",
        ...PAGE_ORDER.map(
          (id, i): MenuItem => ({
            label: PAGES[id].label,
            keys: `Ctrl+${i + 1}`,
            checked: (page === "weapon" ? "vault" : page) === id,
            run: () => navigate(id),
          }),
        ),
      ],
    },
    {
      id: "help",
      label: "Help",
      mnemonic: "H",
      items: () => [
        { label: "Keyboard shortcuts", run: () => openSettings("shortcuts") },
        { label: "About ParaForge", run: () => openSettings("about") },
      ],
    },
  ];

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
    <div className="pf-window">
      <div className="pf-backdrop" style={{ backgroundImage: `url(${backdrop})` }} aria-hidden="true" />
      <TitleBar menus={menus} />
      <SyncToasts onNavigate={navigate} />
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
              {page === "codex" && (
                <CodexPage
                  initialHash={route.weapon ? Number(route.weapon) : null}
                  focusToken={codexFocus}
                  onOpenWeapon={openWeaponPage}
                />
              )}
              {page === "triage" && <TriagePage onOpenWeapon={openWeaponPage} />}
              {page === "chase" && (
                <ChasePage onNavigate={navigate} onOpenInCodex={openInCodex} onOpenWeapon={openWeaponPage} />
              )}
              {page === "collections" && <CollectionsPage onOpenInCodex={openInCodex} />}
              {page === "settings" && <SettingsPage section={settingsSection} onSection={setSettingsSection} />}
            </div>
          </div>
        </main>
      </div>
      <StatusBar onNavigate={navigate} />
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenWeapon={openWeaponPage}
        onOpenInCodex={openInCodex}
      />
    </div>
  );
}

/** Menus for the screens before the app proper (loading and first run). */
const BASIC_MENUS: MenuDef[] = [
  { id: "file", label: "File", mnemonic: "F", items: () => [{ label: "Exit", keys: "Alt+F4", run: closeWindow }] },
  { id: "edit", label: "Edit", mnemonic: "E", items: (target) => editCommands(target) },
];

/**
 * A toast when a sync the player asked for ends, and when any sync finds new drops (with a way
 * to review them). Automatic syncs that find nothing stay quiet in the status bar.
 */
function SyncToasts({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const session = useSession();
  const toast = useToast();
  const last = session.lastSync;
  useEffect(() => {
    if (!last) return;
    if (!last.ok) {
      if (!last.auto) toast({ tone: "error", text: `Sync failed: ${session.syncError ?? "unknown error"}` });
      return;
    }
    const n = last.newDrops;
    if (n > 0) {
      toast({
        tone: "success",
        text: `Synced. ${n} new ${n === 1 ? "drop" : "drops"} to review.`,
        action: { label: "Review", run: () => onNavigate("triage") },
      });
    } else if (!last.auto) {
      toast({ tone: "success", text: "Synced. No new drops." });
    }
    // Only a new sync result matters. session.syncError is set in the same update as lastSync.
  }, [last]);
  return null;
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
    // app_info or the sign-in read failed: show the app (with its error banner) rather than nothing.
    if ((!session.auth && session.authError) || (session.auth && !session.info && session.infoLoaded)) return <Shell />;
    // Still loading: the title bar alone, so the window can be moved and closed.
    return (
      <div className="pf-window">
        <TitleBar menus={BASIC_MENUS} />
      </div>
    );
  }
  return firstRun ? (
    <div className="pf-window">
      <div className="pf-backdrop" style={{ backgroundImage: `url(${backdrop})` }} aria-hidden="true" />
      <TitleBar menus={BASIC_MENUS} />
      <FirstRun onFinish={() => setFirstRun(false)} />
    </div>
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
  useBrowserKeyGuard();
  return (
    <SessionProvider>
      <ToastProvider>
        <ConfirmProvider>
          <ChaseProvider>
            <Root />
          </ChaseProvider>
        </ConfirmProvider>
      </ToastProvider>
      <Tooltips />
      <ContextMenu />
    </SessionProvider>
  );
}
