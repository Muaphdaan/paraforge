// The Chase list: rolls the player is hunting, stored in the local database, and how close
// their copies come to each one.
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChaseRoll, VaultRow } from "./api";

type Chase = {
  /** null while the list loads. */
  list: ChaseRoll[] | null;
  error: string | null;
  /** Adds a roll and resolves to its id; rejects with a message to show. */
  add: (weapon: number, perks: number[][]) => Promise<number>;
  remove: (id: number) => Promise<void>;
};

const ChaseContext = createContext<Chase | null>(null);

export function ChaseProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ChaseRoll[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      invoke<ChaseRoll[]>("chase_list").then(
        (rows) => {
          setList(rows);
          setError(null);
        },
        (e) => setError(String(e)),
      ),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const add = useCallback(
    async (weapon: number, perks: number[][]) => {
      const id = await invoke<number>("chase_add", { weapon, perks });
      await reload();
      return id;
    },
    [reload],
  );
  const remove = useCallback(
    async (id: number) => {
      await invoke("chase_remove", { id });
      await reload();
    },
    [reload],
  );
  return <ChaseContext.Provider value={{ list, error, add, remove }}>{children}</ChaseContext.Provider>;
}

export function useChase(): Chase {
  const chase = useContext(ChaseContext);
  if (!chase) throw new Error("useChase needs a ChaseProvider");
  return chase;
}

/** Columns of the roll that name perks, and how many of those this copy has. */
export function chaseProgress(roll: ChaseRoll, copy: VaultRow): { matched: number; wanted: number } {
  let matched = 0;
  let wanted = 0;
  roll.perks.forEach((want, i) => {
    if (want.length === 0) return;
    wanted += 1;
    if (copy.columns[i]?.options.some((h) => want.includes(h))) matched += 1;
  });
  return { matched, wanted };
}

/** The copy that comes closest to the roll, best score breaking ties; null when none is owned. */
export function closestCopy(
  roll: ChaseRoll,
  vault: VaultRow[],
): { copy: VaultRow; matched: number; wanted: number } | null {
  let best: { copy: VaultRow; matched: number; wanted: number } | null = null;
  for (const copy of vault) {
    if (copy.weapon !== roll.weapon) continue;
    const p = chaseProgress(roll, copy);
    // The vault comes best first, so the first copy with the most matches is also the best scored.
    if (!best || p.matched > best.matched) best = { copy, ...p };
  }
  return best;
}

/** Same perks in each column, whatever the order they were picked in. */
export function sameRoll(a: number[][], b: number[][]): boolean {
  const norm = (perks: number[][]) => {
    const cols = perks.map((c) => [...new Set(c)].sort((x, y) => x - y));
    while (cols.length && cols[cols.length - 1].length === 0) cols.pop();
    return JSON.stringify(cols);
  };
  return norm(a) === norm(b);
}
