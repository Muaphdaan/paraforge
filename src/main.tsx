import React from "react";
import ReactDOM from "react-dom/client";
// Nunito is bundled with the app (SIL Open Font License), never loaded from the web.
import "@fontsource-variable/nunito";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/vault.css";
import "./styles/pages.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
