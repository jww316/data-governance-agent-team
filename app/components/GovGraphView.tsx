"use client";

import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  Position,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";
import type { RunEvent, Verdict } from "@/lib/governance";
import {
  buildGraph,
  type GovGraph,
  type GraphNode,
  type RosterEntry,
} from "@/lib/graph";

// Same semantic palette as the rest of the UI (§1 styling / §15.3).
const VERDICT_COLOR: Record<Verdict, string> = {
  PASS: "#1f8a4c",
  BLOCK: "#c0392b",
  ESCALATE: "#b5790b",
};
const NEUTRAL = "#7a8499";
const ACCENT = { border: "#2c5cc5", bg: "#eaf0fb", text: "#1a1f2b" };
// Fixed x per column. Part 2 runs use four extra upstream columns (lib/graph.ts).
const COLUMN_STEP = 256;
const ROW_Y = 96;

type Props =
  | { graph: GovGraph; events?: undefined; roster?: undefined }
  | { graph?: undefined; events: RunEvent[]; roster: RosterEntry[] };

export function GovGraphView(props: Props) {
  const graph = useMemo<GovGraph>(
    () =>
      props.graph
        ? props.graph
        : buildGraph({ events: props.events, roster: props.roster }),
    [props.graph, props.events, props.roster]
  );

  const { nodes, edges } = useMemo(
    () => toReactFlow(graph),
    [graph]
  );

  if (graph.nodes.length === 0) return null;
  const wide = graph.nodes.some((n) => n.kind === "event");
  // Remount when the outcome changes. During a live run the outcome node exists
  // before the verdict arrives, and an in-place label update was not always
  // repainted. A fresh mount also re-fits the finished path.
  const outcomeKey = graph.nodes.find((n) => n.kind === "outcome")?.label ?? "";

  return (
    <div className={`gov-graph${wide ? " wide" : ""}`}>
      <ReactFlow
        key={outcomeKey}
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={1.5}
      >
        <Background color="#e2e6ec" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function nodeColor(n: GraphNode): { border: string; bg: string; text: string } {
  // Part 2 nodes: the accent means "established state". A resolver that could
  // not establish state takes the escalate or block color.
  if (n.kind === "resolver") {
    if (n.status === "unresolved") return { border: VERDICT_COLOR.ESCALATE, bg: tint("ESCALATE"), text: "#1a1f2b" };
    if (n.status === "conflicted" || n.status === "failed") return { border: VERDICT_COLOR.BLOCK, bg: tint("BLOCK"), text: "#1a1f2b" };
    return ACCENT;
  }
  if (n.kind === "event" || (n.kind === "delta" && n.status === "changed") || n.status === "material") {
    return ACCENT;
  }
  if (n.kind === "delta" && n.status !== "unchanged" && n.status !== "changed") {
    return { border: VERDICT_COLOR.ESCALATE, bg: tint("ESCALATE"), text: "#1a1f2b" };
  }
  if (n.kind === "delta" || n.kind === "materiality") {
    return { border: "#cdd4de", bg: "#f7f8fa", text: "#4a5365" };
  }
  if (n.kind === "agent" && !n.active) {
    return { border: "#cdd4de", bg: "#f1f3f6", text: "#9aa3b2" };
  }
  if (n.verdict) {
    return {
      border: VERDICT_COLOR[n.verdict],
      bg: tint(n.verdict),
      text: "#1a1f2b",
    };
  }
  return { border: "#cdd4de", bg: "#ffffff", text: "#1a1f2b" };
}

function tint(v: Verdict): string {
  return v === "PASS" ? "#e6f4ec" : v === "BLOCK" ? "#fbeae8" : "#fbf2dd";
}

function toReactFlow(graph: GovGraph): { nodes: Node[]; edges: Edge[] } {
  // Deterministic columnar layout: fixed x per column, y distributed by the
  // node's order within its column (§15.5). No physics/force layout.
  const perColumnCount: Record<number, number> = {};
  const columnTotals: Record<number, number> = {};
  for (const n of graph.nodes) columnTotals[n.column] = (columnTotals[n.column] ?? 0) + 1;
  const maxRows = Math.max(1, ...Object.values(columnTotals));
  const canvasH = maxRows * ROW_Y;

  const nodes: Node[] = graph.nodes.map((n) => {
    const idx = perColumnCount[n.column] ?? 0;
    perColumnCount[n.column] = idx + 1;
    const count = columnTotals[n.column];
    // Vertically center each column's nodes within the canvas.
    const colStart = (canvasH - count * ROW_Y) / 2;
    const y = colStart + idx * ROW_Y;
    const c = nodeColor(n);
    const dashed = n.kind === "agent" && !n.active;

    return {
      id: n.id,
      position: { x: n.column * COLUMN_STEP, y },
      data: {
        label: (
          <div style={{ textAlign: "center", lineHeight: 1.25 }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{n.label}</div>
            {n.sublabel && (
              <div style={{ fontSize: 10, color: "#7a8499", marginTop: 2 }}>
                {n.sublabel}
              </div>
            )}
          </div>
        ),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      connectable: false,
      selectable: false,
      style: {
        width: 180,
        padding: "8px 10px",
        borderRadius: 8,
        border: `${dashed ? "1.5px dashed" : "1.5px solid"} ${c.border}`,
        background: c.bg,
        color: c.text,
        fontSize: 12,
        boxShadow: "0 1px 2px rgba(20,28,45,0.06)",
      },
    };
  });

  const edges: Edge[] = graph.edges.map((e) => {
    const color = e.verdict ? VERDICT_COLOR[e.verdict] : NEUTRAL;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: Boolean(e.emphasized),
      style: {
        stroke: color,
        strokeWidth: e.emphasized ? 3 : 1.5,
        opacity: e.verdict ? 1 : 0.6,
      },
      labelStyle: { fontSize: 10, fill: "#4a5365", fontWeight: 600 },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
      labelBgPadding: [4, 2] as [number, number],
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  });

  return { nodes, edges };
}
