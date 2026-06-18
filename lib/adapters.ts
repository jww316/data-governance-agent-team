/**
 * adapters.ts — turn each feature's input into the shared `Change` shape so the
 * orchestrator stays feature-agnostic (IMPLEMENTATION.md §4, §7).
 */

import { Change, Column, Scenario, Table } from "./governance";
import { GeneratedData, OutputFormat, generateRecords } from "./generator";

// --- Feature 2: monitor (file landing) --------------------------------------

export interface MonitorChange {
  change: Change;
  generated: GeneratedData;
  format: OutputFormat;
}

export function buildMonitorChange(
  scenario: Scenario,
  format: OutputFormat = "json",
  count = 10
): MonitorChange {
  const generated = generateRecords(scenario, count);
  const sa = scenario.state_attributes;

  const change: Change = {
    source: "monitor",
    asset: { scenarioId: scenario.id, domain: sa.domain },
    state_attributes: sa,
    records: generated.records,
    fieldMeta: generated.fieldMeta,
    declared: {
      contains_pii:
        sa.declared_contains_pii !== undefined
          ? sa.declared_contains_pii
          : sa.contains_pii,
    },
  };

  return { change, generated, format };
}

// --- Feature 1: gate (PR evaluation) ----------------------------------------

export type EditOp =
  | { op: "add"; column: Column }
  | { op: "alter"; column: Column }
  | { op: "remove"; columnName: string };

/**
 * Build a gate Change by applying proposed edits to a baseline table. Returns
 * the structured diff plus the would-be next column set (used to write the PR).
 */
export function buildGateChange(
  tableName: string,
  table: Table,
  edits: EditOp[]
): { change: Change; nextColumns: Column[] } {
  const added: Column[] = [];
  const altered: Column[] = [];
  const removed: Column[] = [];

  // Start from the baseline columns and apply edits to derive the next state.
  let nextColumns: Column[] = table.columns.map((c) => ({ ...c }));

  for (const edit of edits) {
    if (edit.op === "add") {
      added.push(edit.column);
      nextColumns.push(edit.column);
    } else if (edit.op === "alter") {
      altered.push(edit.column);
      nextColumns = nextColumns.map((c) =>
        c.name === edit.column.name ? { ...c, ...edit.column } : c
      );
    } else if (edit.op === "remove") {
      const target = table.columns.find((c) => c.name === edit.columnName);
      if (target) removed.push(target);
      nextColumns = nextColumns.filter((c) => c.name !== edit.columnName);
    }
  }

  // Declared PII: does the change itself claim to introduce PII?
  const declaredPii =
    added.some((c) => c.pii === true || c.declared_pii === true) ||
    altered.some((c) => c.pii === true || c.declared_pii === true);

  const change: Change = {
    source: "gate",
    asset: { table: tableName, domain: table.state_attributes.domain },
    state_attributes: table.state_attributes,
    diff: { added, altered, removed },
    declared: { contains_pii: declaredPii },
  };

  return { change, nextColumns };
}
