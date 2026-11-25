// Settings, as in the approved U07 mockup: a section list on the left and the chosen section's
// cards on the right. Keys go to the Rust side once and never come back to the interface.
import { ReactNode, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleUserRound,
  Database,
  ExternalLink,
  Info,
  Keyboard,
  LogIn,
  LogOut,
  RefreshCw,
  Star,
  type LucideIcon,
} from "lucide-react";
import { CONTEXTS } from "../app/api";
import { PLAYING_INTERVAL_MIN, useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { KeysForm, RedirectUrl, signOut, useSignIn } from "../ui/account";
import { useConfirm } from "../ui/feedback";
import { Banner, Dropdown, Toggle, VerdictPill } from "../ui/parts";

export type SettingsSection = "account" | "sync" | "scoring" | "data" | "shortcuts" | "about";

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "account", label: "Account", icon: CircleUserRound },
  { id: "sync", label: "Sync", icon: RefreshCw },
  { id: "scoring", label: "Scoring", icon: Star },
  { id: "data", label: "Data", icon: Database },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

export function SettingsPage(props: { section: SettingsSection; onSection: (s: SettingsSection) => void }) {
  return (
    <div className="pf-panel pf-settings">
      <nav className="pf-settings__nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="pf-settings__tab"
            aria-current={props.section === id ? "page" : undefined}
            onClick={() => props.onSection(id)}
          >
            <Icon size={20} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      <div className="pf-settings__body">
        {props.section === "account" && (
          <>
            <AccountCard />
            <KeysCard />
          </>
        )}
        {props.section === "sync" && <SyncCard />}
        {props.section === "scoring" && <ScoringCard />}
        {props.section === "data" && <DataCard />}
        {props.section === "shortcuts" && <ShortcutsCard />}
        {props.section === "about" && <AboutCard />}
      </div>
    </div>
  );
}

