import type { ColumnKind, ColumnRole, ColumnSpec, NumericTransform } from '../../core/types.ts';
import { isNumericKind } from '../../core/infer.ts';

interface Props {
  specs: ColumnSpec[];
  onChange: (index: number, patch: Partial<ColumnSpec>) => void;
  onBulk: (specs: ColumnSpec[]) => void;
  disabled: boolean;
}

const KIND_LABEL: Record<ColumnKind, string> = {
  numeric: '数値',
  categorical: 'カテゴリ',
  boolean: '2値',
  datetime: '日付',
  text: '自由記述',
  identifier: 'ID',
  constant: '定数',
  empty: '空',
};

const ROLE_LABEL: Record<ColumnRole, string> = {
  feature: '特徴量',
  profile: '解釈のみ',
  ignore: '使わない',
};

const TRANSFORM_LABEL: Record<NumericTransform, string> = {
  auto: '自動',
  standard: '標準化',
  robust: 'ロバスト',
  log: '対数',
  quantile: '分位点',
  minmax: '0-1',
};

/** ユーザーが選べる型（推定を上書きできる範囲） */
const SELECTABLE_KINDS: ColumnKind[] = [
  'numeric',
  'categorical',
  'boolean',
  'datetime',
  'identifier',
  'text',
];

/** 特徴量にできない型 */
const NON_FEATURE_KINDS: ColumnKind[] = ['text', 'identifier', 'constant', 'empty'];

/** 推定結果が選択肢にない型（定数・空）でも、現状を正しく表示できるようにする */
function optionsFor(kind: ColumnKind): ColumnKind[] {
  return SELECTABLE_KINDS.includes(kind) ? SELECTABLE_KINDS : [kind, ...SELECTABLE_KINDS];
}

export function ColumnTable({ specs, onChange, onBulk, disabled }: Props) {
  const featureCount = specs.filter((s) => s.role === 'feature').length;

  const setAll = (role: ColumnRole, predicate: (s: ColumnSpec) => boolean) => {
    onBulk(specs.map((s) => (predicate(s) ? { ...s, role } : s)));
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>列の設定</h2>
          <p className="section-hint">
            {specs.length} 列中 {featureCount} 列をクラスタリングに使用します。
            「解釈のみ」にした列は分類には使わず、セグメントの説明にだけ使われます。
          </p>
        </div>
        <div className="inline-row">
          <button
            className="btn btn-sm"
            disabled={disabled}
            onClick={() =>
              setAll('feature', (s) => isNumericKind(s.kind) || s.kind === 'categorical')
            }
          >
            使える列を全選択
          </button>
          <button
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => setAll('ignore', (s) => s.role === 'feature')}
          >
            全解除
          </button>
        </div>
      </div>

      <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto', border: 'none' }}>
        <table className="column-table zebra">
          <thead>
            <tr>
              <th className="sticky-col">列名</th>
              <th>推定</th>
              <th>型</th>
              <th>役割</th>
              <th>変換</th>
              <th className="num">重み</th>
              <th className="num">充足率</th>
              <th className="num">種類数</th>
              <th>サンプル値</th>
            </tr>
          </thead>
          <tbody>
            {specs.map((spec) => {
              const numeric = isNumericKind(spec.kind);
              return (
                <tr key={spec.index}>
                  <td className="sticky-col col-name" title={spec.name}>
                    {spec.name}
                  </td>
                  <td>
                    <span className={`badge ${spec.role}`}>{KIND_LABEL[spec.inferredKind]}</span>
                  </td>
                  <td>
                    <select
                      value={spec.kind}
                      disabled={disabled}
                      aria-label={`${spec.name} の型`}
                      onChange={(e) => {
                        const kind = e.target.value as ColumnKind;
                        const role = NON_FEATURE_KINDS.includes(kind)
                          ? 'ignore'
                          : spec.role === 'ignore'
                            ? 'feature'
                            : spec.role;
                        onChange(spec.index, { kind, role });
                      }}
                    >
                      {optionsFor(spec.kind).map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABEL[kind]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={spec.role}
                      disabled={disabled || NON_FEATURE_KINDS.includes(spec.kind)}
                      aria-label={`${spec.name} の役割`}
                      onChange={(e) =>
                        onChange(spec.index, { role: e.target.value as ColumnRole })
                      }
                    >
                      {(Object.keys(ROLE_LABEL) as ColumnRole[]).map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {numeric ? (
                      <select
                        value={spec.transform}
                        disabled={disabled || spec.role !== 'feature'}
                        onChange={(e) =>
                          onChange(spec.index, {
                            transform: e.target.value as NumericTransform,
                          })
                        }
                      >
                        {(Object.keys(TRANSFORM_LABEL) as NumericTransform[]).map((t) => (
                          <option key={t} value={t}>
                            {TRANSFORM_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ color: 'var(--faint)' }}>—</span>
                    )}
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      min={0}
                      max={20}
                      step={0.5}
                      value={spec.weight}
                      disabled={disabled || spec.role !== 'feature'}
                      onChange={(e) =>
                        onChange(spec.index, {
                          weight: Math.max(0, Math.min(20, Number(e.target.value) || 0)),
                        })
                      }
                    />
                  </td>
                  <td className="num">
                    <span className="fill-bar">
                      <div style={{ width: `${Math.round(spec.fillRate * 100)}%` }} />
                    </span>
                    {Math.round(spec.fillRate * 100)}%
                  </td>
                  <td className="num">
                    {spec.distinctCount >= 5000 ? '5000+' : spec.distinctCount.toLocaleString()}
                  </td>
                  <td className="col-samples" title={spec.sampleValues.join(' / ')}>
                    {spec.sampleValues.join(' / ') || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
