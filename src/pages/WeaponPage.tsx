// The full page for one owned copy, as in the approved U08 mockup: hero, verdict per mode,
// every perk the weapon can roll with this copy's perks lit, stats, god rolls and your copies.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ClipboardCopy, Lock, MapPin, Sparkles } from "lucide-react";
import {
  CONTEXTS,
  CopyScore,
  LOCATION_LABEL,
  ROLE_LABELS,
  SLOTS,
  ScoreContext,
  VaultRow,
  WEAPON_STATS,
  WeaponDef,
  confidenceLabel,
  reasonText,
} from "../app/api";
import { useSession } from "../app/session";
import { EmptyState, TierPill, useCopy, VerdictPill } from "../ui/parts";
import { GodRolls } from "../ui/godrolls";
import { AmmoBadge, BungieImage, ElementBadge, PartList, PerkIcon, copyParts } from "../ui/weapon";
import { EquipButton } from "../ui/equip";

type ScoreMap = Record<string, CopyScore>;

/** Every owned copy's score in both modes, keyed by instance id. */
function useScoresByContext(dataVersion: number): Record<ScoreContext, ScoreMap> | null {
  const [scores, setScores] = useState<Record<ScoreContext, ScoreMap> | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(CONTEXTS.map((c) => invoke<CopyScore[]>("vault_scores", { context: c.value }))).then(
      (lists) => {
        if (!live) return;
        const out = {} as Record<ScoreContext, ScoreMap>;
        CONTEXTS.forEach((c, i) => {
          out[c.value] = Object.fromEntries(lists[i].map((s) => [s.instance_id, s]));
        });
        setScores(out);
      },
      () => live && setScores(null),
    );
    return () => {
      live = false;
    };
  }, [dataVersion]);
  return scores;
}

export function WeaponPage(props: { instanceId: string; onSelect: (instanceId: string) => void }) {
  const session = useSession();
  const rows = session.vault;
  const row = rows?.find((r) => r.instance_id === props.instanceId) ?? null;
  // undefined while this weapon's definition loads; null when there is none or it could not be read.
  // A reload after a sync keeps showing the last one until the new one arrives.
  const [loadedDef, setLoadedDef] = useState<{ hash: number; def: WeaponDef | null } | null>(null);
  const scores = useScoresByContext(session.dataVersion);
  const weaponHash = row?.weapon;

  useEffect(() => {
    if (weaponHash === undefined) return;
    let live = true;
    invoke<WeaponDef | null>("weapon", { hash: weaponHash }).then(
      (d) => live && setLoadedDef({ hash: weaponHash, def: d ?? null }),
      () => live && setLoadedDef({ hash: weaponHash, def: null }),
    );
    return () => {
      live = false;
    };
  }, [weaponHash, session.dataVersion]);

  const def = weaponHash !== undefined && loadedDef?.hash === weaponHash ? loadedDef.def : undefined;

  const copies = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => r.weapon === weaponHash)
        .sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1)),
    [rows, weaponHash],
  );

  if (rows === null) return null;
  if (!row) {
    return (
      <EmptyState pose="confused" title="That weapon is gone">
        It is no longer in your vault, probably dismantled since the last sync.
      </EmptyState>
    );
  }

  return (
    <div className="pf-weapon">
      <Hero row={row} context={session.context} />
      <VerdictCard row={row} scores={scores} context={session.context} />
      <PerksCard row={row} def={def} perks={session.perks} />
      <StatsCard row={row} />
      <GodRollsCard row={row} perks={session.perks} context={session.context} />
      <CopiesCard copies={copies} current={row.instance_id} onSelect={props.onSelect} />
    </div>
  );
}

