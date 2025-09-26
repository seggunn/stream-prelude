import type { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MultipleMagic = string | Buffer | (string | Buffer)[];

export type FrameStreamOptions = {
  magic?: MultipleMagic;
  version?: number;
  maxJsonBytes?: number;
};

export type CommonHeaders = {
  contentType?: string;
  contentDisposition?: string;
  etag?: string;
  contentLength?: number;
};

export type FrameStreamPrelude = CommonHeaders & { [key: string]: JsonValue };

export type ParsePreludeOptions = {
  magic?: MultipleMagic;
  maxJsonBytes?: number;
  requirePrelude?: boolean;
  onPrelude?: (prelude: FramedPrelude) => void;
  autoPause?: boolean;
};

export type ParsePreludeResult = {
  prelude: FramedPrelude;
  remainder: Readable;
};

export type FramedPrelude = { v?: number } & FrameStreamPrelude &
  Record<string, unknown>;

export type EncodeOptions = {
  magic?: string | Buffer;
  version?: number;
  maxJsonBytes?: number;
};

export type DecodeOptions = {
  magic?: MultipleMagic;
  maxJsonBytes?: number;
};
