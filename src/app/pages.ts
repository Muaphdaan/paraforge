import { BookOpen, SquareCheckBig, Home, Layers, LucideIcon, Archive, Settings } from "lucide-react";

export type PageId = "home" | "vault" | "codex" | "chase" | "collections" | "settings" | "weapon";

export type PageDef = {
  id: PageId;
  label: string;
  icon: LucideIcon;
  /** Breadcrumb group; the Home page has none. */
  group: string | null;
  title: string;
  subtitle: string;
};

// Titles and subtitles as in the approved mockups.
export const PAGES: Record<PageId, PageDef> = {
  home: {
    id: "home",
    label: "Home",
    icon: Home,
    group: null,
    title: "Welcome back, Guardian",
    subtitle: "Here's what changed since your last session.",
  },
  vault: {
    id: "vault",
    label: "Vault",
    icon: Archive,
    group: "Armoury",
    title: "Vault",
    subtitle: "Every weapon you own, scored and sorted.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    icon: BookOpen,
    group: "Armoury",
    title: "Codex",
    subtitle: "Every weapon in the game and its best rolls.",
  },
  chase: {
    id: "chase",
    label: "Chase list",
    icon: SquareCheckBig,
    group: "Progress",
    title: "Chase list",
    subtitle: "The rolls you're hunting, best first.",
  },
  collections: {
    id: "collections",
    label: "Collections",
    icon: Layers,
    group: "Progress",
    title: "Collections",
    subtitle: "How close you are to owning it all.",
  },
  // Not in the sidebar: opened from the Vault. The header shows the weapon's own name.
  weapon: {
    id: "weapon",
    label: "Vault",
    icon: Archive,
    group: "Armoury",
    title: "Weapon",
    subtitle: "",
  },
  settings: {
    id: "settings",
    label: "Settings",
    icon: Settings,
    group: "Settings",
    title: "Settings",
    subtitle: "Your account, sync and how ParaForge scores.",
  },
};

export const NAV_GROUPS: { label: string; pages: PageId[] }[] = [
  { label: "Overview", pages: ["home"] },
  { label: "Armoury", pages: ["vault", "codex"] },
  { label: "Progress", pages: ["chase", "collections"] },
];

/** Ctrl+1 to Ctrl+6 jump to these, in sidebar order. */
export const PAGE_ORDER: PageId[] = ["home", "vault", "codex", "chase", "collections", "settings"];
