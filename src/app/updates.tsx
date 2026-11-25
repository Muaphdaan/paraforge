// In-app updates: ParaForge checks its GitHub releases for a newer build, downloads it in the
// background, and installs it when the player presses Restart. Builds are signed by CI, and the
// updater refuses anything whose signature does not match the key built into the app.
import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useToast } from "../ui/feedback";

/** First check a little after start, so it never slows the launch; then every six hours. */
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 3_600_000;

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string }
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
  const ready = useRef<Update | null>(null);
  const busy = useRef(false);

  const restart = useCallback(async () => {
    const update = ready.current;
    if (!update) return;
    setState({ status: "installing", version: update.version });
    try {
      // On Windows the installer closes ParaForge, updates it, and opens it again.
      await update.install();
      await relaunch();
    } catch (e) {
      setState({ status: "ready", version: update.version });
      toast({ tone: "error", text: `The update could not be installed: ${String(e)}` });
    }
  }, [toast]);

  const checkNow = useCallback(
    async (manual = false) => {
      if (busy.current) return;
      if (ready.current) {
        if (manual) {
          toast({
            tone: "info",
            text: `ParaForge ${ready.current.version} is ready to install.`,
            action: { label: "Restart", run: () => void restart() },
          });
        }
        return;
      }
      busy.current = true;
      setState({ status: "checking" });
      try {
        const update = await check();
        if (!update) {
          setState({ status: "current" });
          if (manual) toast({ tone: "success", text: "You have the latest ParaForge." });
          return;
        }
        setState({ status: "downloading", version: update.version });
        await update.download();
        ready.current = update;
        setState({ status: "ready", version: update.version });
        toast({
          tone: "info",
          text: `ParaForge ${update.version} is ready. Restart to update.`,
          action: { label: "Restart", run: () => void restart() },
        });
      } catch (e) {
        setState({ status: "error", error: String(e) });
        // An automatic check that fails (offline, GitHub busy) stays quiet and tries again later.
        if (manual) toast({ tone: "error", text: `Could not check for updates: ${String(e)}` });
      } finally {
        busy.current = false;
      }
    },
    [toast, restart],
  );

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
