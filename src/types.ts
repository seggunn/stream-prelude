import type { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MultipleMagic = string | Buffer | (string | Buffer)[];

export interface FrameStreamOptions {
  magic?: MultipleMagic;
  version?: number;
  maxJsonBytes?: number;
}

export interface CommonHeaders {
  contentType?: string;
  contentDisposition?: string;
  etag?: string;
  contentLength?: number;
}

export type FrameStreamHeaders = CommonHeaders & { [key: string]: JsonValue };

export interface ParsePreludeOptions {
  magic?: MultipleMagic;
  maxJsonBytes?: number;
  requirePrelude?: boolean;
  onHeaders?: (headers: FramedHeaders) => void;
  autoPause?: boolean;
}

export interface ParsePreludeResult {
  headers: FramedHeaders;
  remainder: Readable;
}

export type FramedHeaders = { v?: number } & FrameStreamHeaders &
  Record<string, unknown>;

export interface EncodeOptions {
  magic?: string | Buffer;
  version?: number;
  maxJsonBytes?: number;
}

export interface DecodeOptions {
  magic?: MultipleMagic;
  maxJsonBytes?: number;
}
