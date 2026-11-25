// Triage: review what dropped since the first sync (keep, shard or later, with K, S and L), and
// rank the copies of each weapon you own more than once. Decisions are ParaForge notes: nothing
// changes in the game.
import { KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Copy, Inbox, RotateCcw, Trash2 } from "lucide-react";
import { CopyMark, ROLE_LABELS, VaultRow, byMeta, reasonText } from "../app/api";
import { useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { matchShare, rollMatch, useGodRolls } from "../ui/godrolls";
import { EmptyState, TierPill, VerdictPill } from "../ui/parts";
import { useConfirm, useToast } from "../ui/feedback";
import { ActiveTag, BungieImage, ElementIcon, MetaMark, PerkIcon, selectedFirst } from "../ui/weapon";

type Tab = "drops" | "dupes";

/** What ParaForge suggests for a copy, given the player's other copies of the same weapon. */
export function suggestion(row: VaultRow, others: VaultRow[]): { mark: "keep" | "shard"; why: string } {
  const verdict = row.score?.verdict;
  const best = others.reduce<VaultRow | null>((b, r) => (!b || (r.score?.score ?? -1) > (b.score?.score ?? -1) ? r : b), null);
  const mine = row.score?.score ?? -1;
  if (!best) {
    if (verdict === "shard") return { mark: "shard", why: "Its perks are weak for this weapon." };
    return { mark: "keep", why: "It's your only copy of this weapon." };
  }
  const theirs = best.score?.score ?? -1;
  if (row.columns.length === 0) {
    return { mark: "shard", why: "You already own this weapon, and every copy has the same perks." };
  }
  if (theirs >= mine && verdict !== "keep") {
    return { mark: "shard", why: `You already have a copy that scores ${best.score?.score.toFixed(0) ?? "as well"}.` };
  }
  if (verdict === "shard") return { mark: "shard", why: "Its perks are weak for this weapon." };
  if (theirs >= mine) {
    return { mark: "keep", why: `It's a keeper on its own, about as good as your best other copy (${best.score?.score.toFixed(0)}).` };
  }
  return { mark: "keep", why: `It beats your best other copy (${best.score?.score.toFixed(0) ?? "not scored"}).` };
}

/** Copies of the same weapon. A reissue has its own hash and perk pool, so it is a different weapon. */
function sameWeapon(a: VaultRow, b: VaultRow) {
  return a.weapon === b.weapon && a.instance_id !== b.instance_id;
}

// What you put off with Later, kept while the app is open so leaving the page keeps the order.
let skippedMemo: string[] = [];

export function TriagePage(props: { onOpenWeapon: (instanceId: string) => void }) {
  const session = useSession();
  const rows = session.vault;
  const [tab, setTab] = useState<Tab>("drops");

  const drops = useMemo(
    () => (rows ?? []).filter((r) => (r.first_seen ?? 0) > 0 && !r.mark).sort((a, b) => (b.first_seen ?? 0) - (a.first_seen ?? 0)),
    [rows],
  );
  const reviewed = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => (r.first_seen ?? 0) > 0 && r.mark)
        .sort((a, b) => (b.marked_at ?? 0) - (a.marked_at ?? 0) || (b.first_seen ?? 0) - (a.first_seen ?? 0))
        .slice(0, 12),
    [rows],
  );
  const dupes = useMemo(() => {
    const byWeapon = new Map<number, VaultRow[]>();
    for (const r of rows ?? []) {
      const list = byWeapon.get(r.weapon);
      if (list) list.push(r);
      else byWeapon.set(r.weapon, [r]);
    }
    return [...byWeapon.values()]
      .filter((list) => list.length > 1)
      .map((list) => list.sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1)))
      .sort((a, b) => byMeta(a[0], b[0]) || b.length - a.length || a[0].name.localeCompare(b[0].name));
  }, [rows]);

  if (rows === null) return null;

  const tabs: { id: Tab; label: string; icon: typeof Inbox; count: number }[] = [
    { id: "drops", label: "New drops", icon: Inbox, count: drops.length },
    { id: "dupes", label: "Duplicates", icon: Copy, count: dupes.length },
  ];
  // Arrow keys, Home and End move between the tabs.
  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(tabs[next].id);
    document.getElementById(`triage-tab-${tabs[next].id}`)?.focus();
  };

  return (
    <div className="pf-triage">
      <div className="pf-chips" role="tablist" aria-label="Triage" onKeyDown={onTabKey}>
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            id={`triage-tab-${id}`}
            type="button"
            role="tab"
            className="pf-chipbtn"
            aria-selected={tab === id}
            aria-controls="triage-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            <Icon size={16} aria-hidden="true" /> {label} <span className="pf-badge">{count}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id="triage-panel" aria-labelledby={`triage-tab-${tab}`} className="pf-triage__panel">
        {tab === "drops" ? (
          <Drops drops={drops} reviewed={reviewed} rows={rows} onOpenWeapon={props.onOpenWeapon} />
        ) : (
          <Dupes groups={dupes} onOpenWeapon={props.onOpenWeapon} />
        )}
      </div>
    </div>
  );
}

