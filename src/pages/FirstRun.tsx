// First run, as in the approved U06 mockup: connect a private Bungie app, sign in, first sync.
import { MutableRefObject, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, CircleCheck, ExternalLink, LoaderCircle } from "lucide-react";
import logo from "../assets/brand/logo.png";
import type { ScoreContext } from "../app/api";
import { useSession } from "../app/session";
import { KeysForm, RedirectUrl, useSignIn } from "../ui/account";
import { Banner, Mascot } from "../ui/parts";

const STEPS = ["Connect", "Sign in", "First sync"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="pf-stepper" aria-label={`Step ${step} of 3`}>
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <li key={label} className="pf-stepper__step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="pf-stepper__dot">{state === "done" ? <Check size={18} strokeWidth={3} aria-hidden="true" /> : n}</span>
            <span className="pf-stepper__label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function FirstRun({ onFinish }: { onFinish: () => void }) {
  const session = useSession();
  const auth = session.auth;
  const [editKeys, setEditKeys] = useState(false);
  // The browser opens on its own once only: not again after Back, nor on React's development re-run.
  const autoSignIn = useRef(false);
  const step = !auth?.has_app_keys || editKeys ? 1 : !auth.signed_in ? 2 : 3;

  return (
    <div className="pf-firstrun">
      <header className="pf-firstrun__brand">
        <img src={logo} alt="" className="pf-firstrun__logo" draggable={false} />
        <div>
          <h1 className="pf-firstrun__name">ParaForge</h1>
          <p className="pf-firstrun__tag">Let's get your vault in.</p>
        </div>
      </header>
      <main className="pf-panel pf-firstrun__card">
        <Stepper step={step} />
        {step === 1 && <ConnectStep onDone={() => setEditKeys(false)} canGoBack={false} />}
        {step === 2 && <SignInStep autoStarted={autoSignIn} onBack={() => setEditKeys(true)} />}
        {step === 3 && <SyncStep onFinish={onFinish} />}
      </main>
    </div>
  );
}

function ConnectStep(props: { onDone: () => void; canGoBack: boolean }) {
  return (
    <section className="pf-stack" aria-labelledby="fr-connect">
      <div>
        <h2 className="pf-firstrun__title" id="fr-connect">
          Connect to Bungie
        </h2>
        <p className="pf-muted">Uses your own private Bungie app. Takes about 3 minutes.</p>
      </div>
      <ol className="pf-howto">
        <li>
          Create an app at{" "}
          <button type="button" className="pf-link" onClick={() => invoke("open_bungie_apps").catch(() => {})}>
            bungie.net/en/Application
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </li>
        <li>
          Set the redirect URL:
          <RedirectUrl />
        </li>
        <li>
          Set OAuth client type to <strong>Confidential</strong> and tick the permissions to read your Destiny 2
          information (vault, inventory and vendors) and to <strong>move or equip Destiny gear</strong> (for the
          Equip buttons).
        </li>
      </ol>
      <KeysForm submitLabel="Save keys" onSaved={props.onDone} />
    </section>
  );
}

function SignInStep({ onBack, autoStarted }: { onBack: () => void; autoStarted: MutableRefObject<boolean> }) {
  const signIn = useSignIn();
  // Open the browser straight away the first time this step shows.
  const start = signIn.start;
  useEffect(() => {
    if (!autoStarted.current) {
      autoStarted.current = true;
      void start();
    }
  }, [autoStarted, start]);

  return (
    <section className="pf-stack pf-firstrun__center" aria-labelledby="fr-signin">
      <div className="pf-firstrun__ring" data-spinning={signIn.waiting || undefined}>
        <Mascot pose="thinking" className="pf-firstrun__mascot" />
      </div>
      <h2 className="pf-firstrun__title" id="fr-signin">
        {signIn.waiting ? "Waiting for Bungie..." : "Sign in with Bungie"}
      </h2>
      <p className="pf-muted">
        {signIn.waiting
          ? "Finish signing in in your browser, then come back here."
          : "Your browser opens Bungie's sign-in page. ParaForge never sees your password."}
      </p>
      {signIn.error && <Banner tone="error">{signIn.error}</Banner>}
      <div className="pf-row">
        <button type="button" className="pf-btn" onClick={onBack}>
          Back
        </button>
        <button type="button" className="pf-btn pf-btn--primary" onClick={signIn.start} disabled={signIn.busy}>
          <ExternalLink size={16} aria-hidden="true" />
          {signIn.waiting ? "Open browser again" : "Sign in with Bungie"}
        </button>
      </div>
    </section>
  );
}

