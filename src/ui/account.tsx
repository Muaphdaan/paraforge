// Bungie app keys and sign-in, shared by the first-run steps and Settings.
// Keys go to the Rust side once and never come back to the interface.
import { FormEvent, ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Lock } from "lucide-react";
import type { AuthStatus } from "../app/api";
import { useSession } from "../app/session";
import { Banner, CopyField } from "./parts";

export const REDIRECT_URL = "paraforge://auth";
export const BUNGIE_APPS_URL = "https://www.bungie.net/en/Application";

function SecretInput(props: { name: string; label: string; numeric?: boolean; secret?: boolean }) {
  const [shown, setShown] = useState(!props.secret);
  return (
    <label className="pf-field">
      <span className="pf-field__label">{props.label}</span>
      <span className="pf-secret">
        <input
          className="pf-input"
          name={props.name}
          type={shown ? "text" : "password"}
          required
          spellCheck={false}
          autoComplete="off"
          inputMode={props.numeric ? "numeric" : undefined}
        />
        {props.secret && (
          <button
            type="button"
            className="pf-secret__eye"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? `Hide ${props.label}` : `Show ${props.label}`}
            aria-pressed={shown}
          >
            {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        )}
      </span>
    </label>
  );
}

/** The three Bungie app keys. Saving checks their format and stores them in Windows Credential Manager. */
export function KeysForm(props: { submitLabel: string; onSaved?: () => void; footer?: ReactNode }) {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    setError(null);
    try {
      const next = await invoke<AuthStatus>("save_app_keys", {
        apiKey: String(form.get("apiKey") ?? ""),
        clientId: String(form.get("clientId") ?? ""),
        clientSecret: String(form.get("clientSecret") ?? ""),
      });
      formElement.reset();
      session.setAuth(next);
      props.onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="pf-form" onSubmit={save} autoComplete="off">
      <SecretInput name="apiKey" label="API key" secret />
      <SecretInput name="clientId" label="Client ID" numeric />
      <SecretInput name="clientSecret" label="Client secret" secret />
      <p className="pf-muted pf-lockline">
        <Lock size={14} aria-hidden="true" />
        Your keys stay in Windows Credential Manager, never in a file.
      </p>
      {error && <Banner tone="error">{error}</Banner>}
      <div className="pf-row pf-row--end">
        {props.footer}
        <button type="submit" className="pf-btn pf-btn--primary" disabled={saving}>
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

export function RedirectUrl() {
  return <CopyField label="Redirect URL" value={REDIRECT_URL} />;
}

/**
 * Starts a Bungie sign-in in the browser. `waiting` stays true until the sign-in finishes,
 * fails, or the status changes.
 */
export function useSignIn() {
  const session = useSession();
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setWaiting(false), [session.auth, session.authError]);

  async function start() {
    setBusy(true);
    setError(null);
    session.clearAuthError();
    try {
      await invoke("start_sign_in");
      setWaiting(true);
    } catch (e) {
      setError(String(e));
    } finally {
      // Disabled only while the browser opens; pressing again starts a fresh sign-in.
      setBusy(false);
    }
  }

  return { start, waiting, busy, error: error ?? session.authError, cancel: () => setWaiting(false) };
}

export async function signOut(setAuth: (a: AuthStatus) => void): Promise<string | null> {
  try {
    setAuth(await invoke<AuthStatus>("sign_out"));
    return null;
  } catch (e) {
    return String(e);
  }
}
