/// <reference lib="webworker" />
import { inspectSource, loadDataset, type InspectResult } from '../core/loader.ts';
import { FileTextSource, StringTextSource, type TextSource } from '../core/source.ts';
import { runPipeline } from '../core/pipeline.ts';
import { generateDemoCsv } from '../core/demo.ts';
import { buildLabeledCsv, buildProfileCsv, buildSummaryMarkdown } from '../core/export.ts';
import type {
  ClusterResult,
  ColumnSpec,
  Dataset,
  ExportKind,
  RunOptions,
  WorkerRequest,
  WorkerResponse,
} from '../core/types.ts';

/**
 * 重い処理はすべてこの Worker で行う。UI スレッドは常に応答可能なまま。
 * データセットは Worker 内に保持し、設定変更時は必要な場合だけ読み直す。
 */

interface State {
  source: TextSource | null;
  fileName: string;
  inspect: InspectResult | null;
  dataset: Dataset | null;
  /** dataset を作ったときの列構成のシグネチャ */
  datasetSignature: string;
  result: ClusterResult | null;
}

const state: State = {
  source: null,
  fileName: '',
  inspect: null,
  dataset: null,
  datasetSignature: '',
  result: null,
};

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer ?? []);
}

function progress(requestId: number, phase: string, ratio: number, detail?: string): void {
  post({ type: 'progress', phase, ratio, detail, requestId });
}

/** 列構成が変わったかどうかを判定するためのキー（変換や重みは再読込不要） */
function signatureOf(specs: ColumnSpec[], maxRows: number): string {
  return (
    `rows=${maxRows}#` +
    specs
      .filter((s) => s.role !== 'ignore')
      .map((s) => `${s.index}:${s.kind}`)
      .join('|')
  );
}

async function toSource(file: File): Promise<TextSource> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.xlsm')) {
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('シートが見つかりませんでした。');
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    return new StringTextSource(file.name, csv);
  }
  return new FileTextSource(file);
}

async function handleLoad(source: TextSource, fileName: string, requestId: number) {
  state.source = source;
  state.fileName = fileName;
  state.dataset = null;
  state.datasetSignature = '';
  state.result = null;

  progress(requestId, 'inspect', 0.3, 'ファイルの先頭を読んで列を推定中');
  const inspect = await inspectSource(source);
  state.inspect = inspect;

  post({
    type: 'inspected',
    specs: inspect.specs,
    previewRows: inspect.previewRows,
    previewHeader: inspect.previewHeader,
    estimatedRows: inspect.estimatedRows,
    fileName,
    fileSize: source.size,
    encoding: inspect.encoding,
    delimiter: inspect.delimiter,
    warnings: inspect.warnings,
    requestId,
  });
}

async function handleRun(specs: ColumnSpec[], options: RunOptions, requestId: number) {
  if (!state.source || !state.inspect) throw new Error('先にファイルを読み込んでください。');

  const signature = signatureOf(specs, options.maxRows);
  const warnings: string[] = [];

  if (!state.dataset || state.datasetSignature !== signature) {
    progress(requestId, 'load', 0.02, 'データを全件読み込み中');
    state.dataset = await loadDataset(state.source, specs, {
      delimiter: state.inspect.delimiter,
      estimatedRows: state.inspect.estimatedRows,
      maxRows: options.maxRows,
      onProgress: (ratio, rows) => {
        progress(
          requestId,
          'load',
          ratio * 0.35,
          `${rows.toLocaleString()} 行を読み込み`,
        );
      },
    });
    state.datasetSignature = signature;
  } else {
    // 列の役割・変換・重みだけが変わった場合は読み直さず、spec を差し替える
    const byIndex = new Map(specs.map((s) => [s.index, s]));
    for (const column of state.dataset.columns) {
      const next = byIndex.get(column.spec.index);
      if (next) column.spec = { ...next };
    }
  }

  const dataset = state.dataset;
  warnings.push(...dataset.warnings);

  const result = runPipeline({
    dataset,
    options,
    onProgress: (phase, ratio, detail) => {
      progress(requestId, phase, 0.35 + ratio * 0.65, detail);
    },
  });
  state.result = result;

  if (result.effectiveRows < dataset.rowCount) {
    const missing = dataset.rowCount - result.effectiveRows;
    warnings.push(
      `${missing.toLocaleString()} 行は特徴量がすべて欠損しているため、平均値で補完して分類しています。`,
    );
  }

  post({
    type: 'result',
    result,
    rowCount: dataset.rowCount,
    warnings,
    requestId,
  });
}

async function handleExport(kind: ExportKind, requestId: number) {
  if (!state.result || !state.dataset || !state.source || !state.inspect) {
    throw new Error('先にクラスタリングを実行してください。');
  }
  const base = state.fileName.replace(/\.[^.]+$/, '') || 'clustering';

  if (kind === 'labeled-csv') {
    progress(requestId, 'export', 0.1, '元データにセグメント列を追加中');
    const blob = await buildLabeledCsv(
      state.source,
      state.inspect.delimiter,
      state.result,
      (ratio) => progress(requestId, 'export', 0.1 + ratio * 0.9),
      state.dataset.sampleStride,
    );
    post({ type: 'exported', blob, fileName: `${base}_segments.csv`, requestId });
    return;
  }
  if (kind === 'profile-csv') {
    const blob = buildProfileCsv(state.result);
    post({ type: 'exported', blob, fileName: `${base}_profile.csv`, requestId });
    return;
  }
  if (kind === 'summary-md') {
    const blob = buildSummaryMarkdown(state.result, state.fileName);
    post({ type: 'exported', blob, fileName: `${base}_summary.md`, requestId });
    return;
  }
  throw new Error(`未知の出力形式: ${kind}`);
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case 'load-file': {
        const source = await toSource(request.file);
        await handleLoad(source, request.file.name, request.requestId);
        break;
      }
      case 'load-demo': {
        progress(request.requestId, 'inspect', 0.1, 'デモデータを生成中');
        const csv = generateDemoCsv(request.rows, { seed: 7 });
        await handleLoad(
          new StringTextSource('demo_ec_customers.csv', csv),
          'demo_ec_customers.csv',
          request.requestId,
        );
        break;
      }
      case 'run':
        await handleRun(request.specs, request.options, request.requestId);
        break;
      case 'export':
        await handleExport(request.kind, request.requestId);
        break;
    }
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      requestId: request.requestId,
    });
  }
};
