// Settings: Bungie account, app keys, sync and About. Phase 3 brings the full approved layout.
// Keys go to the Rust side once and never come back to the interface.
import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, LogIn, LogOut, RefreshCw } from "lucide-react";
import type { AuthStatus } from "../app/api";
import { useSession } from "../app/session";
import { timeAgo, useNow } from "../app/time";
import { Banner, Dropdown } from "../ui/parts";

export function SettingsPage() {
  return (
    <div className="pf-settings">
      <AccountCard />
      <KeysCard />
      <SyncCard />
      <AboutCard />
    </div>
  );
}

function AccountCard() {
  const session = useSession();
  const auth = session.auth;
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setMessage(null);
    session.clearAuthError();
    try {
      await invoke("start_sign_in");
      setWaiting(true);
    } catch (e) {
      setMessage(String(e));
    } finally {
      // Disabled only while the browser opens; pressing again starts a fresh sign-in.
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      session.setAuth(await invoke<AuthStatus>("sign_out"));
      setWaiting(false);
      setMessage(null);
    } catch (e) {
      setMessage(String(e));
    }
  }

  // A sign-in in progress ends when the status changes or Bungie reports an error.
  useEffect(() => setWaiting(false), [auth, session.authError]);

  const signedIn = Boolean(auth?.signed_in);
  return (
    <section className="pf-panel pf-stack" aria-labelledby="settings-account">
      <h2 className="pf-panel__title" id="settings-account">
        Bungie account
      </h2>
      {!auth ? (
        <p className="pf-muted">Checking your sign-in...</p>
      ) : signedIn ? (
        <>
          <p>
            Signed in as Bungie.net member <span data-selectable>{auth.membership_id}</span>.
          </p>
          {auth.sign_in_expires_at && (
            <p className="pf-muted">
              You stay signed in while you use ParaForge, until about{" "}
              {new Date(auth.sign_in_expires_at * 1000).toLocaleDateString()}.
            </p>
          )}
          <div className="pf-row">
            <button type="button" className="pf-btn pf-btn--danger" onClick={signOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </>
      ) : auth.has_app_keys ? (
        <>
          <p className="pf-muted">
            {waiting
              ? "Finish signing in in your browser. ParaForge picks it up by itself."
              : "Sign in with Bungie in your browser. ParaForge never sees your password."}
          </p>
          <div className="pf-row">
            <button type="button" className="pf-btn pf-btn--primary" onClick={signIn} disabled={busy}>
              <LogIn size={16} aria-hidden="true" />
              {waiting ? "Start sign-in again" : "Sign in with Bungie"}
            </button>
          </div>
        </>
      ) : (
        <p className="pf-muted">Add your Bungie app keys first, then sign in here.</p>
      )}
      {message && <Banner tone="error">{message}</Banner>}
    </section>
  );
}

function KeysCard() {
  const session = useSession();
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const hasKeys = Boolean(session.auth?.has_app_keys);

  async function saveKeys(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const next = await invoke<AuthStatus>("save_app_keys", {
        apiKey: String(form.get("apiKey") ?? ""),
        clientId: String(form.get("clientId") ?? ""),
        clientSecret: String(form.get("clientSecret") ?? ""),
      });
      formElement.reset();
      session.setAuth(next);
      setMessage({ tone: "info", text: "Keys saved to Windows Credential Manager." });
    } catch (e) {
      setMessage({ tone: "error", text: String(e) });
    }
  }

  const form = (
    <form className="pf-form" onSubmit={saveKeys} autoComplete="off">
      <label className="pf-field">
        <span className="pf-field__label">API key</span>
        <input className="pf-input" name="apiKey" required spellCheck={false} />
      </label>
      <label className="pf-field">
        <span className="pf-field__label">Client ID</span>
        <input className="pf-input" name="clientId" required inputMode="numeric" spellCheck={false} />
      </label>
      <label className="pf-field">
        <span className="pf-field__label">Client secret</span>
        <input className="pf-input" name="clientSecret" type="password" required spellCheck={false} />
      </label>
      <div className="pf-row">
        <button type="submit" className="pf-btn pf-btn--primary">
          <KeyRound size={16} aria-hidden="true" />
          Save keys
        </button>
      </div>
    </form>
  );

  return (
    <section className="pf-panel pf-stack" aria-labelledby="settings-keys">
      <h2 className="pf-panel__title" id="settings-keys">
        App keys
      </h2>
      <p className="pf-muted">
        Your private Bungie app. The keys stay in Windows Credential Manager, never in a file. Its redirect URL is{" "}
        <span data-selectable>paraforge://auth</span>.
      </p>
      {/* One stable element, so saving the first keys does not remount the form under the cursor. */}
      <details className="pf-disclosure" open={!hasKeys || undefined}>
        <summary>{hasKeys ? "Replace keys" : "Add your keys"}</summary>
        {form}
      </details>
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
    </section>
  );
}

const AUTO_SYNC_OPTIONS = [
  { value: "0", label: "Auto sync off" },
  { value: "5", label: "Every 5 minutes" },
  { value: "15", label: "Every 15 minutes" },
  { value: "30", label: "Every 30 minutes" },
  { value: "60", label: "Every hour" },
];

function SyncCard() {
  const session = useSession();
  const now = useNow();
  const summary = session.summary;
  const syncing = session.syncStep !== null;
  return (
    <section className="pf-panel pf-stack" aria-labelledby="settings-sync">
      <h2 className="pf-panel__title" id="settings-sync">
        Sync
      </h2>
      <p className="pf-muted">
        {syncing
          ? `${session.syncStep}...`
          : session.syncedAt
            ? `Last sync ${timeAgo(session.syncedAt, now)}${summary ? ` · ${summary.copies} weapons` : ""}`
            : "Not synced yet."}
      </p>
      {summary && !syncing && (
        <p className="pf-muted">
          Bungie item database {summary.manifest_version}, {summary.weapons_known} weapons known.
          {summary.unreadable > 0 && ` ${summary.unreadable} weapons had no perk data.`}
          {summary.characters_hidden && " Bungie hid your characters' inventories; check your privacy settings."}
          {summary.not_scored > 0 && ` ${summary.not_scored} could not be scored.`}
        </p>
      )}
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
        <Dropdown
          label="Auto sync"
          value={String(session.autoSync)}
          options={AUTO_SYNC_OPTIONS}
          onChange={(v) => session.setAutoSync(Number(v))}
        />
      </div>
      <p className="pf-muted">
        {session.autoSync > 0
          ? "ParaForge also syncs when it starts and on this schedule while it is open."
          : "Auto sync is off. Use Sync now to refresh your vault."}
      </p>
    </section>
  );
}

function AboutCard() {
  const { info } = useSession();
  return (
    <section className="pf-panel pf-stack" aria-labelledby="settings-about">
      <h2 className="pf-panel__title" id="settings-about">
        About
      </h2>
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
        Free and non-commercial. Not made by or affiliated with Bungie. Font: Nunito (SIL Open Font License). Icons:
        Lucide (ISC).
      </p>
    </section>
  );
}