function Drops(props: { drops: VaultRow[]; reviewed: VaultRow[]; rows: VaultRow[]; onOpenWeapon: (id: string) => void }) {
  const session = useSession();
  const [skipped, setSkippedState] = useState<string[]>(skippedMemo);
  const setSkipped = (f: (s: string[]) => string[]) => setSkippedState((s) => (skippedMemo = f(s)));
  // Drops whose decision is still being saved: the next one shows at once, and a second key press
  // can't land on the same drop.
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const queue = useMemo(() => {
    const open = props.drops.filter((r) => !pending.includes(r.instance_id));
    return [...open.filter((r) => !skipped.includes(r.instance_id)), ...open.filter((r) => skipped.includes(r.instance_id))];
  }, [props.drops, skipped, pending]);
  const current = queue[0] ?? null;
  // What screen readers hear after each decision.
  const [said, setSaid] = useState("");
  const emptyRef = useRef<HTMLDivElement>(null);
  const hadCurrent = useRef(Boolean(current));
  // When the last drop is decided, focus moves to the "all done" message instead of the page.
  useEffect(() => {
    if (hadCurrent.current && !current) emptyRef.current?.focus();
    hadCurrent.current = Boolean(current);
  }, [current]);

  const nextAfter = (row: VaultRow) => {
    const rest = queue.filter((r) => r.instance_id !== row.instance_id);
    return rest.length > 0 ? ` Now showing ${rest[0].name}, ${rest.length} to review.` : " No new drops left to review.";
  };

  async function decide(mark: CopyMark | null, row: VaultRow) {
    if (pending.includes(row.instance_id)) return;
    setError(null);
    setPending((p) => [...p, row.instance_id]);
    const verb = mark === "keep" ? "Kept" : mark === "shard" ? "Marked to shard:" : "Back in the queue:";
    try {
      await session.markCopy(row.instance_id, mark);
      setSaid(`${verb} ${row.name}.${mark ? nextAfter(row) : ""}`);
    } catch (e) {
      setError(String(e));
      setSaid(`Could not save the decision on ${row.name}.`);
    } finally {
      setPending((p) => p.filter((id) => id !== row.instance_id));
    }
  }
  function later(row: VaultRow) {
    setSkipped((s) => [...s.filter((id) => id !== row.instance_id), row.instance_id]);
    setSaid(`Put off ${row.name}.${nextAfter(row)}`);
  }
  const live = (
    <p className="pf-visually-hidden" role="status">
      {said}
    </p>
  );

  // K, S and L decide on the drop on screen, unless you are typing somewhere.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      // Not while search, a menu or a dialog is open.
      if (document.querySelector(".pf-palette, [role=menu], .pf-modal")) return;
      const k = e.key.toLowerCase();
      if (k === "k") decide("keep", current);
      else if (k === "s") decide("shard", current);
      else if (k === "l") later(current);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!current) {
    return (
      <>
        {live}
        <div ref={emptyRef} tabIndex={-1} className="pf-triage__empty">
          <EmptyState pose="happy" title="No new drops to review">
            Weapons that drop after your first sync show up here, so you can keep or shard each one while it's fresh.
          </EmptyState>
        </div>
        {props.reviewed.length > 0 && <Reviewed rows={props.reviewed} onUndo={(r) => decide(null, r)} />}
      </>
    );
  }

  // Copies already marked to shard are on their way out, so they don't count.
  const others = props.rows.filter((r) => sameWeapon(r, current) && r.mark !== "shard");
  const tip = suggestion(current, others);
  return (
    <div className="pf-triage__drops">
      {live}
      <DropCard
        row={current}
        others={others}
        suggestion={tip}
        left={queue.length}
        onKeep={() => decide("keep", current)}
        onShard={() => decide("shard", current)}
        onLater={() => later(current)}
        onOpen={() => props.onOpenWeapon(current.instance_id)}
      />
      {error && <p className="pf-roll__error">{error}</p>}
      {queue.length > 1 && (
        <section className="pf-panel" aria-label="Up next">
          <h2 className="pf-panel__title">Up next</h2>
          <ul className="pf-triage__queue">
            {queue.slice(1, 25).map((r) => (
              <li key={r.instance_id}>
                <MiniCopy row={r} />
              </li>
            ))}
          </ul>
          {queue.length > 25 && <p className="pf-muted">And {queue.length - 25} more.</p>}
        </section>
      )}
      {props.reviewed.length > 0 && <Reviewed rows={props.reviewed} onUndo={(r) => decide(null, r)} />}
    </div>
  );
}

