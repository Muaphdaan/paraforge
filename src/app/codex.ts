// Every Legendary and Exotic weapon in the game, read once per sync and shared by the Codex,
// the Chase list and search.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CodexRow } from "./api";
import { useSession } from "./session";

let cache: { version: number; rows: Promise<CodexRow[]> } | null = null;

function load(version: number): Promise<CodexRow[]> {
  if (!cache || cache.version !== version) {
    const rows = invoke<CodexRow[]>("codex");
    cache = { version, rows };
    // A failed read is tried again next time instead of being remembered.
    rows.catch(() => {
      if (cache?.rows === rows) cache = null;
    });
  }
  return cache.rows;
}

export function useCodex(): { rows: CodexRow[] | null; byHash: Map<number, CodexRow>; error: string | null } {
  const { dataVersion } = useSession();
  const [state, setState] = useState<{ version: number; rows: CodexRow[] | null; error: string | null }>({
    version: -1,
    rows: null,
    error: null,
  });
  useEffect(() => {
    let live = true;
    load(dataVersion).then(
      (rows) => live && setState({ version: dataVersion, rows, error: null }),
      (e) => live && setState({ version: dataVersion, rows: null, error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [dataVersion]);
  // Until the new read arrives, the last one is still right for everything but owned counts.
  const rows = state.rows;
  const byHash = useMemo(() => new Map((rows ?? []).map((r) => [r.hash, r])), [rows]);
  return { rows, byHash, error: state.error };
}
