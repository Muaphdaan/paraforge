// App-wide state: sign-in status, the last sync and a running sync. Every screen reads it,
// so the header, sidebar and pages always agree.
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppInfo, AuthStatus, ScoreContext, SyncSummary } from "./api";

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
  clearSyncError: () => void;
  sync: () => Promise<void>;
  /** Bumped after every successful sync, so lists know to reload. */
  dataVersion: number;
  context: ScoreContext;
  setContext: (context: ScoreContext) => void;
};

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
  const [dataVersion, setDataVersion] = useState(0);
  const [context, setContext] = useState<ScoreContext>("pve");
  const running = useRef(false);

  useEffect(() => {
    invoke<AppInfo>("app_info").then(
      (i) => {
        setInfo(i);
        setSyncedAt(i.synced_at);
      },
      (e) => setSyncError(String(e)),
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

  const sync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSyncError(null);
    setSyncStep("Starting");
    try {
      const result = await invoke<SyncSummary>("sync_now");
      setSummary(result);
      setSyncedAt(result.synced_at);
      setDataVersion((v) => v + 1);
    } catch (e) {
      setSyncError(String(e));
      // A refused sign-in shows up here first; refresh the status so the banner is right.
      invoke<AuthStatus>("auth_status").then(setAuth, () => {});
    } finally {
      running.current = false;
      setSyncStep(null);
    }
  }, []);

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
    clearSyncError: useCallback(() => setSyncError(null), []),
    sync,
    dataVersion,
    context,
    setContext,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
