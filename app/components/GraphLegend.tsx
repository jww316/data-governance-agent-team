/** Small legend so the graph's color/encoding is self-explanatory on a recording. */
export function GraphLegend({ stateResolution = false }: { stateResolution?: boolean }) {
  return (
    <div className="graph-legend">
      {stateResolution && (
        <>
          <span className="lg lg-resolved">resolved state</span>
          <span className="lg lg-changed">changed</span>
        </>
      )}
      <span className="lg lg-pass">PASS</span>
      <span className="lg lg-block">BLOCK</span>
      <span className="lg lg-escalate">ESCALATE</span>
      <span className="lg lg-gray">un-invoked</span>
    </div>
  );
}
