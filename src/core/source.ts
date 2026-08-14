import { detectEncoding, makeDecoder } from './csv.ts';

/**
 * 入力ソースの抽象化。
 * ブラウザの File でも、テスト用の文字列でも同じ手順で読めるようにする。
 */
export interface TextSource {
  readonly name: string;
  readonly size: number;
  /** 文字コード判定・区切り文字判定・型推定に使う先頭部分 */
  head(maxBytes: number): Promise<{ text: string; encoding: string }>;
  /** 全体をチャンクで流す */
  stream(
    onChunk: (text: string) => void,
    onProgress?: (bytesRead: number, total: number) => void,
  ): Promise<void>;
}

export class FileTextSource implements TextSource {
  readonly name: string;
  readonly size: number;
  private readonly file: File;
  private encoding: string | null = null;

  constructor(file: File) {
    this.file = file;
    this.name = file.name;
    this.size = file.size;
  }

  async head(maxBytes: number): Promise<{ text: string; encoding: string }> {
    const blob = this.file.slice(0, Math.min(maxBytes, this.file.size));
    const buf = new Uint8Array(await blob.arrayBuffer());
    const encoding = detectEncoding(buf);
    this.encoding = encoding;
    // 末尾のマルチバイト途中を捨てるため stream モードで decode
    const text = makeDecoder(encoding).decode(buf, { stream: true });
    return { text, encoding };
  }

  async stream(
    onChunk: (text: string) => void,
    onProgress?: (bytesRead: number, total: number) => void,
  ): Promise<void> {
    if (this.encoding === null) await this.head(65536);
    const decoder = makeDecoder(this.encoding!);
    const reader = this.file.stream().getReader();
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      onChunk(decoder.decode(value, { stream: true }));
      onProgress?.(read, this.size);
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
    onProgress?.(this.size, this.size);
  }
}

/** 文字列をそのまま入力にする（テスト・デモデータ・Excel 変換後） */
export class StringTextSource implements TextSource {
  readonly name: string;
  readonly size: number;
  private readonly text: string;

  constructor(name: string, text: string) {
    this.name = name;
    this.text = text;
    this.size = text.length;
  }

  async head(maxBytes: number): Promise<{ text: string; encoding: string }> {
    return { text: this.text.slice(0, maxBytes), encoding: 'utf-8' };
  }

  async stream(
    onChunk: (text: string) => void,
    onProgress?: (bytesRead: number, total: number) => void,
  ): Promise<void> {
    const CHUNK = 1 << 20;
    for (let i = 0; i < this.text.length; i += CHUNK) {
      onChunk(this.text.slice(i, i + CHUNK));
      onProgress?.(Math.min(i + CHUNK, this.text.length), this.text.length);
    }
    if (this.text.length === 0) onProgress?.(0, 0);
  }
}
