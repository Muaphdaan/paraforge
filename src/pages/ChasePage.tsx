// The Chase list: each roll you're hunting with the perks you want, and how close your copies
// come. Rolls you already have come first, then the closest.
import { useMemo, useState } from "react";
import { ArrowRight, BookOpen, CircleCheck, Trash2 } from "lucide-react";
import { ChaseRoll, CodexRow, Perk, ROLE_LABELS, VaultRow } from "../app/api";
import { closestCopy, useChase } from "../app/chase";
import { useCodex } from "../app/codex";
import { PageId } from "../app/pages";
import { useSession } from "../app/session";
import { Banner, EmptyState } from "../ui/parts";
import { BungieImage, ElementIcon, PerkIcon } from "../ui/weapon";

type Line = { roll: ChaseRoll; weapon: CodexRow | undefined; closest: ReturnType<typeof closestCopy> };

function ratio(line: Line): number {
  if (!line.closest || line.closest.wanted === 0) return -1;
  return line.closest.matched / line.closest.wanted;
}

export function ChasePage(props: {
  onNavigate: (page: PageId) => void;
  onOpenInCodex: (hash: number) => void;
  onOpenWeapon: (instanceId: string) => void;
}) {
  const session = useSession();
  const chase = useChase();
  const codex = useCodex();
  const [error, setError] = useState<string | null>(null);

  const lines = useMemo<Line[]>(() => {
    const vault = session.vault ?? [];
    return (chase.list ?? [])
      .map((roll) => ({ roll, weapon: codex.byHash.get(roll.weapon), closest: closestCopy(roll, vault) }))
      .sort((a, b) => ratio(b) - ratio(a) || (a.weapon?.name ?? "").localeCompare(b.weapon?.name ?? ""));
  }, [chase.list, codex.byHash, session.vault]);

  if (chase.error && chase.list === null) {
    return (
      <EmptyState pose="confused" title="Your Chase list could not be read">
        {chase.error}
      </EmptyState>
    );
  }
  if (chase.list === null) return null;
  if (chase.list.length === 0) {
    return (
      <EmptyState
        pose="neutral"
        title="No rolls chased yet"
        action={
          <button type="button" className="pf-btn pf-btn--primary" onClick={() => props.onNavigate("codex")}>
            <BookOpen size={16} aria-hidden="true" />
            Open the Codex
          </button>
        }
      >
        Pick a weapon in the Codex, choose the perks you want and press Chase this roll. ParaForge then shows how
        close your copies come, and flags the drop that matches.
      </EmptyState>
    );
  }

  const got = lines.filter((l) => l.closest && l.closest.matched === l.closest.wanted).length;

  async function remove(id: number) {
    setError(null);
    try {
      await chase.remove(id);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="pf-panel pf-chase" aria-label="Rolls you're hunting">
      <div className="pf-chase__head">
        <p>
          <strong>
            {lines.length} {lines.length === 1 ? "roll" : "rolls"} chased
          </strong>
          <span className="pf-muted">
            {" "}
            · {got === 0 ? "none in your vault yet" : `${got} already in your vault`}
          </span>
        </p>
        <button type="button" className="pf-btn pf-btn--small" onClick={() => props.onNavigate("codex")}>
          <BookOpen size={14} aria-hidden="true" />
          Chase another roll
        </button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <ul className="pf-chase__list">
        {lines.map((line) => (
          <ChaseLine
            key={line.roll.id}
            line={line}
            perks={session.perks}
            onRemove={() => remove(line.roll.id)}
            onOpenInCodex={() => props.onOpenInCodex(line.roll.weapon)}
            onOpenWeapon={props.onOpenWeapon}
          />
        ))}
      </ul>
    </section>
  );
}

function ChaseLine(props: {
  line: Line;
  perks: Record<number, Perk>;
  onRemove: () => void;
  onOpenInCodex: () => void;
  onOpenWeapon: (instanceId: string) => void;
}) {
  const { roll, weapon, closest } = props.line;
  const name = weapon?.name ?? "Unknown weapon";
  const done = closest !== null && closest.matched === closest.wanted;
  return (
    <li className="pf-chaseline" data-done={done || undefined}>
      <button type="button" className="pf-chaseline__weapon" onClick={props.onOpenInCodex} title="Open in the Codex">
        <span className="pf-wrow__icon" data-rarity={weapon?.look.rarity}>
          <span className="pf-tile__fallback" aria-hidden="true">
            {name.slice(0, 1)}
          </span>
          {weapon && <BungieImage path={weapon.look.icon} className="pf-tile__icon" />}
        </span>
        <span className="pf-wrow__name">
          <strong>{name}</strong>
          <span className="pf-muted">
            {weapon && <ElementIcon damage={weapon.look.damage} size={12} />} {weapon?.type_name}
            {weapon?.look.source && ` · ${weapon.look.source}`}
          </span>
        </span>
      </button>

      <div className="pf-chaseline__perks">
        {roll.perks.map((want, i) =>
          want.length === 0 ? null : (
            <div key={i} className="pf-chaseline__col">
              <span className="pf-perkcol__label">{weapon ? (ROLE_LABELS[weapon.roles[i]] ?? "Perk") : "Perk"}</span>
              <span className="pf-chaseline__picks">
                {want.map((h) => (
                  <span key={h} className="pf-chaseline__pick" data-have={haveIn(closest?.copy, i, h) || undefined}>
                    <PerkIcon hash={h} perk={props.perks[h]} size={26} />
                    {props.perks[h]?.name ?? "Unknown perk"}
                  </span>
                ))}
              </span>
            </div>
          ),
        )}
      </div>

      <div className="pf-chaseline__status">
        {done ? (
          <span className="pf-chaseline__got">
            <CircleCheck size={18} aria-hidden="true" />
            You have it
          </span>
        ) : closest ? (
          <>
            <span className="pf-muted">
              Closest copy: {closest.matched} of {closest.wanted}
            </span>
            <span className="pf-chaseline__bar" aria-hidden="true">
              <span style={{ width: `${(closest.matched / Math.max(1, closest.wanted)) * 100}%` }} />
            </span>
          </>
        ) : (
          <span className="pf-muted">Not owned yet</span>
        )}
        <div className="pf-row">
          {closest && (
            <button type="button" className="pf-btn pf-btn--small" onClick={() => props.onOpenWeapon(closest.copy.instance_id)}>
              {done ? "Open it" : "Open closest"}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="pf-iconbtn"
            onClick={props.onRemove}
            title="Stop chasing"
            aria-label={`Stop chasing this ${name} roll`}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
}

function haveIn(copy: VaultRow | undefined, column: number, hash: number): boolean {
  return Boolean(copy?.columns[column]?.options.includes(hash));
}
