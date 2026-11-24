// Placeholder screen for the code track. No visual styling until the design spec is locked.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SignIn } from "./SignIn";

type AppInfo = {
  version: string;
  core_version: string;
  schema_version: number;
  ruleset: string;
};

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_info").then(setInfo, (e) => setError(String(e)));
  }, []);

  return (
    <main>
      <h1>ParaForge</h1>
      <p>Development build. The real interface comes after the design spec is approved.</p>
      {error && <p role="alert">Error: {error}</p>}
      {info && (
        <dl>
          <dt>App</dt>
          <dd>{info.version}</dd>
          <dt>Core</dt>
          <dd>{info.core_version}</dd>
          <dt>Database schema</dt>
          <dd>{info.schema_version}</dd>
          <dt>Scoring rules</dt>
          <dd>{info.ruleset}</dd>
        </dl>
      )}
      <SignIn />
    </main>
  );
}

export default App;
