/**
 * audit.ts — append + read the auditable trail (IMPLEMENTATION.md §11).
 *
 * Persisted to data/audit-log.json (gitignored). This local JSON store keeps the
 * repo zero-setup; it is the "auditable trail" credibility point of the demo.
 */

import fs from "node:fs";
import path from "node:path";
import {
  AgentResult,
  StewardAssignment,
  Verdict,
} from "./governance";
import { GovGraph } from "./graph";

const DATA_DIR = path.join(process.cwd(), "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.json");

export interface AuditEntry {
  id: string;
  timestamp: string;
  source: "gate" | "monitor";
  asset: { table?: string; scenarioId?: string; domain: string };
  summary: string;
  agentResults: AgentResult[];
  teamVerdict: Verdict;
  stewards?: StewardAssignment;
  github?: { prUrl?: string; prState?: string; skipped?: boolean };
  /** The relationship graph built from this run's events, for replay (§15.4). */
  graph?: GovGraph;
}

function ensureStore(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, "[]\n", "utf8");
}

/** Read the full audit log (newest first). */
export function readAudit(): AuditEntry[] {
  ensureStore();
  try {
    const raw = fs.readFileSync(AUDIT_FILE, "utf8");
    const entries = JSON.parse(raw) as AuditEntry[];
    return entries.slice().reverse();
  } catch {
    return [];
  }
}

/** Append an entry and return it (with id + timestamp filled in). */
export function appendAudit(
  entry: Omit<AuditEntry, "id" | "timestamp">
): AuditEntry {
  ensureStore();
  const raw = fs.readFileSync(AUDIT_FILE, "utf8");
  const entries = JSON.parse(raw) as AuditEntry[];

  const full: AuditEntry = {
    ...entry,
    id: makeId(),
    timestamp: new Date().toISOString(),
  };
  entries.push(full);
  fs.writeFileSync(AUDIT_FILE, JSON.stringify(entries, null, 2) + "\n", "utf8");
  return full;
}

function makeId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36);
  return `aud_${t}_${rand}`;
}
