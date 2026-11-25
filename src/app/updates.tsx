// In-app updates: ParaForge checks its GitHub releases for a newer build, downloads it in the
// background (the Rust side checks its SHA-256), and installs it when the player presses Restart.
import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../ui/feedback";

/** First check a little after start, so it never slows the launch; then every six hours. */
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 3_600_000;

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; version: string }
  | { status: "current" }
  | { status: "installing"; version: string }
  | { status: "error"; error: string };

type Updates = {
  state: UpdateState;
  /** Looks for a new build now. `manual` says the result out loud, even when there is nothing new. */
  checkNow: (manual?: boolean) => Promise<void>;
  /** Installs the downloaded build and starts ParaForge again. */
  restart: () => Promise<void>;
};

const UpdatesContext = createContext<Updates>({
  state: { status: "idle" },
  checkNow: async () => {},
  restart: async () => {},
});

export const useUpdates = () => useContext(UpdatesContext);

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const ready = useRef<{ version: string } | null>(null);
  const busy = useRef(false);
  const checkRef = useRef<(manual?: boolean) => Promise<void>>(async () => {});

  const restart = useCallback(async () => {
    const update = ready.current;
    if (!update) return;
    setState({ status: "installing", version: update.version });
    try {
      // The installer closes ParaForge, updates it, and opens it again.
      await invoke("update_install");
    } catch (e) {
      // Download it again on the next check (the file may have been removed or quarantined).
      ready.current = null;
      setState({ status: "error", error: String(e) });
      toast({
        tone: "error",
        text: `The update could not be installed: ${String(e)}`,
        action: { label: "Try again", run: () => void checkRef.current(true) },
      });
    }
  }, [toast]);

  const checkNow = useCallback(
    async (manual = false) => {
      if (busy.current) {
        if (manual) toast({ tone: "info", text: "ParaForge is already checking for updates." });
        return;
      }
      busy.current = true;
      const before = ready.current;
      setState({ status: "checking" });
      try {
        // Also with a build ready: a newer one may have come out since, and the Rust side reuses
        // the download when it is still the latest.
        const update = await invoke<{ version: string } | null>("update_check");
        if (!update) {
          ready.current = null;
          setState({ status: "current" });
          if (manual) toast({ tone: "success", text: "You have the latest ParaForge." });
          return;
        }
        ready.current = update;
        setState({ status: "ready", version: update.version });
        if (manual || before?.version !== update.version) {
          toast({
            tone: "info",
            text: `ParaForge ${update.version} is ready. Restart to update.`,
            action: { label: "Restart", run: () => void restart() },
          });
        }
      } catch (e) {
        // A build already downloaded stays ready when a later check fails.
        setState(before ? { status: "ready", version: before.version } : { status: "error", error: String(e) });
        // An automatic check that fails (offline, GitHub busy) stays quiet and tries again later.
        if (manual) toast({ tone: "error", text: `Could not check for updates: ${String(e)}` });
      } finally {
        busy.current = false;
      }
    },
    [toast, restart],
  );

  checkRef.current = checkNow;

  useEffect(() => {
    const first = window.setTimeout(() => void checkNow(false), FIRST_CHECK_MS);
    const every = window.setInterval(() => void checkNow(false), CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [checkNow]);

  return <UpdatesContext.Provider value={{ state, checkNow, restart }}>{children}</UpdatesContext.Provider>;
}
