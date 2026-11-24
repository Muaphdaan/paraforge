// Sections whose data does not exist yet. Each says what it will hold and what comes first.
import { PageId } from "../app/pages";
import { EmptyState } from "../ui/parts";

type Go = (page: PageId) => void;

export function CodexPage() {
  return (
    <EmptyState pose="thinking" title="The Codex is on its way">
      Every weapon in the game, with its best rolls and where to get it, comes with the ParaForge data pack.
    </EmptyState>
  );
}

export function ChasePage({ onNavigate }: { onNavigate: Go }) {
  return (
    <EmptyState
      pose="neutral"
      title="No rolls chased yet"
      action={
        <button type="button" className="pf-btn" onClick={() => onNavigate("vault")}>
          Open Vault
        </button>
      }
    >
      Soon you'll pick a god roll on a weapon's page and press Chase this roll. ParaForge then flags the first drop
      that matches.
    </EmptyState>
  );
}

export function CollectionsPage() {
  return (
    <EmptyState pose="sleepy" title="Collections are coming">
      Your progress by source and set arrives with the ParaForge data pack.
    </EmptyState>
  );
}