type RowState = "todo" | "active" | "done";

/** Which part of the first sync is running, from the step the Rust side reports. */
function phaseOf(step: string | null): number {
  if (!step) return -1;
  const s = step.toLowerCase();
  if (s.includes("scoring")) return 2;
  if (s.includes("vault") || s.includes("characters")) return 1;
  return 0;
}

const PLAY_STYLES: { label: string; context: ScoreContext }[] = [
  { label: "Raids and dungeons", context: "pve" },
  { label: "Story and patrols", context: "pve" },
  { label: "PvP", context: "pvp" },
];

function SyncStep({ onFinish }: { onFinish: () => void }) {
  const session = useSession();
  const [style, setStyle] = useState<string | null>(null);
  const done = session.syncedAt !== null;
  const running = session.syncStep !== null;

  // Start the first sync as soon as this step shows, unless one is already running (it then counts
  // as this step's sync); a failure waits for Try again.
  const started = useRef(false);
  const sync = session.sync;
  useEffect(() => {
    if (started.current || done) return;
    started.current = true;
    if (!running) void sync();
  }, [done, running, sync]);

  const phase = done ? 3 : phaseOf(session.syncStep);
  const rows: { label: string; detail: string }[] = [
    { label: "Game data", detail: "Bungie's item database" },
    { label: "Your vault", detail: "Every weapon you own" },
    { label: "Scores", detail: "Each weapon judged" },
  ];
  const stateOf = (i: number): RowState => (phase > i ? "done" : phase === i && running ? "active" : "todo");

  return (
    <section className="pf-stack" aria-labelledby="fr-sync">
      <div>
        <h2 className="pf-firstrun__title" id="fr-sync">
          {done ? "Your vault is in" : "Setting up your vault"}
        </h2>
        <p className="pf-muted">
          {done
            ? `${session.info?.copies ?? session.summary?.copies ?? 0} weapons synced and scored.`
            : "The first sync downloads Bungie's item database, so it takes a minute or two."}
        </p>
      </div>
      <ul className="pf-syncsteps" aria-live="polite">
        {rows.map((row, i) => {
          const state = stateOf(i);
          return (
            <li key={row.label} data-state={state}>
              <span className="pf-syncsteps__icon" aria-hidden="true">
                {state === "done" ? (
                  <CircleCheck size={20} />
                ) : state === "active" ? (
                  <LoaderCircle size={20} className="pf-spin" />
                ) : (
                  <span className="pf-syncsteps__dot" />
                )}
              </span>
              <span className="pf-syncsteps__text">
                <strong>{row.label}</strong>
                <span className="pf-muted">{state === "active" ? `${session.syncStep}...` : row.detail}</span>
              </span>
              <span className="pf-syncsteps__bar" aria-hidden="true">
                <span />
              </span>
            </li>
          );
        })}
      </ul>
      {session.syncError && !running && (
        <Banner
          tone="error"
          action={
            <button type="button" className="pf-btn pf-btn--small" onClick={session.sync}>
              Try again
            </button>
          }
        >
          {session.syncError}
        </Banner>
      )}
      <hr className="pf-rule" />
      <div className="pf-stack" style={{ gap: 8 }}>
        <span className="pf-muted">One quick question (optional)</span>
        <strong>What do you play most?</strong>
        <div className="pf-chips" role="group" aria-label="What do you play most?">
          {PLAY_STYLES.map((p) => (
            <button
              key={p.label}
              type="button"
              className="pf-chipbtn"
              aria-pressed={style === p.label}
              onClick={() => {
                setStyle(p.label);
                session.setContext(p.context);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="pf-muted">ParaForge shows PvE or PvP scores first to match. You can switch any time.</span>
      </div>
      <div className="pf-row pf-row--end">
        <button type="button" className="pf-btn pf-btn--primary" onClick={onFinish} disabled={!done}>
          Finish
        </button>
      </div>
    </section>
  );
}
