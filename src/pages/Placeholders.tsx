// Sections whose data does not exist yet. Each says what it will hold and what comes first.
import { PageId } from "../app/pages";
import { useSession } from "../app/session";
import { EmptyState } from "../ui/parts";

type Go = (page: PageId) => void;

export function HomePage({ onNavigate }: { onNavigate: Go }) {
  const session = useSession();
  if (session.syncStep) {
    return (
      <EmptyState pose="thinking" title="Syncing your vault">
        {session.syncStep}...
      </EmptyState>
    );
  }
  if (!session.auth?.signed_in) {
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
  if (!session.syncedAt) {
    return (
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
  return (
    <EmptyState
      pose="happy"
      title="Your vault is synced"
      action={
        <button type="button" className="pf-btn" onClick={() => onNavigate("vault")}>
          Open Vault
        </button>
      }
    >
      {session.summary ? `${session.summary.copies} weapons scored. ` : ""}Your summary of new drops and chase-list
      hits arrives here in a later build.
    </EmptyState>
  );
}

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
