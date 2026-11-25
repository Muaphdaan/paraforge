// Home: a summary of the vault for the current score context, the best weapons and what to shard.
import { useMemo } from "react";
import { ArrowRight, Crown, Diamond, Inbox, Layers, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { META_TIER_ORDER, metaTier } from "../app/api";
import { PageId } from "../app/pages";
import { useSession } from "../app/session";
import { EmptyState, VerdictPill } from "../ui/parts";
import { BungieImage, ElementIcon, WeaponTile } from "../ui/weapon";

type Go = (page: PageId) => void;

export function HomePage({ onNavigate, onOpenWeapon }: { onNavigate: Go; onOpenWeapon: (instanceId: string) => void }) {
  const session = useSession();
  const rows = session.vault;

  const stats = useMemo(() => {
    const list = rows ?? [];
    const count = (v: string) => list.filter((r) => r.score?.verdict === v).length;
    const scored = [...list].filter((r) => r.score).sort((a, b) => b.score!.score - a.score!.score);
    const tier = (r: (typeof list)[number]) => META_TIER_ORDER.indexOf(metaTier(r.meta));
    const drops = list.filter((r) => (r.first_seen ?? 0) > 0 && !r.mark).sort((a, b) => (b.first_seen ?? 0) - (a.first_seen ?? 0));
    return {
      total: list.length,
      keep: count("keep"),
      upgrade: count("upgrade"),
      replace: count("replace"),
      shard: count("shard"),
      exotics: list.filter((r) => r.look.rarity === 6).length,
      // Meta picks first, then the rest, each by score.
      best: [...scored].sort((a, b) => tier(a) - tier(b)).slice(0, 12),
      drops,
      shardList: scored.filter((r) => r.score!.verdict === "shard").reverse().slice(0, 6),
    };
  }, [rows]);

  if (!session.auth) return null;
  if (!session.auth.signed_in && !(rows && rows.length)) {
    return (
      <EmptyState
        pose="neutral"
        title="Let's get you set up"
        action={
          <button type="button" className="pf-btn pf-btn--primary" onClick={() => onNavigate("settings")}>
            Open Settings
          </button>
        }
      >
        Add your Bungie app keys and sign in. Then sync, and ParaForge scores every weapon you own.
      </EmptyState>
    );
  }
  if (session.vaultError) {
    return (
      <EmptyState pose="confused" title="Your vault could not be read">
        {session.vaultError}
      </EmptyState>
    );
  }
  // The vault for a newly picked score context is still loading.
  if (rows === null && session.info?.synced_at) return null;
  if (!rows || rows.length === 0) {
    return session.syncStep ? (
      <EmptyState pose="thinking" title="Syncing your vault">
        {session.syncStep}...
      </EmptyState>
    ) : (
      <EmptyState
        pose="happy"
        title="Ready when you are"
        action={
          <button type="button" className="pf-btn pf-btn--primary" onClick={session.sync}>
            Sync now
          </button>
        }
      >
        Sync once to bring in your weapons. The first sync downloads Bungie's item database, so it takes a little
        longer.
      </EmptyState>
    );
  }

  const parts = [
    { key: "keep", label: "Keep", value: stats.keep },
    { key: "upgrade", label: "Upgrade", value: stats.upgrade },
    { key: "replace", label: "Replace", value: stats.replace },
    { key: "shard", label: "Shard", value: stats.shard },
  ];
  const scoredTotal = parts.reduce((n, p) => n + p.value, 0) || 1;

  return (
    <div className="pf-home">
      <div className="pf-home__stats">
        <StatTile icon={Layers} label="Weapons owned" value={stats.total} />
        <StatTile icon={ShieldCheck} label="Worth keeping" value={stats.keep} tone="keep" />
        <StatTile icon={Diamond} label="Shard candidates" value={stats.shard} tone="shard" />
        <StatTile icon={Crown} label="Exotics" value={stats.exotics} tone="gold" />
      </div>

      <section className="pf-panel pf-home__health" aria-labelledby="home-health">
        <h2 className="pf-panel__title" id="home-health">
          Vault health
        </h2>
        <div className="pf-healthbar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
          {parts.map((p) =>
            p.value > 0 ? (
              <span key={p.key} className={`pf-healthbar__part pf-bg--${p.key}`} style={{ flexGrow: p.value / scoredTotal }} />
            ) : null,
          )}
        </div>
        <div className="pf-legend">
          {parts.map((p) => (
            <span key={p.key}>
              <span className={`pf-legend__dot pf-bg--${p.key}`} aria-hidden="true" />
              {p.label} <strong>{p.value}</strong>
            </span>
          ))}
        </div>
      </section>

      <section className="pf-panel pf-home__best" aria-labelledby="home-best">
        <div className="pf-home__head">
          <h2 className="pf-panel__title" id="home-best">
            Best in your vault
          </h2>
          <button type="button" className="pf-btn pf-btn--small" onClick={() => onNavigate("vault")}>
            Open Vault
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="pf-tiles">
          {stats.best.map((r) => (
            <WeaponTile key={r.instance_id} row={r} onSelect={() => onOpenWeapon(r.instance_id)} />
          ))}
        </div>
      </section>

      {stats.drops.length > 0 && (
        <section className="pf-panel pf-home__drops" aria-labelledby="home-drops">
          <div className="pf-home__head">
            <h2 className="pf-panel__title" id="home-drops">
              New drops <span className="pf-badge">{stats.drops.length}</span>
            </h2>
            <button type="button" className="pf-btn pf-btn--primary pf-btn--small" onClick={() => onNavigate("triage")}>
              <Inbox size={14} aria-hidden="true" />
              Review
            </button>
          </div>
          <div className="pf-tiles">
            {stats.drops.slice(0, 8).map((r) => (
              <WeaponTile key={r.instance_id} row={r} onSelect={() => onOpenWeapon(r.instance_id)} />
            ))}
          </div>
        </section>
      )}

      <section className="pf-panel pf-home__shard" aria-labelledby="home-shard">
        <h2 className="pf-panel__title" id="home-shard">
          Shard candidates
        </h2>
        {stats.shardList.length === 0 ? (
          <p className="pf-muted">Nothing to shard right now. Nice and tidy.</p>
        ) : (
          <ul className="pf-shardlist">
            {stats.shardList.map((r) => (
              <li key={r.instance_id}>
                <span className="pf-wrow__icon" data-rarity={r.look.rarity}>
                  <span className="pf-tile__fallback" aria-hidden="true">
                    {r.name.slice(0, 1)}
                  </span>
                  <BungieImage path={r.look.icon} className="pf-tile__icon" />
                </span>
                <span className="pf-wrow__name">
                  <strong>{r.name}</strong>
                  <span className="pf-muted">
                    <ElementIcon damage={r.look.damage} size={12} /> {r.type_name}
                  </span>
                </span>
                <span className="pf-wrow__score pf-v--shard">{r.score!.score.toFixed(0)}</span>
                <VerdictPill verdict="shard" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatTile(props: { icon: LucideIcon; label: string; value: number; tone?: string }) {
  const Icon = props.icon;
  return (
    <div className="pf-panel pf-stat" data-tone={props.tone}>
      <Icon size={22} aria-hidden="true" />
      <div>
        <div className="pf-stat__label">{props.label}</div>
        <div className="pf-stat__value">{props.value}</div>
      </div>
    </div>
  );
}
