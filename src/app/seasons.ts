// Destiny 2 seasons by Bungie's season number, from d2-additional-info (MIT). Used to show and
// filter when a weapon came out.
export const SEASONS: Record<number, { name: string; year: number }> = {
  1: { name: "Red War", year: 2017 },
  2: { name: "Curse of Osiris", year: 2017 },
  3: { name: "Warmind", year: 2018 },
  4: { name: "Season of the Outlaw", year: 2018 },
  5: { name: "Season of the Forge", year: 2018 },
  6: { name: "Season of the Drifter", year: 2019 },
  7: { name: "Season of Opulence", year: 2019 },
  8: { name: "Season of the Undying", year: 2019 },
  9: { name: "Season of Dawn", year: 2019 },
  10: { name: "Season of the Worthy", year: 2020 },
  11: { name: "Season of Arrivals", year: 2020 },
  12: { name: "Season of the Hunt", year: 2020 },
  13: { name: "Season of the Chosen", year: 2021 },
  14: { name: "Season of the Splicer", year: 2021 },
  15: { name: "Season of the Lost", year: 2021 },
  16: { name: "Season of the Risen", year: 2022 },
  17: { name: "Season of the Haunted", year: 2022 },
  18: { name: "Season of Plunder", year: 2022 },
  19: { name: "Season of the Seraph", year: 2022 },
  20: { name: "Season of Defiance", year: 2023 },
  21: { name: "Season of the Deep", year: 2023 },
  22: { name: "Season of the Witch", year: 2023 },
  23: { name: "Season of the Wish", year: 2023 },
  24: { name: "Episode: Echoes", year: 2024 },
  25: { name: "Episode: Revenant", year: 2024 },
  26: { name: "Episode: Heresy", year: 2025 },
  27: { name: "Reclamation", year: 2025 },
  28: { name: "Lawless", year: 2025 },
};

/** "Season 21: Season of the Deep", or "" when unknown. */
export function seasonLabel(season: number | undefined): string {
  if (!season) return "";
  const s = SEASONS[season];
  return s ? `Season ${season}: ${s.name}` : `Season ${season}`;
}
