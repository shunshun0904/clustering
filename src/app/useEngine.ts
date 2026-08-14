import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClusterResult,
  ColumnSpec,
  ExportKind,
  RunOptions,
  WorkerRequest,
  WorkerResponse,
} from '../core/types.ts';
import { DEFAULT_RUN_OPTIONS } from '../core/types.ts';

/** ユニオン型の各メンバーから同じキーを取り除く（Omit はユニオンを潰してしまう） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'running' | 'exporting';

export interface FileMeta {
  name: string;
  size: number;
  encoding: string;
  delimiter: string;
  estimatedRows: number;
}

export interface EngineState {
  status: EngineStatus;
  phase: string;
  detail: string;
  ratio: number;
  error: string | null;
  warnings: string[];
  specs: ColumnSpec[];
  previewHeader: string[];
  previewRows: string[][];
  meta: FileMeta | null;
  result: ClusterResult | null;
  rowCount: number;
}

const PHASE_LABEL: Record<string, string> = {
  inspect: '列を推定中',
  load: 'データを読み込み中',
  encode: '特徴量を作成中',
  reduce: '次元を圧縮中',
  'search-k': 'クラスタ数を評価中',
  cluster: 'クラスタリング中',
  profile: '特徴を抽出中',
  export: 'ファイルを作成中',
  done: '完了',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}

const INITIAL: EngineState = {
  status: 'idle',
  phase: '',
  detail: '',
  ratio: 0,
  error: null,
  warnings: [],
  specs: [],
  previewHeader: [],
  previewRows: [],
  meta: null,
  result: null,
  rowCount: 0,
};

export function useEngine() {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const activeRef = useRef(0);
  const [state, setState] = useState<EngineState>(INITIAL);
  const [options, setOptions] = useState<RunOptions>(DEFAULT_RUN_OPTIONS);

  useEffect(() => {
    const worker = new Worker(new URL('../worker/pipeline.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      // 古いリクエストの結果は捨てる
      if (message.requestId !== activeRef.current) return;

      switch (message.type) {
        case 'progress':
          setState((prev) => ({
            ...prev,
            phase: message.phase,
            detail: message.detail ?? '',
            ratio: message.ratio,
          }));
          break;
        case 'inspected':
          setState((prev) => ({
            ...prev,
            status: 'ready',
            ratio: 1,
            phase: '',
            detail: '',
            error: null,
            specs: message.specs,
            previewHeader: message.previewHeader,
            previewRows: message.previewRows,
            warnings: message.warnings,
            result: null,
            rowCount: 0,
            meta: {
              name: message.fileName,
              size: message.fileSize,
              encoding: message.encoding,
              delimiter: message.delimiter,
              estimatedRows: message.estimatedRows,
            },
          }));
          break;
        case 'result':
          setState((prev) => ({
            ...prev,
            status: 'ready',
            ratio: 1,
            phase: '',
            detail: '',
            error: null,
            result: message.result,
            rowCount: message.rowCount,
            warnings: message.warnings,
          }));
          break;
        case 'exported': {
          const url = URL.createObjectURL(message.blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = message.fileName;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          setState((prev) => ({ ...prev, status: 'ready', phase: '', ratio: 1 }));
          break;
        }
        case 'error':
          setState((prev) => ({
            ...prev,
            status: prev.meta ? 'ready' : 'idle',
            error: message.message,
            phase: '',
            ratio: 0,
          }));
          break;
      }
    };

    worker.onerror = (event) => {
      setState((prev) => ({
        ...prev,
        status: prev.meta ? 'ready' : 'idle',
        error: `処理中にエラーが発生しました: ${event.message}`,
      }));
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((request: DistributiveOmit<WorkerRequest, 'requestId'>) => {
    const worker = workerRef.current;
    if (!worker) return 0;
    const id = ++requestIdRef.current;
    activeRef.current = id;
    worker.postMessage({ ...request, requestId: id } as WorkerRequest);
    return id;
  }, []);

  const loadFile = useCallback(
    (file: File) => {
      setState({ ...INITIAL, status: 'loading', phase: 'inspect' });
      send({ type: 'load-file', file });
    },
    [send],
  );

  const loadDemo = useCallback(
    (rows: number) => {
      setState({ ...INITIAL, status: 'loading', phase: 'inspect' });
      send({ type: 'load-demo', rows });
    },
    [send],
  );

  const run = useCallback(
    (specs: ColumnSpec[], runOptions: RunOptions) => {
      setState((prev) => ({
        ...prev,
        status: 'running',
        error: null,
        ratio: 0,
        phase: 'load',
        detail: '',
      }));
      send({ type: 'run', specs, options: runOptions });
    },
    [send],
  );

  const exportFile = useCallback(
    (kind: ExportKind) => {
      setState((prev) => ({ ...prev, status: 'exporting', phase: 'export', ratio: 0 }));
      send({ type: 'export', kind });
    },
    [send],
  );

  const updateSpec = useCallback((index: number, patch: Partial<ColumnSpec>) => {
    setState((prev) => ({
      ...prev,
      specs: prev.specs.map((spec) =>
        spec.index === index ? { ...spec, ...patch } : spec,
      ),
    }));
  }, []);

  const setSpecs = useCallback((specs: ColumnSpec[]) => {
    setState((prev) => ({ ...prev, specs }));
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL);
  }, []);

  const busy = state.status === 'loading' || state.status === 'running' || state.status === 'exporting';

  return {
    state,
    options,
    setOptions,
    busy,
    loadFile,
    loadDemo,
    run,
    exportFile,
    updateSpec,
    setSpecs,
    reset,
  };
}
