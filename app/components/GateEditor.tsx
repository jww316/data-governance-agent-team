"use client";

import { useMemo, useState } from "react";
import type { Column, GovernanceView } from "@/lib/governance";
import type { EditOp } from "@/lib/adapters";
import { useRun } from "./useRun";
import { RunView } from "./RunView";

interface Preset {
  label: string;
  table: string;
  edit: EditOp;
}

const PRESETS: Preset[] = [
  {
    label: "Add national_id (undeclared PII)",
    table: "customers",
    edit: {
      op: "add",
      column: {
        name: "national_id",
        type: "text",
        nullable: false,
        pii: false,
        notes: "Imported from a vendor feed.",
      },
    },
  },
  {
    label: "Add preferred_language (benign)",
    table: "customers",
    edit: {
      op: "add",
      column: {
        name: "preferred_language",
        type: "text",
        nullable: true,
        pii: false,
        notes: "UI locale preference, e.g. en-US. Not an identifier.",
      },
    },
  },
  {
    label: "Drop NOT NULL on order_total",
    table: "orders",
    edit: {
      op: "alter",
      column: { name: "order_total", type: "numeric", nullable: true },
    },
  },
  {
    label: "Remove customer_id (breaks lineage)",
    table: "orders",
    edit: { op: "remove", columnName: "customer_id" },
  },
];

export function GateEditor({
  view,
  onComplete,
}: {
  view: GovernanceView;
  onComplete: () => void;
}) {
  const [tableName, setTableName] = useState(view.tables[0]?.name ?? "");
  const [edits, setEdits] = useState<EditOp[]>([]);
  const run = useRun(onComplete);

  const table = view.tables.find((t) => t.name === tableName)!;

  // Reset edits when switching tables.
  const switchTable = (name: string) => {
    setTableName(name);
    setEdits([]);
  };

  const removedNames = useMemo(
    () =>
      new Set(
        edits.filter((e) => e.op === "remove").map((e) => (e as any).columnName)
      ),
    [edits]
  );
  const alteredByName = useMemo(() => {
    const m = new Map<string, Column>();
    for (const e of edits) if (e.op === "alter") m.set(e.column.name, e.column);
    return m;
  }, [edits]);
  const added = useMemo(
    () => edits.filter((e) => e.op === "add").map((e) => (e as any).column as Column),
    [edits]
  );

  const addEdit = (e: EditOp) => setEdits((prev) => [...prev, e]);
  const undo = (idx: number) =>
    setEdits((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div>
      <p className="feature-intro">
        The synchronous gate evaluates changes that flow through git. Edit a
        governed table below — add, alter, or remove a column — then commit. The
        change is diffed against the baseline, routed to the applicable agents, and
        a real pull request is opened on the throwaway repo with the team’s verdict.
      </p>

      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor="table">Governed table</label>
        <select
          id="table"
          value={tableName}
          onChange={(e) => switchTable(e.target.value)}
        >
          {view.tables.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <table className="schema-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>PII</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c) => {
            const removed = removedNames.has(c.name);
            const altered = alteredByName.get(c.name);
            const effective = { ...c, ...(altered ?? {}) };
            return (
              <tr key={c.name} className={removed ? "removed" : altered ? "" : ""}>
                <td>
                  {c.name}
                  {altered && <em style={{ color: "var(--escalate)" }}> (altered)</em>}
                </td>
                <td>{effective.type}</td>
                <td>{effective.nullable ? "yes" : "no"}</td>
                <td>{effective.pii ? <span className="pii-tag">PII</span> : "—"}</td>
                <td className="col-actions">
                  {!removed && (
                    <button
                      title="Remove column"
                      onClick={() => addEdit({ op: "remove", columnName: c.name })}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {added.map((c) => (
            <tr key={`add-${c.name}`} className="added">
              <td>
                {c.name} <em style={{ color: "var(--pass)" }}>(new)</em>
              </td>
              <td>{c.type}</td>
              <td>{c.nullable ? "yes" : "no"}</td>
              <td>{c.pii ? <span className="pii-tag">PII</span> : "—"}</td>
              <td className="col-actions">
                <button
                  title="Undo"
                  onClick={() =>
                    setEdits((prev) =>
                      prev.filter(
                        (e) => !(e.op === "add" && e.column.name === c.name)
                      )
                    )
                  }
                >
                  ↩
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <AddColumnForm onAdd={(col) => addEdit({ op: "add", column: col })} />

      <div className="section-label" style={{ marginTop: "1.25rem" }}>
        Quick edits for this table
      </div>
      <div className="preset-row">
        {PRESETS.filter((p) => p.table === tableName).map((p) => (
          <button key={p.label} onClick={() => addEdit(p.edit)}>
            {p.label}
          </button>
        ))}
      </div>

      {edits.length > 0 && (
        <div className="preset-row">
          <strong style={{ fontSize: "0.8rem", alignSelf: "center" }}>
            {edits.length} pending edit{edits.length > 1 ? "s" : ""}:
          </strong>
          {edits.map((e, i) => (
            <button key={i} onClick={() => undo(i)} title="Remove this edit">
              {describeEdit(e)} ✕
            </button>
          ))}
        </div>
      )}

      <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem" }}>
        <button
          className="btn"
          disabled={run.running || edits.length === 0}
          onClick={() => run.run("/api/gate", { table: tableName, edits })}
        >
          {run.running ? "Evaluating…" : "Commit change"}
        </button>
        {edits.length > 0 && (
          <button
            className="btn secondary"
            disabled={run.running}
            onClick={() => setEdits([])}
          >
            Reset
          </button>
        )}
      </div>

      <RunView
        state={run}
        roster={view.agents.map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}

function describeEdit(e: EditOp): string {
  if (e.op === "add") return `+${e.column.name}`;
  if (e.op === "alter") return `~${e.column.name}`;
  return `-${e.columnName}`;
}

function AddColumnForm({ onAdd }: { onAdd: (col: Column) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [pii, setPii] = useState(false);
  const [nullable, setNullable] = useState(true);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd({ name: trimmed, type, nullable, pii });
    setName("");
    setPii(false);
    setNullable(true);
  };

  return (
    <div className="add-col-form">
      <div className="field">
        <label>New column name</label>
        <input
          type="text"
          value={name}
          placeholder="e.g. passport_number"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <div className="field">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="text">text</option>
          <option value="numeric">numeric</option>
          <option value="boolean">boolean</option>
          <option value="uuid">uuid</option>
          <option value="timestamptz">timestamptz</option>
        </select>
      </div>
      <label
        style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem" }}
      >
        <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} />
        nullable
      </label>
      <label
        style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem" }}
      >
        <input type="checkbox" checked={pii} onChange={(e) => setPii(e.target.checked)} />
        declared PII
      </label>
      <button className="btn secondary" onClick={submit}>
        Add column
      </button>
    </div>
  );
}
