interface Props {
  header: string[];
  rows: string[][];
}

export function PreviewTable({ header, rows }: Props) {
  if (rows.length === 0) return null;
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>データプレビュー</h3>
          <p className="section-hint">先頭 {rows.length} 行を表示しています。</p>
        </div>
      </div>
      <div className="table-wrap" style={{ border: 'none', maxHeight: 480, overflow: 'auto' }}>
        <table className="zebra">
          <thead>
            <tr>
              <th className="sticky-col">#</th>
              {header.map((name, i) => (
                <th key={`${name}-${i}`}>{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <td className="sticky-col" style={{ color: 'var(--faint)' }}>
                  {r + 1}
                </td>
                {header.map((_, c) => (
                  <td key={c} title={row[c]}>
                    {row[c]?.length > 60 ? `${row[c].slice(0, 60)}…` : row[c]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
