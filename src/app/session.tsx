// App-wide state: sign-in status, the last sync and a running sync. Every screen reads it,
// so the header, sidebar and pages always agree.
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppInfo, AuthStatus, CopyMark, Perk, ScoreContext, SyncSummary, VaultRow } from "./api";

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
  /** How the last sync ended; a new object each time one ends. */
  lastSync: { auto: boolean; ok: boolean; newDrops: number } | null;
  clearSyncError: () => void;
  sync: () => Promise<void>;
  /** Syncs like an automatic sync: no toast, and errors only show in the header. */
  syncQuietly: () => Promise<void>;
  /** Bumped after every successful sync, so lists know to reload. */
  dataVersion: number;
  context: ScoreContext;
  setContext: (context: ScoreContext) => void;
  /** The stored vault scored for the current context; null while it loads. */
  vault: VaultRow[] | null;
  vaultError: string | null;
  /** Every known perk by hash, with its icon and description. */
  perks: Record<number, Perk>;
  syncPrefs: SyncPrefs;
  setSyncPrefs: (prefs: SyncPrefs) => void;
  /** Destiny 2 is running and "sync while I play" is on, so syncs come every 2 minutes. */
  playing: boolean;
  /** The first app_info read has finished, whether or not it worked. */
  infoLoaded: boolean;
  /** Saves a keep / shard decision on a copy (null clears it) and updates the vault in place. */
  markCopy: (instanceId: string, mark: CopyMark | null) => Promise<void>;
};

export type SyncPrefs = {
  /** Minutes between automatic syncs; 0 turns the schedule off. */
  interval: number;
  /** Sync when ParaForge starts (unless it synced in the last 2 minutes). */
  onStart: boolean;
  /** Sync every 2 minutes while Destiny 2 is running. */
  whilePlaying: boolean;
};

export const PLAYING_INTERVAL_MIN = 2;

const SYNC_PREFS_KEY = "paraforge.syncPrefs";
/** The first auto sync setting, kept so an existing choice carries over. */
const OLD_AUTO_SYNC_KEY = "paraforge.autoSync";
const CONTEXT_KEY = "paraforge.context";
export const SYNC_DEFAULTS: SyncPrefs = { interval: 15, onStart: true, whilePlaying: true };

function readSyncPrefs(): SyncPrefs {
  try {
    const stored = localStorage.getItem(SYNC_PREFS_KEY);
    if (stored) {
      const p = JSON.parse(stored) as Partial<SyncPrefs>;
      return {
        interval: typeof p.interval === "number" && p.interval >= 0 ? p.interval : SYNC_DEFAULTS.interval,
        onStart: typeof p.onStart === "boolean" ? p.onStart : SYNC_DEFAULTS.onStart,
        whilePlaying: typeof p.whilePlaying === "boolean" ? p.whilePlaying : SYNC_DEFAULTS.whilePlaying,
      };
    }
    const old = localStorage.getItem(OLD_AUTO_SYNC_KEY);
    if (old !== null && Number.isFinite(Number(old)) && Number(old) >= 0) {
      return { ...SYNC_DEFAULTS, interval: Number(old) };
    }
  } catch {
    // Unreadable storage: use the defaults.
  }
  return SYNC_DEFAULTS;
}

