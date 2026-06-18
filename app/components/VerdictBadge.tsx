import type { Verdict } from "@/lib/governance";

const ICON: Record<Verdict, string> = {
  PASS: "✓",
  BLOCK: "✕",
  ESCALATE: "▲",
};

export function VerdictBadge({
  verdict,
  big,
}: {
  verdict: Verdict;
  big?: boolean;
}) {
  return (
    <span className={`verdict-badge ${verdict}${big ? " big" : ""}`}>
      <span aria-hidden>{ICON[verdict]}</span>
      {verdict}
    </span>
  );
}