function Card(props: { id: string; title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className="pf-card pf-stack" data-wide={props.wide || undefined} aria-labelledby={props.id}>
      <h2 className="pf-panel__title" id={props.id}>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function AccountCard() {
  const session = useSession();
  const confirm = useConfirm();
  const auth = session.auth;
  const signIn = useSignIn();
  const [message, setMessage] = useState<string | null>(null);
  const signedIn = Boolean(auth?.signed_in);
  // The stored name is from the last sync; another account signed in since then shows its id instead.
  // A name stored by an older version has no account id: it can only be the one that synced it.
  const info = session.info;
  const ownName =
    info?.player && (info.player_membership_id == null || info.player_membership_id === auth?.membership_id)
      ? info.player
      : null;
  const name = ownName ?? (auth?.membership_id ? `Bungie.net member ${auth.membership_id}` : "Guardian");
  const startSignIn = () => {
    setMessage(null);
    void signIn.start();
  };

  return (
    <Card id="settings-account" title="Bungie account">
      {!auth ? (
        <p className="pf-muted">Checking your sign-in...</p>
      ) : signedIn ? (
        <>
          <div className="pf-account">
            <span className="pf-account__avatar" aria-hidden="true">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <div className="pf-stack" style={{ gap: 6 }}>
              <strong className="pf-account__name" data-selectable>
                {name}
              </strong>
              <span className="pf-pill pf-pill--live">
                <span className="pf-status__dot" aria-hidden="true" />
                Connected
              </span>
              {auth.sign_in_expires_at && (
                <span className="pf-muted">
                  You stay signed in while you use ParaForge, until about{" "}
                  {new Date(auth.sign_in_expires_at * 1000).toLocaleDateString()}.
                </span>
              )}
            </div>
          </div>
          <div className="pf-row">
            <button type="button" className="pf-btn" onClick={startSignIn} disabled={signIn.busy}>
              <LogIn size={16} aria-hidden="true" />
              {signIn.waiting ? "Waiting for Bungie..." : "Sign in again"}
            </button>
            <button
              type="button"
              className="pf-btn pf-btn--danger"
              onClick={async () => {
                const ok = await confirm({
                  title: "Sign out of Bungie?",
                  body: <p>Your synced weapons, marks and Chase list stay on this PC. Sign in again to sync.</p>,
                  confirm: "Sign out",
                  tone: "danger",
                });
                if (!ok) return;
                setMessage(null);
                setMessage(await signOut(session.setAuth));
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </>
      ) : auth.has_app_keys ? (
        <>
          <p className="pf-muted">
            {signIn.waiting
              ? "Finish signing in in your browser. ParaForge picks it up by itself."
              : "Sign in with Bungie in your browser. ParaForge never sees your password."}
          </p>
          <div className="pf-row">
            <button type="button" className="pf-btn pf-btn--primary" onClick={startSignIn} disabled={signIn.busy}>
              <LogIn size={16} aria-hidden="true" />
              {signIn.waiting ? "Start sign-in again" : "Sign in with Bungie"}
            </button>
          </div>
        </>
      ) : (
        <p className="pf-muted">Add your Bungie app keys first, then sign in here.</p>
      )}
      {(message || signIn.error) && <Banner tone="error">{message ?? signIn.error}</Banner>}
    </Card>
  );
}

function KeysCard() {
  const session = useSession();
  const hasKeys = Boolean(session.auth?.has_app_keys);
  const [replacing, setReplacing] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <Card id="settings-keys" title="App keys">
      <p className="pf-muted">
        Your private Bungie app. The keys stay in Windows Credential Manager, never in a file, and ParaForge never shows
        them again.
      </p>
      <RedirectUrl />
      {hasKeys && !replacing ? (
        <div className="pf-row pf-row--between">
          <span className="pf-pill pf-pill--live">{saved ? "Keys saved" : "Keys saved on this PC"}</span>
          <button type="button" className="pf-btn" onClick={() => setReplacing(true)}>
            Replace keys
          </button>
        </div>
      ) : (
        <KeysForm
          submitLabel="Save keys"
          onSaved={() => {
            setSaved(true);
            setReplacing(false);
          }}
          footer={
            hasKeys && (
              <button type="button" className="pf-btn" onClick={() => setReplacing(false)}>
                Cancel
              </button>
            )
          }
        />
      )}
      {hasKeys && replacing && (
        <p className="pf-muted">New keys sign you out, because Bungie ties a sign-in to the app that made it.</p>
      )}
    </Card>
  );
}

const INTERVALS = [
  { value: "5", label: "Every 5 minutes" },
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "60", label: "Every hour" },
  { value: "0", label: "Never" },
];

function SyncCard() {
  const session = useSession();
  const now = useNow();
  const prefs = session.syncPrefs;
  const summary = session.summary;
  const syncing = session.syncStep !== null;
  const copies = summary?.copies ?? session.info?.copies;
  return (
    <Card id="settings-sync" title="Sync" wide>
      <Toggle
        checked={prefs.whilePlaying}
        onChange={(whilePlaying) => session.setSyncPrefs({ ...prefs, whilePlaying })}
        label="Sync while I play"
        description={
          session.playing
            ? `Destiny 2 is running, so ParaForge syncs every ${PLAYING_INTERVAL_MIN} minutes.`
            : `Every ${PLAYING_INTERVAL_MIN} minutes while Destiny 2 is running on this PC.`
        }
      />
      <Toggle
        checked={prefs.onStart}
        onChange={(onStart) => session.setSyncPrefs({ ...prefs, onStart })}
        label="Sync when ParaForge starts"
      />
      <div className="pf-row pf-row--between">
        <div className="pf-stack" style={{ gap: 2 }}>
          <span className="pf-toggle__label">The rest of the time</span>
          <span className="pf-muted">How often to sync while ParaForge is open.</span>
        </div>
        <Dropdown
          label="Sync schedule"
          value={String(prefs.interval)}
          options={INTERVALS}
          onChange={(v) => session.setSyncPrefs({ ...prefs, interval: Number(v) })}
        />
      </div>
      <hr className="pf-rule" />
      <p className="pf-muted">
        {syncing
          ? `${session.syncStep}...`
          : session.syncedAt
            ? `Last sync ${timeAgo(session.syncedAt, now)}${copies !== undefined ? ` · ${copies} weapons` : ""}`
            : "Not synced yet."}
      </p>
      {summary && !syncing && (summary.unreadable > 0 || summary.characters_hidden || summary.not_scored > 0) && (
        <p className="pf-muted">
          {summary.unreadable > 0 && `${summary.unreadable} weapons had no perk data. `}
          {summary.characters_hidden && "Bungie hid your characters' inventories; check your privacy settings. "}
          {summary.not_scored > 0 && `${summary.not_scored} could not be scored.`}
        </p>
      )}
      {session.syncError && <Banner tone="error">Last sync failed: {session.syncError}</Banner>}
      <div className="pf-row">
        <button
          type="button"
          className="pf-btn pf-btn--primary"
          onClick={session.sync}
          disabled={!session.auth?.signed_in}
          aria-disabled={syncing || undefined}
        >
          <RefreshCw size={16} className={syncing ? "pf-spin" : undefined} aria-hidden="true" />
          {syncing ? "Syncing..." : "Sync now"}
        </button>
      </div>
    </Card>
  );
}

function ScoringCard() {
  const session = useSession();
  const rules = session.info?.rules;
  return (
    <>
      <Card id="settings-mode" title="Score for">
        <p className="pf-muted">Every weapon is scored for both. This picks which one ParaForge shows.</p>
        <div className="pf-segmented" role="group" aria-label="Score for">
          {CONTEXTS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={session.context === c.value}
              onClick={() => session.setContext(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </Card>
      <Card id="settings-verdicts" title="What the verdicts mean" wide>
        {rules ? (
          <ul className="pf-verdict-rules">
            <li>
              <VerdictPill verdict="keep" />
              <span>Scores {rules.keep_at} or more.</span>
            </li>
            <li>
              <VerdictPill verdict="upgrade" />
              <span>Below {rules.keep_at} now, but a masterwork and enhanced perks would get it there.</span>
            </li>
            <li>
              <VerdictPill verdict="replace" />
              <span>
                Between {rules.shard_below} and {rules.keep_at}: usable, worth replacing with a better roll.
              </span>
            </li>
            <li>
              <VerdictPill verdict="shard" />
              <span>
                Below {rules.shard_below}, or a duplicate that stays {rules.duplicate_margin}+ points behind your best
                copy even fully upgraded.
              </span>
            </li>
          </ul>
        ) : (
          <p className="pf-muted">Loading...</p>
        )}
        <Banner tone="info">
          Scores compare each copy with the community god rolls. Perk ratings are still ParaForge&rsquo;s starter
          rules ({session.info?.ruleset ?? "dev"}), so a weapon no curator has a roll for lands around 60.
        </Banner>
      </Card>
    </>
  );
}

function DataCard() {
  const { info } = useSession();
  return (
    <Card id="settings-data" title="Data" wide>
      {info && (
        <dl className="pf-facts">
          <dt>Bungie item database</dt>
          <dd>{info.manifest_version ?? "Not downloaded yet"}</dd>
          <dt>Weapons known</dt>
          <dd>{info.weapons_known.toLocaleString()}</dd>
          <dt>Perks known</dt>
          <dd>{info.perks_known.toLocaleString()}</dd>
          <dt>Your weapons stored</dt>
          <dd>{info.copies.toLocaleString()}</dd>
          <dt>God rolls</dt>
          <dd>
            {info.god_rolls > 0
              ? `${info.god_rolls.toLocaleString()} curated rolls from the community voltron list (MIT)`
              : "They come with your next sync"}
            {info.god_roll_error && <span className="pf-muted"> · Last update failed: {info.god_roll_error}</span>}
          </dd>
        </dl>
      )}
      <p className="pf-muted">
        Bungie's item database is downloaded again only after a game update. The god-roll list is checked every 6
        hours when you sync. Everything is stored on this PC.
      </p>
      <div className="pf-row">
        <button type="button" className="pf-btn" onClick={() => invoke("open_bungie_apps").catch(() => {})}>
          <ExternalLink size={16} aria-hidden="true" />
          Manage your Bungie app
        </button>
      </div>
    </Card>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl + K", "Search weapons and perks"],
  ["F5", "Sync now"],
  ["Ctrl + ,", "Settings"],
  ["Alt + F", "Menus: File, Edit (Alt + E), View (Alt + V), Go (Alt + G), Help (Alt + H)"],
  ["Ctrl + 1 to 7", "Home, Vault, Codex, Triage, Chase list, Collections, Settings"],
  ["Ctrl + B", "Collapse or expand the sidebar"],
  ["Alt + Left", "Back"],
  ["K / S / L", "Triage: keep, shard or later for the new drop on screen"],
  ["Ctrl + F", "Search (same as Ctrl + K)"],
  ["Esc", "Close search or a menu"],
];

function ShortcutsCard() {
  return (
    <Card id="settings-shortcuts" title="Keyboard shortcuts" wide>
      <dl className="pf-shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}>
            <dt>
              {keys.split(" + ").map((k, i) => (
                <span key={k}>
                  {i > 0 && " + "}
                  <kbd>{k}</kbd>
                </span>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function AboutCard() {
  const { info } = useSession();
  return (
    <Card id="settings-about" title="About" wide>
      {info && (
        <dl className="pf-facts">
          <dt>ParaForge</dt>
          <dd>{info.version}</dd>
          <dt>Core</dt>
          <dd>{info.core_version}</dd>
          <dt>Database schema</dt>
          <dd>{info.schema_version}</dd>
          <dt>Scoring rules</dt>
          <dd>{info.ruleset}</dd>
        </dl>
      )}
      <p className="pf-muted">
        Free and non-commercial. Not made by or affiliated with Bungie. Weapon and perk images come from Bungie.net.
        Font: Nunito (SIL Open Font License). Icons: Lucide (ISC).
      </p>
    </Card>
  );
}
