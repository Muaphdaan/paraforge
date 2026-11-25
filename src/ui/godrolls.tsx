// Curated god rolls for one weapon: each roll's perk combo column by column, the curator's
// masterwork and mod picks, its tags and the curator's guide. With a copy, the perks it already
// has are lit and the closest roll comes first.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, ChevronUp, Crosshair, Crown } from "lucide-react";
import { ColumnRole, CopyColumn, CuratedRoll, Perk, ROLE_LABELS, ScoreContext } from "../app/api";
import { useSession } from "../app/session";
import { PerkIcon } from "./weapon";

const cache = new Map<string, Promise<CuratedRoll[]>>();

/** One weapon's curated rolls, read once per sync. `null` while loading. */
export function useGodRolls(weapon: number | undefined): { rolls: CuratedRoll[] | null; error: string | null } {
  const { dataVersion } = useSession();
  const [state, setState] = useState<{ key: string; rolls: CuratedRoll[] | null; error: string | null }>({
    key: "",
    rolls: null,
    error: null,
  });
  const key = `${dataVersion}:${weapon}`;
  useEffect(() => {
    if (weapon === undefined) return;
    let live = true;
    let rolls = cache.get(key);
    if (!rolls) {
      rolls = invoke<CuratedRoll[]>("god_rolls", { weapon });
      cache.set(key, rolls);
      const mine = rolls;
      rolls.catch(() => cache.get(key) === mine && cache.delete(key));
    }
    rolls.then(
      (r) => live && setState({ key, rolls: r, error: null }),
      (e) => live && setState({ key, rolls: null, error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [key, weapon]);
  return state.key === key ? { rolls: state.rolls, error: state.error } : { rolls: null, error: null };
}

const TAG_LABEL: Record<string, string> = {
  "god-pve": "God roll",
  "god-pvp": "God roll",
  "pve-god": "God roll",
  "pvp-god": "God roll",
  mkb: "Mouse and keyboard",
  controller: "Controller",
  "pve-endgame": "Endgame",
  "pve-boss": "Boss damage",
  "pve-bossspec": "Boss damage",
  "pve-champion": "Champions",
  "pve-minor": "Add clear",
  "pve-groupadd": "Add clear",
  "pve-singleadd": "Single targets",
  "pve-major": "Majors",
  "pve-sustaineddamage": "Sustained damage",
  "pve-utility": "Utility",
  "pvp-duel": "Duels",
};

function tagLabels(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const label = TAG_LABEL[t];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

const isGod = (r: CuratedRoll) => r.tags.some((t) => t.startsWith("god-") || t.endsWith("-god"));

/** The columns of `roll` that name perks, and how many of those a copy has. "Any" columns are left out. */
export function rollMatch(roll: CuratedRoll, columns: CopyColumn[] | undefined): { matched: number; wanted: number } {
  let matched = 0;
  let wanted = 0;
  roll.columns.forEach((want, i) => {
    if (want.length === 0) return;
    wanted += 1;
    if (columns?.[i]?.options.some((h) => want.includes(h))) matched += 1;
  });
  return { matched, wanted };
}

/** How close a copy is to a roll, from 0 to 1. */
export const matchShare = (m: { matched: number; wanted: number }) => (m.wanted > 0 ? m.matched / m.wanted : 1);

/** One key per distinct roll: the same roll is stored once for PvE and once for PvP when it suits both. */
const rollKey = (r: CuratedRoll) => `${r.source}|${r.curator}|${r.title}|${JSON.stringify(r.columns)}`;

function distinct(list: CuratedRoll[]): CuratedRoll[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = rollKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type Picks = { masterwork: string; mods: string };

/** The masterwork and mod curators pick most often for this weapon in each mode. */
function commonPicks(rolls: CuratedRoll[]): Record<ScoreContext, Picks> {
  const top = (ctx: ScoreContext, key: "masterwork" | "mods") => {
    const n = new Map<string, number>();
    for (const r of rolls) if (r.context === ctx && r[key]) n.set(r[key], (n.get(r[key]) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  return {
    pve: { masterwork: top("pve", "masterwork"), mods: top("pve", "mods") },
    pvp: { masterwork: top("pvp", "masterwork"), mods: top("pvp", "mods") },
  };
}

type InputFilter = "all" | "mkb" | "controller";

const inputOk = (r: CuratedRoll, input: InputFilter) =>
  input === "all" || r.tags.includes(input) || !r.tags.some((t) => t === "mkb" || t === "controller");

export function GodRolls(props: {
  weapon: number;
  roles: ColumnRole[];
  perks: Record<number, Perk>;
  context: ScoreContext;
  /** The copy to compare against; its perks are lit and the closest roll comes first. */
  copy?: CopyColumn[];
  /** Several owned copies: each roll is compared with the copy that comes closest to it. */
  copies?: CopyColumn[][];
  /** Show at most this many rolls before "Show all". */
  limit?: number;
  compact?: boolean;
  /** Adds a "Chase this roll" button to each roll. */
  onChase?: (roll: CuratedRoll) => Promise<void>;
  /** Whether a roll is already on the Chase list. */
  isChased?: (roll: CuratedRoll) => boolean;
}) {
  const { rolls, error } = useGodRolls(props.weapon);
  const [context, setContext] = useState<ScoreContext | "all">(props.context);
  const [input, setInput] = useState<InputFilter>("all");
  const [all, setAll] = useState(false);
  useEffect(() => setContext(props.context), [props.context]);

  const pool = useMemo(() => props.copies ?? (props.copy ? [props.copy] : []), [props.copies, props.copy]);
  const common = useMemo(() => commonPicks(rolls ?? []), [rolls]);

  const shown = useMemo(() => {
    const base = (rolls ?? []).filter((r) => inputOk(r, input));
    const list = context === "all" ? distinct(base) : base.filter((r) => r.context === context);
    return list
      .map((roll, order) => {
        let copy: CopyColumn[] | undefined;
        let match = { matched: 0, wanted: 0 };
        for (const c of pool) {
          const m = rollMatch(roll, c);
          if (!copy || matchShare(m) > matchShare(match)) {
            copy = c;
            match = m;
          }
        }
        return { roll, order, copy, match };
      })
      .sort(
        (a, b) =>
          (pool.length > 0 ? matchShare(b.match) - matchShare(a.match) : 0) ||
          Number(isGod(b.roll)) - Number(isGod(a.roll)) ||
          a.order - b.order,
      );
  }, [rolls, context, input, pool]);

  if (error) return <p className="pf-muted">The god rolls could not be read: {error}</p>;
  if (rolls === null) return <p className="pf-muted">Loading god rolls...</p>;
  if (rolls.length === 0) {
    return (
      <p className="pf-muted">
        No curator has posted a roll for this weapon yet. God rolls come from the community voltron list, refreshed
        when you sync.
      </p>
    );
  }
  const limit = props.limit ?? 4;
  const visible = all ? shown : shown.slice(0, limit);
  const byInput = rolls.filter((r) => inputOk(r, input));
  const counts = {
    all: distinct(byInput).length,
    pve: byInput.filter((r) => r.context === "pve").length,
    pvp: byInput.filter((r) => r.context === "pvp").length,
  };

  return (
    <div className="pf-godrolls" data-compact={props.compact || undefined}>
      <div className="pf-godrolls__filters">
        <div className="pf-chips" role="group" aria-label="Mode">
          {(
            [
              ["all", `All ${counts.all}`],
              ["pve", `PvE ${counts.pve}`],
              ["pvp", `PvP ${counts.pvp}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="pf-chipbtn pf-chipbtn--small"
              aria-pressed={context === value}
              onClick={() => setContext(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="pf-chips" role="group" aria-label="Input">
          {(
            [
              ["all", "Any input"],
              ["mkb", "Mouse and keyboard"],
              ["controller", "Controller"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="pf-chipbtn pf-chipbtn--small"
              aria-pressed={input === value}
              onClick={() => setInput(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && <p className="pf-muted">No rolls match these filters.</p>}
      <ol className="pf-godrolls__list">
        {visible.map(({ roll, copy, match }) => (
          <RollCard
            key={`${roll.context}|${rollKey(roll)}`}
            roll={roll}
            roles={props.roles}
            perks={props.perks}
            copy={copy}
            several={pool.length > 1}
            match={match}
            common={common[roll.context]}
            compact={props.compact}
            onChase={props.onChase}
            chased={props.isChased?.(roll) ?? false}
          />
        ))}
      </ol>
      {shown.length > limit && (
        <button type="button" className="pf-btn pf-btn--small pf-godrolls__more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${shown.length} rolls`}
        </button>
      )}
      <p className="pf-muted pf-godrolls__credit">
        Rolls and guides by community curators, from the voltron list (MIT). Masterwork and mod picks marked
        &ldquo;common pick&rdquo; are what curators choose most for this weapon.
      </p>
    </div>
  );
}

function RollCard(props: {
  roll: CuratedRoll;
  roles: ColumnRole[];
  perks: Record<number, Perk>;
  copy?: CopyColumn[];
  /** The user owns more than one copy, so the closest one is compared. */
  several: boolean;
  match: { matched: number; wanted: number };
  /** The most common curator picks for this weapon, used when this roll names none. */
  common: Picks;
  compact?: boolean;
  onChase?: (roll: CuratedRoll) => Promise<void>;
  chased: boolean;
}) {
  const { roll, copy } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const masterwork = roll.masterwork || props.common.masterwork;
  const mods = roll.mods || props.common.mods;
  const labels = tagLabels(roll.tags);
  const { matched, wanted } = props.match;
  const notes = roll.notes.trim();
  const long = notes.length > 220;
  return (
    <li className="pf-roll" data-god={isGod(roll) || undefined}>
      <div className="pf-roll__head">
        <span className={`pf-pill pf-roll__mode pf-roll__mode--${roll.context}`}>{roll.context === "pvp" ? "PvP" : "PvE"}</span>
        {isGod(roll) && (
          <span className="pf-pill pf-roll__god">
            <Crown size={12} aria-hidden="true" />
            God roll
          </span>
        )}
        <strong className="pf-roll__title">{roll.title || "Curated roll"}</strong>
        {copy && (
          <span className="pf-roll__match" data-full={matched === wanted || undefined}>
            {matched === wanted ? (
              <>
                <Check size={14} strokeWidth={3} aria-hidden="true" />
                {props.several ? "One of your copies has it" : "Your copy has it"}
              </>
            ) : (
              `${props.several ? "Your closest copy" : "Your copy"}: ${matched} of ${wanted}`
            )}
          </span>
        )}
      </div>
      <div className="pf-roll__combo">
        {roll.columns.map((want, i) => (
          <div key={i} className="pf-roll__col">
            <span className="pf-perkcol__label">{ROLE_LABELS[props.roles[i]] ?? "Perk"}</span>
            {want.length === 0 ? (
              <span className="pf-muted pf-roll__any">Any</span>
            ) : (
              <span className="pf-roll__perks">
                {want.map((h) => {
                  const have = copy?.[i]?.options.includes(h);
                  return (
                    <span key={h} className="pf-roll__perk" data-have={have || undefined}>
                      <PerkIcon hash={h} perk={props.perks[h]} size={props.compact ? 24 : 28} decorative />
                      <span>{props.perks[h]?.name ?? "Unknown perk"}</span>
                      {copy && <span className="pf-visually-hidden">{have ? " (on your copy)" : " (missing)"}</span>}
                    </span>
                  );
                })}
              </span>
            )}
          </div>
        ))}
      </div>
      {(masterwork || mods) && (
        <dl className="pf-roll__picks">
          {masterwork && (
            <div>
              <dt>Masterwork</dt>
              <dd>
                {masterwork}
                {!roll.masterwork && <span className="pf-roll__src">common pick</span>}
              </dd>
            </div>
          )}
          {mods && (
            <div>
              <dt>Mod</dt>
              <dd>
                {mods}
                {!roll.mods && <span className="pf-roll__src">common pick</span>}
              </dd>
            </div>
          )}
        </dl>
      )}
      {labels.length > 0 && (
        <div className="pf-roll__tags">
          {labels.map((l) => (
            <span key={l} className="pf-tag">
              {l}
            </span>
          ))}
        </div>
      )}
      {notes && (
        <div className="pf-roll__guide">
          <p className="pf-roll__notes" data-open={open || !long || undefined}>
            {open || !long ? notes : `${notes.slice(0, 220).trimEnd()}...`}
          </p>
          {long && (
            <button type="button" className="pf-linkbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? "Less" : "Read the full guide"}
              {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            </button>
          )}
        </div>
      )}
      <div className="pf-roll__foot">
        <span className="pf-muted pf-roll__by">by {roll.curator}</span>
        {props.onChase && (
          <button
            type="button"
            className="pf-btn pf-btn--small"
            disabled={busy || props.chased}
            onClick={async () => {
              setBusy(true);
              setFailed(null);
              try {
                await props.onChase?.(roll);
              } catch (e) {
                setFailed(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Crosshair size={14} aria-hidden="true" />
            {props.chased ? "On your Chase list" : "Chase this roll"}
          </button>
        )}
      </div>
      {failed && <p className="pf-roll__error">{failed}</p>}
    </li>
  );
}