function Hero({ row, context }: { row: VaultRow; context: ScoreContext }) {
  const session = useSession();
  const [copyState, copy] = useCopy();
  const exotic = row.look.rarity === 6;
  function copySummary() {
    const perks = row.columns
      .map((c) => c.options.map((h) => session.perks[h]?.name ?? "?").join(" or "))
      .join(", ");
    const ctx = CONTEXTS.find((c) => c.value === context)?.label ?? context;
    const lines = [
      `${row.name} (${exotic ? "Exotic " : ""}${row.type_name})${row.tier ? `, Tier ${row.tier}` : ""}${row.masterworked ? ", masterworked" : ""}`,
      row.score ? `${ctx}: ${row.score.score.toFixed(0)}, ${row.score.verdict.toUpperCase()}` : "Not scored",
      perks ? `Perks: ${perks}` : "",
    ].filter(Boolean);
    copy(lines.join("\n"));
  }
  return (
    <section className="pf-panel pf-weapon__hero" data-rarity={row.look.rarity} aria-label="Overview">
      <BungieImage path={row.look.screenshot} className="pf-weapon__shot" />
      <span className="pf-weapon__icon" data-rarity={row.look.rarity}>
        <span className="pf-tile__fallback" aria-hidden="true">
          {row.name.slice(0, 1)}
        </span>
        <BungieImage path={row.look.icon} className="pf-tile__icon" />
        <BungieImage path={row.look.watermark} className="pf-tile__watermark" />
      </span>
      <div className="pf-weapon__facts">
        <div className="pf-detail__kicker">
          {exotic ? "Exotic " : ""}
          {row.type_name}
        </div>
        <div className="pf-detail__chips">
          <span className="pf-chip pf-chip--live">{LOCATION_LABEL[row.location] ?? "Owned"}</span>
          <ElementBadge damage={row.look.damage} />
          <AmmoBadge ammo={row.look.ammo} />
          {SLOTS[row.look.slot] && row.look.slot > 0 && <span className="pf-chip">{SLOTS[row.look.slot]} slot</span>}
          {row.tier > 0 && <TierPill tier={row.tier} />}
          {row.masterworked && (
            <span className="pf-chip pf-chip--gold">
              <Sparkles size={12} aria-hidden="true" />
              Masterworked
            </span>
          )}
          {row.locked && (
            <span className="pf-chip">
              <Lock size={12} aria-hidden="true" />
              Locked
            </span>
          )}
        </div>
        {row.look.source && (
          <p className="pf-codex__source" data-tip="Where to farm another copy">
            <MapPin size={16} aria-hidden="true" />
            {row.look.source}
          </p>
        )}
      </div>
      <div className="pf-weapon__score">
        {row.score ? (
          <>
            <span className={`pf-detail__number pf-v--${row.score.verdict}`}>{row.score.score.toFixed(0)}</span>
            <div className="pf-stack" style={{ gap: 6 }}>
              <VerdictPill verdict={row.score.verdict} />
              <span className="pf-muted">{confidenceLabel(row.score.confidence)} confidence</span>
            </div>
          </>
        ) : (
          <span className="pf-muted">{row.columns.length === 0 ? "Fixed perks, not scored" : "Not scored yet"}</span>
        )}
      </div>
      <div className="pf-weapon__actions">
        <EquipButton instanceId={row.instance_id} ariaLabel={`Equip ${row.name}`} />
        <button type="button" className="pf-btn" onClick={copySummary}>
          {copyState === "copied" ? <Check size={16} aria-hidden="true" /> : <ClipboardCopy size={16} aria-hidden="true" />}
          <span role="status">
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy summary"}
          </span>
        </button>
      </div>
    </section>
  );
}

