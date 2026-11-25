// App-wide state: sign-in status, the last sync and a running sync. Every screen reads it,
// so the header, sidebar and pages always agree.
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppInfo, AuthStatus, Perk, ScoreContext, SyncSummary, VaultRow } from "./api";

type Session = {
  info: AppInfo | null;
  auth: AuthStatus | null;
  /** A sign-in problem reported by the Rust side (for example a refused sign-in). */
  authError: string | null;
  setAuth: (status: AuthStatus) => void;
  /** Asks the Rust side for the sign-in status again (after it failed to load). */
  refreshAuth: () => void;
  clearAuthError: () => void;
  /** Unix seconds of the last successful sync. */
  syncedAt: number | null;
  summary: SyncSummary | null;
  /** The current step while a sync runs, otherwise null. */
  syncStep: string | null;
  syncError: string | null;
  /** The error came from an automatic sync: shown in the header and sidebar, not as a banner. */
  syncErrorAuto: boolean;
  clearSyncError: () => void;
  sync: () => Promise<void>;
  /** Bumped after every successful sync, so lists know to reload. */
  dataVersion: number;
  context: ScoreContext;
  setContext: (context: ScoreContext) => void;
  /** The stored vault scored for the current context; null while it loads. */
  vault: VaultRow[] | null;
  vaultError: string | null;
  /** Every known perk by hash, with its icon and description. */
  perks: Record<number, Perk>;
  /** Minutes between automatic syncs; 0 turns auto sync off. */
  autoSync: number;
  setAutoSync: (minutes: number) => void;
};

const AUTO_SYNC_KEY = "paraforge.autoSync";
export const AUTO_SYNC_DEFAULT = 15;

function readAutoSync(): number {
  try {
    const stored = localStorage.getItem(AUTO_SYNC_KEY);
    const minutes = stored === null ? AUTO_SYNC_DEFAULT : Number(stored);
    return Number.isFinite(minutes) && minutes >= 0 ? minutes : AUTO_SYNC_DEFAULT;
  } catch {
    return AUTO_SYNC_DEFAULT;
  }
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside SessionProvider");
  return session;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [syncStep, setSyncStep] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncErrorAuto, setSyncErrorAuto] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [context, setContext] = useState<ScoreContext>("pve");
  const running = useRef(false);
  const [loaded, setLoaded] = useState<{ context: ScoreContext; rows: VaultRow[] } | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [perks, setPerks] = useState<Record<number, Perk>>({});
  const loadSeq = useRef(0);
  const [autoSync, setAutoSyncState] = useState(readAutoSync);
  // When the last sync was started (ms), so a failing auto sync waits a full interval before retrying.
  const lastAttempt = useRef(0);
  // Automatic failures in a row; each one doubles the wait before the next automatic try.
  const autoFailures = useRef(0);
  const [infoLoaded, setInfoLoaded] = useState(false);

  // Reload the vault for the current context after each sync; only the newest reply counts.
  useEffect(() => {
    const seq = ++loadSeq.current;
    invoke<VaultRow[]>("vault", { context }).then(
      (rows) => {
        if (seq === loadSeq.current) {
          setLoaded({ context, rows });
          setVaultError(null);
        }
      },
      (e) => {
        if (seq === loadSeq.current) setVaultError(String(e));
      },
    );
  }, [context, dataVersion]);

  useEffect(() => {
    invoke<Record<number, Perk>>("perks").then(setPerks, () => setPerks({}));
  }, [dataVersion]);

  useEffect(() => {
    invoke<AppInfo>("app_info").then(
      (i) => {
        setInfo(i);
        setSyncedAt(i.synced_at);
        setInfoLoaded(true);
      },
      (e) => {
        setSyncError(String(e));
        // Without a stored sync time, auto sync treats the vault as due and tries on launch.
        setInfoLoaded(true);
      },
    );
    const unlisten = [
      listen<string>("sync-progress", (e) => {
        if (running.current) setSyncStep(e.payload);
      }),
      listen<AuthStatus>("auth-changed", (e) => {
        setAuth(e.payload);
        setAuthError(null);
      }),
      listen<string>("auth-error", (e) => setAuthError(e.payload)),
    ];
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

  const refreshAuth = useCallback(() => {
    invoke<AuthStatus>("auth_status").then(
      (status) => {
        setAuth(status);
        setAuthError(null);
      },
      (e) => setAuthError(String(e)),
    );
  }, []);
  useEffect(refreshAuth, [refreshAuth]);

  const runSync = useCallback(async (auto: boolean) => {
    if (running.current) return;
    running.current = true;
    lastAttempt.current = Date.now();
    // A manual sync starts clean; an automatic one leaves any error up until it succeeds.
    if (!auto) {
      setSyncError(null);
      setSyncErrorAuto(false);
    }
    setSyncStep("Starting");
    try {
      const result = await invoke<SyncSummary>("sync_now");
      setSummary(result);
      setSyncedAt(result.synced_at);
      setDataVersion((v) => v + 1);
      setSyncError(null);
      setSyncErrorAuto(false);
      setInfoLoaded(true);
      autoFailures.current = 0;
    } catch (e) {
      if (auto) autoFailures.current += 1;
      setSyncError(String(e));
      setSyncErrorAuto(auto);
      // A refused sign-in shows up here first; refresh the status so the banner is right.
      invoke<AuthStatus>("auth_status").then(setAuth, () => {});
    } finally {
      running.current = false;
      setSyncStep(null);
    }
  }, []);
  // Buttons pass their click event; this wrapper keeps it from being read as `auto`.
  const sync = useCallback(() => runSync(false), [runSync]);

  const setAutoSync = useCallback((minutes: number) => {
    setAutoSyncState(minutes);
    try {
      localStorage.setItem(AUTO_SYNC_KEY, String(minutes));
    } catch {
      // Without storage the choice lasts until the app closes.
    }
  }, []);

  // Auto sync: on launch when the last sync is older than the interval, then whenever it comes due.
  // Checked every minute, so a sleeping PC catches up soon after it wakes.
  const canSync = Boolean(auth?.signed_in) && infoLoaded;
  useEffect(() => {
    if (!canSync || autoSync <= 0) return;
    const interval = autoSync * 60_000;
    const check = () => {
      const now = Date.now();
      // A time in the future (the clock was set back) counts as long ago.
      const since = (ms: number) => (ms > now ? Infinity : now - ms);
      // Back off after automatic failures (2x, 4x... up to a day), so a broken sync does not
      // download Bungie's item database again every few minutes.
      const wait = Math.min(interval * 2 ** autoFailures.current, 24 * 3_600_000);
      if (since((syncedAt ?? 0) * 1000) >= interval && since(lastAttempt.current) >= wait) void runSync(true);
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [canSync, autoSync, syncedAt, runSync]);

  const value: Session = {
    info,
    auth,
    authError,
    setAuth,
    refreshAuth,
    clearAuthError: useCallback(() => setAuthError(null), []),
    syncedAt,
    summary,
    syncStep,
    syncError,
    syncErrorAuto,
    clearSyncError: useCallback(() => setSyncError(null), []),
    sync,
    dataVersion,
    context,
    setContext,
    // Rows from the other context are never shown under this one's label.
    vault: loaded && loaded.context === context ? loaded.rows : null,
    vaultError,
    perks,
    autoSync,
    setAutoSync,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