function readContext(): ScoreContext {
  try {
    return localStorage.getItem(CONTEXT_KEY) === "pvp" ? "pvp" : "pve";
  } catch {
    return "pve";
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
  const [lastSync, setLastSync] = useState<Session["lastSync"]>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [context, setContextState] = useState<ScoreContext>(readContext);
  const setContext = useCallback((next: ScoreContext) => {
    setContextState(next);
    try {
      localStorage.setItem(CONTEXT_KEY, next);
    } catch {
      // Without storage the choice lasts until the app closes.
    }
  }, []);
  const running = useRef(false);
  const [loaded, setLoaded] = useState<{ context: ScoreContext; rows: VaultRow[] } | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [perks, setPerks] = useState<Record<number, Perk>>({});
  const loadSeq = useRef(0);
  const [syncPrefs, setSyncPrefsState] = useState(readSyncPrefs);
  const [playing, setPlaying] = useState(false);
  const startChecked = useRef(false);
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

  // App info (player name, counts, rules); read again after every sync so Settings stays current.
  useEffect(() => {
    invoke<AppInfo>("app_info").then(
      (i) => {
        setInfo(i);
        setSyncedAt(i.synced_at);
        setInfoLoaded(true);
      },
      (e) => {
        if (dataVersion === 0) setSyncError(String(e));
        // Without a stored sync time, auto sync treats the vault as due and tries on launch.
        setInfoLoaded(true);
      },
    );
  }, [dataVersion]);

  useEffect(() => {
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
      setLastSync({ auto, ok: true, newDrops: result.new_drops ?? 0 });
    } catch (e) {
      if (auto) autoFailures.current += 1;
      setSyncError(String(e));
      setSyncErrorAuto(auto);
      setLastSync({ auto, ok: false, newDrops: 0 });
      // A sync can store a new item database before a later step fails, so lists read again.
      setDataVersion((v) => v + 1);
      // A refused sign-in shows up here first; refresh the status so the banner is right.
      invoke<AuthStatus>("auth_status").then(setAuth, () => {});
    } finally {
      running.current = false;
      setSyncStep(null);
    }
  }, []);
  // Buttons pass their click event; this wrapper keeps it from being read as `auto`.
  const sync = useCallback(() => runSync(false), [runSync]);
  const syncQuietly = useCallback(() => runSync(true), [runSync]);

  const setSyncPrefs = useCallback((prefs: SyncPrefs) => {
    setSyncPrefsState(prefs);
    try {
      localStorage.setItem(SYNC_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Without storage the choice lasts until the app closes.
    }
  }, []);

  // Auto sync, checked every minute (so a PC waking from sleep catches up soon after):
  // - when ParaForge starts, if "sync when ParaForge starts" is on;
  // - every 2 minutes while Destiny 2 runs, if "sync while I play" is on;
  // - otherwise on the chosen schedule.
  const canSync = Boolean(auth?.signed_in) && infoLoaded;
  useEffect(() => {
    if (!canSync) {
      setPlaying(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      const isPlaying = syncPrefs.whilePlaying ? await invoke<boolean>("game_running").catch(() => false) : false;
      if (cancelled) return;
      setPlaying(isPlaying);
      const now = Date.now();
      // A time in the future (the clock was set back) counts as long ago.
      const since = (ms: number) => (ms > now ? Infinity : now - ms);
      const sinceSync = since((syncedAt ?? 0) * 1000);
      if (!startChecked.current) {
        startChecked.current = true;
        if (syncPrefs.onStart && sinceSync >= PLAYING_INTERVAL_MIN * 60_000) {
          void runSync(true);
          return;
        }
      }
      const minutes = isPlaying ? PLAYING_INTERVAL_MIN : syncPrefs.interval;
      if (minutes <= 0) return;
      const interval = minutes * 60_000;
      // Back off after automatic failures (2x, 4x... up to a day), so a broken sync does not
      // download Bungie's item database again every few minutes.
      const wait = Math.min(interval * 2 ** autoFailures.current, 24 * 3_600_000);
      if (sinceSync >= interval && since(lastAttempt.current) >= wait) void runSync(true);
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canSync, syncPrefs, syncedAt, runSync]);

  const markCopy = useCallback(async (instanceId: string, mark: CopyMark | null) => {
    await invoke("mark_copy", { instanceId, mark });
    setLoaded((l) =>
      l
        ? {
            ...l,
            rows: l.rows.map((r) => (r.instance_id === instanceId ? { ...r, mark, marked_at: mark ? Date.now() : 0 } : r)),
          }
        : l,
    );
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
    syncErrorAuto,
    lastSync,
    clearSyncError: useCallback(() => setSyncError(null), []),
    sync,
    syncQuietly,
    dataVersion,
    context,
    setContext,
    // Rows from the other context are never shown under this one's label.
    vault: loaded && loaded.context === context ? loaded.rows : null,
    vaultError,
    perks,
    syncPrefs,
    setSyncPrefs,
    playing,
    infoLoaded,
    markCopy,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
