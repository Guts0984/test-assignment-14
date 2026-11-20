export interface Bar {
  readonly label: string;
  readonly value: number;
}

/** Minimal accessible bar chart: SVG for the eyes, a visually hidden table for screen readers. */
export const BarChart = ({ data, label, format }: { readonly data: readonly Bar[]; readonly label: string; readonly format: (value: number) => string }) => {
  const max = Math.max(1, ...data.map((d) => d.value));
  const width = Math.max(240, data.length * 14);
  return (
    <figure className="overflow-x-auto" data-testid="bar-chart">
      <svg role="img" aria-label={label} viewBox={`0 0 ${width} 120`} width="100%" height="120" preserveAspectRatio="none">
        {data.map((d, i) => (
          <rect key={`${d.label}-${i}`} x={i * 14 + 2} y={110 - (d.value / max) * 100} width={10} height={(d.value / max) * 100} fill="#4f46e5">
            <title>{`${d.label}: ${format(d.value)}`}</title>
          </rect>
        ))}
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.label}-${i}`}>
              <th scope="row">{d.label}</th>
              <td>{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
