import { useEffect, useState } from "react";

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function timeAgo(unixSeconds: number, now: number): string {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** The current time, refreshed every 30 seconds so "min ago" labels stay right. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
