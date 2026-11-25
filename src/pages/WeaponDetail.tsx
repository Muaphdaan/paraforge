// The detail panel for one owned copy, in the spirit of light.gg: screenshot banner, the facts,
// the score with its reasons, every perk column with icons, and your other copies of the weapon.
import { ArrowRight, Check, Lock, MapPin, Sparkles } from "lucide-react";
import { Perk, ROLE_LABELS, ScoreContext, SLOTS, VaultRow, reasonText } from "../app/api";
import { GodRolls } from "../ui/godrolls";
import { TierPill, VerdictPill } from "../ui/parts";
import { AmmoBadge, BungieImage, ElementBadge, PartList, PerkIcon, copyParts } from "../ui/weapon";
import { EquipButton } from "../ui/equip";

export function WeaponDetail(props: {
  row: VaultRow;
  copies: VaultRow[];
  perks: Record<number, Perk>;
  context: ScoreContext;
  onSelect: (instanceId: string) => void;
  onOpen: () => void;
}) {
  const { row, perks } = props;
  const exotic = row.look.rarity === 6;
  const copies = [...props.copies].sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1));
  return (
    <aside className="pf-panel pf-detail" aria-label={`${row.name} details`}>
      <div className="pf-detail__hero" data-rarity={row.look.rarity}>
        <BungieImage path={row.look.screenshot} className="pf-detail__shot" />
        <div className="pf-detail__heroinfo">
          <span className="pf-detail__icon" data-rarity={row.look.rarity}>
            <span className="pf-tile__fallback" aria-hidden="true">
              {row.name.slice(0, 1)}
            </span>
            <BungieImage path={row.look.icon} className="pf-tile__icon" />
            <BungieImage path={row.look.watermark} className="pf-tile__watermark" />
          </span>
          <div className="pf-detail__titles">
            <div className="pf-detail__kicker">
              {exotic ? "Exotic " : ""}
              {row.type_name}
            </div>
            <h2 className="pf-detail__name" data-selectable>
              {row.name}
            </h2>
          </div>
        </div>
      </div>

      <div className="pf-detail__body">
        <div className="pf-detail__chips">
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
          <p className="pf-codex__source">
            <MapPin size={16} aria-hidden="true" />
            {row.look.source}
          </p>
        )}

        <div className="pf-detail__actions">
          <button type="button" className="pf-btn pf-btn--primary pf-detail__open" onClick={props.onOpen}>
            Open weapon page
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          {row.location !== "equipped" && <EquipButton instanceId={row.instance_id} ariaLabel={`Equip ${row.name}`} />}
        </div>

        {row.score ? (
          <div className="pf-detail__score">
            <span className={`pf-detail__number pf-v--${row.score.verdict}`}>{row.score.score.toFixed(0)}</span>
            <div className="pf-stack" style={{ gap: 6 }}>
              <VerdictPill verdict={row.score.verdict} />
              <span className="pf-muted pf-detail__confidence">
                {Math.round(row.score.confidence * 100)}% confidence
              </span>
            </div>
          </div>
        ) : (
          <p className="pf-muted">
            {row.columns.length === 0 ? "No random perks, so there is nothing to score." : "Not scored yet."}
          </p>
        )}

        {row.score && row.score.reasons.length > 0 && (
          <ul className="pf-reasons">
            {row.score.reasons.map((r, i) => (
              <li key={i}>
                <Check size={14} strokeWidth={3} aria-hidden="true" />
                {reasonText(r, props.context)}
              </li>
            ))}
          </ul>
        )}

        <h3 className="pf-detail__heading">Perks</h3>
        {row.columns.length === 0 ? (
          <p className="pf-muted">This weapon has fixed perks.</p>
        ) : (
          <div className="pf-perkcols">
            {row.columns.map((col, i) => (
              <div key={i} className="pf-perkcol">
                <div className="pf-perkcol__label">{ROLE_LABELS[row.roles[i]] ?? "Perk"}</div>
                {col.options.map((hash) => (
                  <div key={hash} className="pf-perkrow">
                    <PerkIcon hash={hash} perk={perks[hash]} enhanced={col.enhanced} size={34} />
                    <span className="pf-perkrow__name">
                      {perks[hash]?.name ?? "Unknown perk"}
                      {col.enhanced && <span className="pf-perkrow__enh">Enhanced</span>}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <PartList parts={copyParts(row.parts)} perks={perks} exotic={row.look.rarity === 6} size={30} />

        {row.columns.length > 0 && (
          <>
            <h3 className="pf-detail__heading">God rolls</h3>
            <GodRolls
              weapon={row.weapon}
              roles={row.roles}
              perks={perks}
              context={props.context}
              copy={row}
              limit={2}
              compact
            />
          </>
        )}

        {copies.length > 1 && (
          <>
            <h3 className="pf-detail__heading">Your copies ({copies.length})</h3>
            <div className="pf-copies">
              {copies.map((c, i) => (
                <button
                  key={c.instance_id}
                  type="button"
                  className="pf-copy"
                  aria-pressed={c.instance_id === row.instance_id}
                  onClick={() => props.onSelect(c.instance_id)}
                >
                  <span className="pf-copy__rank">#{i + 1}</span>
                  <TierPill tier={c.tier} />
                  <span className="pf-copy__perks">
                    {c.columns.map((col, j) =>
                      col.options
                        .slice(0, 1)
                        .map((h) => <PerkIcon key={`${j}-${h}`} hash={h} perk={perks[h]} enhanced={col.enhanced} size={22} />),
                    )}
                  </span>
                  <span className={`pf-copy__score pf-v--${c.score?.verdict ?? "none"}`}>
                    {c.score ? c.score.score.toFixed(0) : "-"}
                  </span>
                  {c.score && <VerdictPill verdict={c.score.verdict} />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