function VerdictCard(props: { row: VaultRow; scores: Record<ScoreContext, ScoreMap> | null; context: ScoreContext }) {
  const current = props.scores?.[props.context]?.[props.row.instance_id] ?? props.row.score;
  return (
    <section className="pf-panel pf-weapon__verdict" aria-labelledby="w-verdict">
      <h2 className="pf-panel__title" id="w-verdict">
        Verdict
      </h2>
      <ul className="pf-modes">
        {CONTEXTS.map((c) => {
          // While both modes load (or if that fails), the current mode still has the vault's score.
          const s =
            props.scores?.[c.value]?.[props.row.instance_id] ??
            (c.value === props.context ? (props.row.score ?? undefined) : undefined);
          return (
            <li key={c.value} data-current={c.value === props.context || undefined}>
              <span className="pf-modes__name">{c.label}</span>
              <span className="pf-modes__bar" aria-hidden="true">
                <span className={`pf-bg--${s?.verdict ?? "none"}`} style={{ width: `${s?.score ?? 0}%` }} />
              </span>
              <span className={`pf-modes__score pf-v--${s?.verdict ?? "none"}`}>{s ? s.score.toFixed(0) : "-"}</span>
              {s ? <VerdictPill verdict={s.verdict} /> : <span className="pf-muted">Not scored</span>}
            </li>
          );
        })}
      </ul>
      {current && current.reasons.length > 0 && (
        <ul className="pf-reasons">
          {current.reasons.map((r, i) => (
            <li key={i}>
              <Check size={14} strokeWidth={3} aria-hidden="true" />
              {reasonText(r, props.context)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PerksCard(props: { row: VaultRow; def: WeaponDef | null | undefined; perks: ReturnType<typeof useSession>["perks"] }) {
  const { row, def, perks } = props;
  return (
    <section className="pf-panel pf-weapon__perks" aria-labelledby="w-perks">
      <h2 className="pf-panel__title" id="w-perks">
        Perks
      </h2>
      {row.columns.length === 0 ? (
        <p className="pf-muted">This weapon has fixed perks.</p>
      ) : (
        <>
          <div className="pf-perkgrid">
            {row.columns.map((col, i) => {
              const have = new Set(col.options);
              // The pool, with this copy's perks first; a retired perk this copy still has is added.
              const pool = def?.pools[i] ?? [];
              const all = [...col.options, ...pool.filter((h) => !have.has(h))];
              return (
                <div key={i} className="pf-perkgrid__col" role="group" aria-label={ROLE_LABELS[row.roles[i]] ?? "Perk"}>
                  <div className="pf-perkgrid__label">{ROLE_LABELS[row.roles[i]] ?? "Perk"}</div>
                  {all.map((hash) => (
                    <span key={hash} className="pf-perkgrid__cell" data-have={have.has(hash) || undefined}>
                      <PerkIcon hash={hash} perk={perks[hash]} enhanced={have.has(hash) && col.enhanced} size={40} />
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="pf-muted pf-perkgrid__note">
            {def
              ? "Lit perks are on your copy. The rest can roll on this weapon."
              : def === undefined
                ? "Loading every perk this weapon can roll..."
                : "Only your copy's perks are shown; the full list comes after your next sync."}
          </p>
          <ul className="pf-rollnames">
            {row.columns.map((col, i) => (
              <li key={i}>
                <span className="pf-muted">{ROLE_LABELS[row.roles[i]] ?? "Perk"}</span>
                <strong>
                  {col.options.map((h) => perks[h]?.name ?? "Unknown perk").join(" or ")}
                  {col.enhanced && <span className="pf-perkrow__enh">Enhanced</span>}
                </strong>
              </li>
            ))}
          </ul>
        </>
      )}
      <PartList parts={copyParts(row.parts)} perks={perks} exotic={row.look.rarity === 6} size={36} describe />
    </section>
  );
}

function StatsCard({ row }: { row: VaultRow }) {
  const shown = WEAPON_STATS.filter((s) => row.stats[String(s.hash)] !== undefined);
  return (
    <section className="pf-panel pf-weapon__stats" aria-labelledby="w-stats">
      <h2 className="pf-panel__title" id="w-stats">
        Stats
      </h2>
      {shown.length === 0 ? (
        <p className="pf-muted">No stats yet. They arrive with your next sync.</p>
      ) : (
        <dl className="pf-stats">
          {shown.map((s) => {
            const value = row.stats[String(s.hash)];
            return (
              <div key={s.hash}>
                <dt>{s.name}</dt>
                <dd>
                  {s.bar && (
                    <span className="pf-stats__bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
                    </span>
                  )}
                  <span className="pf-stats__value">{value}</span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

function GodRollsCard(props: {
  row: VaultRow;
  perks: ReturnType<typeof useSession>["perks"];
  context: ScoreContext;
}) {
  const { row } = props;
  return (
    <section className="pf-panel pf-weapon__rolls" aria-labelledby="w-rolls">
      <h2 className="pf-panel__title" id="w-rolls">
        God rolls and guide
      </h2>
      {row.columns.length === 0 ? (
        <p className="pf-muted">This weapon has fixed perks, so every copy is the same roll.</p>
      ) : (
        <GodRolls
          weapon={row.weapon}
          roles={row.roles}
          perks={props.perks}
          context={props.context}
          copy={row}
          limit={6}
        />
      )}
    </section>
  );
}

function CopiesCard(props: { copies: VaultRow[]; current: string; onSelect: (id: string) => void }) {
  return (
    <section className="pf-panel pf-weapon__copies" aria-labelledby="w-copies">
      <h2 className="pf-panel__title" id="w-copies">
        Your copies ({props.copies.length})
      </h2>
      <div className="pf-copylist">
        {props.copies.map((c, i) => {
          const viewing = c.instance_id === props.current;
          return (
            <button
              key={c.instance_id}
              type="button"
              className="pf-copyline"
              aria-current={viewing ? "true" : undefined}
              onClick={() => props.onSelect(c.instance_id)}
            >
              <span className="pf-copyline__rank">#{i + 1}</span>
              <span className={`pf-copyline__score pf-v--${c.score?.verdict ?? "none"}`}>
                {c.score ? c.score.score.toFixed(0) : "-"}
              </span>
              {c.score ? <VerdictPill verdict={c.score.verdict} /> : <span className="pf-muted">Not scored</span>}
              {c.tier > 0 && <TierPill tier={c.tier} />}
              <span className="pf-copyline__where">{LOCATION_LABEL[c.location] ?? "Vault"}</span>
              {viewing && <span className="pf-pill pf-pill--accent">Viewing</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
