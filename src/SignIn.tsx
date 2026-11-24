// Unstyled Bungie sign-in controls for the code track. Keys go to the Rust side once and never come back.
import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type AuthStatus = {
  has_app_keys: boolean;
  signed_in: boolean;
  membership_id: string | null;
  sign_in_expires_at: number | null;
};

export function SignIn({ onStatus }: { onStatus?: (signedIn: boolean) => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    invoke<AuthStatus>("auth_status").then(setStatus, (e) => setMessage(String(e)));
    const unlisten = [
      listen<AuthStatus>("auth-changed", (e) => {
        setStatus(e.payload);
        setWaiting(false);
        setMessage("Signed in.");
      }),
      listen<string>("auth-error", (e) => {
        setWaiting(false);
        setMessage(e.payload);
      }),
    ];
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

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
      setStatus(next);
      setMessage("Keys saved to Windows Credential Manager.");
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function signIn() {
    setBusy(true);
    setMessage("Finish signing in in your browser.");
    try {
      await invoke("start_sign_in");
      setWaiting(true);
    } catch (e) {
      setMessage(String(e));
    } finally {
      // Only disabled while the browser is being opened; clicking again starts a fresh sign-in.
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      setStatus(await invoke<AuthStatus>("sign_out"));
      setMessage("Signed out.");
    } catch (e) {
      setMessage(String(e));
    }
  }

  useEffect(() => {
    onStatus?.(Boolean(status?.signed_in));
  }, [status, onStatus]);

  if (!status) return <p>{message ?? "Checking sign-in..."}</p>;

  return (
    <section>
      <h2>Bungie sign-in</h2>
      {message && <p role="status">{message}</p>}
      {status.signed_in ? (
        <>
          <p>
            Signed in as Bungie.net member {status.membership_id}.
            {status.sign_in_expires_at &&
              ` Sign-in lasts until ${new Date(status.sign_in_expires_at * 1000).toLocaleDateString()}.`}
          </p>
          <button onClick={signOut}>Sign out</button>
        </>
      ) : status.has_app_keys ? (
        <button onClick={signIn} disabled={busy}>
          {waiting ? "Start sign-in again" : "Sign in with Bungie"}
        </button>
      ) : null}
      <details open={!status.has_app_keys}>
        <summary>{status.has_app_keys ? "Replace Bungie app keys" : "Add your Bungie app keys"}</summary>
        <form onSubmit={saveKeys} autoComplete="off">
          <p>
            <label>
              API key <input name="apiKey" required spellCheck={false} />
            </label>
          </p>
          <p>
            <label>
              OAuth client_id <input name="clientId" required inputMode="numeric" />
            </label>
          </p>
          <p>
            <label>
              OAuth client_secret <input name="clientSecret" type="password" required spellCheck={false} />
            </label>
          </p>
          <button type="submit">Save keys</button>
        </form>
      </details>
    </section>
  );
}