function DropCard(props: {
  row: VaultRow;
  others: VaultRow[];
  suggestion: { mark: "keep" | "shard"; why: string };
  left: number;
  onKeep: () => void;
  onShard: () => void;
  onLater: () => void;
  onOpen: () => void;
}) {
  const { row } = props;
  const session = useSession();
  const now = useNow();
  const { rolls } = useGodRolls(row.columns.length > 0 ? row.weapon : undefined);
  const best = useMemo(() => {
    const mine = (rolls ?? []).filter((r) => r.context === session.context);
    let top: { matched: number; total: number; title: string } | null = null;
    for (const r of mine) {
      const m = rollMatch(r, row.columns);
      if (m.wanted > 0 && (!top || matchShare(m) > top.matched / top.total))
        top = { matched: m.matched, total: m.wanted, title: r.title };
    }
    return top;
  }, [rolls, row.columns, session.context]);
  const bestOther = props.others[0] ? [...props.others].sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1))[0] : null;

  return (
    <section className="pf-panel pf-drop" aria-labelledby="drop-name" data-rarity={row.look.rarity}>
      <div className="pf-drop__head">
        <span className="pf-weapon__icon pf-drop__icon" data-rarity={row.look.rarity}>
          <span className="pf-tile__fallback" aria-hidden="true">
            {row.name.slice(0, 1)}
          </span>
          <BungieImage path={row.look.icon} className="pf-tile__icon" />
          <MetaMark meta={row.meta} />
        </span>
        <div className="pf-drop__title">
          <span className="pf-muted">
            New drop · {timeAgo(row.first_seen ?? 0, now)} · {props.left} to review
          </span>
          <h2 id="drop-name">{row.name}</h2>
          <span className="pf-row">
            <ElementIcon damage={row.look.damage} size={14} /> {row.type_name}
            {row.tier > 0 && <TierPill tier={row.tier} />}
            {row.score && <VerdictPill verdict={row.score.verdict} />}
            {row.score && <strong>{row.score.score.toFixed(0)}</strong>}
          </span>
        </div>
      </div>

      <div className="pf-drop__body">
        <div className="pf-drop__perks">
          {row.columns.map((c, i) => (
            <div key={i} className="pf-drop__col">
              <span className="pf-perkcol__label">{ROLE_LABELS[row.roles[i]] ?? "Perk"}</span>
              {selectedFirst(c).map((h) => (
                <span key={h} className="pf-perkrow" data-selected={c.plugged === h || undefined}>
                  <PerkIcon hash={h} perk={session.perks[h]} enhanced={c.enhanced} size={28} decorative />
                  <span className="pf-perkrow__name">
                    {session.perks[h]?.name ?? "Unknown perk"}
                    {c.plugged === h && c.options.length > 1 && <ActiveTag />}
                  </span>
                </span>
              ))}
            </div>
          ))}
          {row.columns.length === 0 && <p className="pf-muted">Fixed perks: every copy is the same roll.</p>}
        </div>
        <div className="pf-drop__advice" data-mark={props.suggestion.mark}>
          <span className="pf-perkcol__label">ParaForge suggests</span>
          <strong className="pf-drop__verdict">{props.suggestion.mark === "keep" ? "Keep it" : "Shard it"}</strong>
          <p>{props.suggestion.why}</p>
          <ul className="pf-drop__facts">
            {best && (
              <li>
                Closest god roll: {best.matched} of {best.total} columns
                {best.title ? ` (${best.title})` : ""}
              </li>
            )}
            {bestOther && (
              <li>
                Your best other copy: {bestOther.score ? bestOther.score.score.toFixed(0) : "not scored"}
                {props.others.length > 1 ? ` (${props.others.length} other copies)` : ""}
              </li>
            )}
            {row.score?.reasons.slice(0, 2).map((r, i) => (
              <li key={i}>{reasonText(r, session.context)}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="pf-drop__actions">
        <button type="button" className="pf-btn pf-btn--primary" onClick={props.onKeep} aria-keyshortcuts="K">
          <Check size={16} aria-hidden="true" /> Keep <kbd>K</kbd>
        </button>
        <button type="button" className="pf-btn pf-btn--danger" onClick={props.onShard} aria-keyshortcuts="S">
          <Trash2 size={16} aria-hidden="true" /> Shard <kbd>S</kbd>
        </button>
        <button type="button" className="pf-btn" onClick={props.onLater} aria-keyshortcuts="L">
          Later <kbd>L</kbd>
        </button>
        <button type="button" className="pf-btn pf-btn--small pf-drop__open" onClick={props.onOpen}>
          Open weapon page <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="pf-muted pf-drop__note">
        Keep and Shard are notes in ParaForge; dismantle in the game when you're ready. Shard picks show in the Vault.
      </p>
    </section>
  );
}

function MiniCopy({ row }: { row: VaultRow }) {
  return (
    <span className="pf-minicopy" data-tip={`${row.name}\n${row.type_name}${row.score ? ` · ${row.score.score.toFixed(0)}` : ""}`}>
      <span className="pf-wrow__icon" data-rarity={row.look.rarity}>
        <span className="pf-tile__fallback" aria-hidden="true">
          {row.name.slice(0, 1)}
        </span>
        <BungieImage path={row.look.icon} className="pf-tile__icon" />
      </span>
      <span className="pf-minicopy__name">{row.name}</span>
      {row.score && <VerdictPill verdict={row.score.verdict} />}
    </span>
  );
}

function Reviewed(props: { rows: VaultRow[]; onUndo: (row: VaultRow) => void }) {
  return (
    <section className="pf-panel" aria-label="Reviewed recently">
      <h2 className="pf-panel__title">Reviewed recently</h2>
      <ul className="pf-triage__reviewed">
        {props.rows.map((r) => (
          <li key={r.instance_id}>
            <MiniCopy row={r} />
            <span className={`pf-markpill pf-markpill--${r.mark}`}>{r.mark === "keep" ? "Keep" : r.mark === "shard" ? "Shard" : "Seen"}</span>
            <button type="button" className="pf-iconbtn" onClick={() => props.onUndo(r)} data-tip="Undo" aria-label={`Undo the decision on ${r.name}`}>
              <RotateCcw size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dupes(props: { groups: VaultRow[][]; onOpenWeapon: (id: string) => void }) {
  const session = useSession();
  const confirm = useConfirm();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  if (props.groups.length === 0) {
    return (
      <EmptyState pose="happy" title="No duplicates">
        You own one copy of every weapon, so there's nothing to compare.
      </EmptyState>
    );
  }
  async function mark(row: VaultRow, m: CopyMark | null) {
    setError(null);
    try {
      await session.markCopy(row.instance_id, m);
    } catch (e) {
      setError(String(e));
    }
  }
  async function shardOthers(name: string, rest: VaultRow[], group: HTMLElement | null) {
    const n = rest.length;
    const ok = await confirm({
      title: `Mark ${n} ${n === 1 ? "copy" : "copies"} of ${name} to shard?`,
      body: (
        <p>
          ParaForge only marks them; nothing is dismantled. Shard marks show in the Vault so you can find them in the game.
        </p>
      ),
      confirm: `Mark ${n} to shard`,
      tone: "danger",
    });
    if (!ok) return;
    await Promise.all(rest.map((c) => mark(c, "shard")));
    // The button is gone now; keep focus in the weapon's group.
    const a = document.activeElement;
    if (group?.isConnected && (!a || a === document.body || !a.isConnected)) group.focus();
    toast({
      tone: "success",
      text: `Marked ${n} ${n === 1 ? "copy" : "copies"} of ${name} to shard.`,
      action: { label: "Undo", run: () => rest.forEach((c) => mark(c, c.mark ?? null)) },
    });
  }
  return (
    <div className="pf-triage__dupes">
      <p className="pf-muted">
        Each weapon you own more than once, copies best first for {session.context === "pvp" ? "PvP" : "PvE"}. Meta picks
        come first.
      </p>
      {error && <p className="pf-roll__error">{error}</p>}
      {props.groups.map((copies) => {
        const top = copies[0];
        // The copy to keep: one marked Keep, else the best copy not marked to shard.
        const keeper = copies.find((c) => c.mark === "keep") ?? copies.find((c) => c.mark !== "shard");
        const rest = keeper ? copies.filter((c) => c !== keeper && !c.mark) : [];
        return (
          <section key={top.weapon} className="pf-panel pf-dupe" aria-label={top.name} tabIndex={-1}>
            <div className="pf-dupe__head">
              <span className="pf-wrow__icon" data-rarity={top.look.rarity}>
                <span className="pf-tile__fallback" aria-hidden="true">
                  {top.name.slice(0, 1)}
                </span>
                <BungieImage path={top.look.icon} className="pf-tile__icon" />
              </span>
              <span className="pf-wrow__name">
                <strong>{top.name}</strong>
                <span className="pf-muted">
                  {top.type_name} · {copies.length} copies
                </span>
              </span>
              {rest.length > 0 && (
                <button type="button" className="pf-btn pf-btn--small" onClick={(e) => shardOthers(top.name, rest, e.currentTarget.closest("section"))}>
                  <Trash2 size={14} aria-hidden="true" />
                  {keeper === top ? "" : `Keep #${copies.indexOf(keeper!) + 1}, `}
                  {keeper === top ? "Mark" : "mark"} the other {rest.length} to shard
                </button>
              )}
            </div>
            <ol className="pf-dupe__list">
              {copies.map((c, i) => (
                <li key={c.instance_id} className="pf-dupe__copy" data-mark={c.mark ?? undefined}>
                  <span className="pf-copyline__rank">#{i + 1}</span>
                  <span className={`pf-copyline__score pf-v--${c.score?.verdict ?? "none"}`}>{c.score ? c.score.score.toFixed(0) : "-"}</span>
                  {c.score ? <VerdictPill verdict={c.score.verdict} /> : <span className="pf-muted">Not scored</span>}
                  {c.tier > 0 && <TierPill tier={c.tier} />}
                  <span className="pf-dupe__perks">
                    {c.columns.map((col) => col.options.map((h) => session.perks[h]?.name ?? "?").join(" / ")).join(" · ")}
                  </span>
                  {i === 0 && <span className="pf-pill pf-pill--accent">Best copy</span>}
                  <span className="pf-dupe__marks" role="group" aria-label={`Decision for copy ${i + 1}`}>
                    <button type="button" className="pf-chipbtn pf-chipbtn--small" aria-pressed={c.mark === "keep"} onClick={() => mark(c, c.mark === "keep" ? null : "keep")}>
                      Keep
                    </button>
                    <button type="button" className="pf-chipbtn pf-chipbtn--small pf-chipbtn--danger" aria-pressed={c.mark === "shard"} onClick={() => mark(c, c.mark === "shard" ? null : "shard")}>
                      Shard
                    </button>
                  </span>
                  <button type="button" className="pf-iconbtn" onClick={() => props.onOpenWeapon(c.instance_id)} data-tip="Open weapon page" aria-label={`Open copy ${i + 1} of ${c.name}`}>
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
