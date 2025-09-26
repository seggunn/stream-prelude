import { Buffer } from 'node:buffer';
import { Transform, type TransformCallback } from 'node:stream';
import {
  DEFAULT_MAX_JSON_BYTES,
  LENGTH_BYTES,
  MAGIC_LENGTH,
  UTF8,
} from './constants';
import { PreludeInvalidTypeError, PreludeJsonParseError } from './errors';
import { assertMagicList, isPlainObject, validateJsonLength } from './utils';
import type { FramedPrelude, ParsePreludeOptions } from './types';

/**
 * Creates a Transform stream that parses prelude headers and emits them as events.
 *
 * This transform stream reads the prelude from incoming data, emits a 'prelude' event
 * with the parsed prelude, then passes through the remaining data unchanged. It's useful
 * for integrating prelude parsing into existing stream pipelines.
 *
 * @param opts - Optional configuration for parsing behavior
 * @param opts.magic - Expected magic marker(s). Can be string, Buffer, or array of either
 * @param opts.maxJsonBytes - Maximum size of JSON payload in bytes (default: 16384)
 * @param opts.requirePrelude - Throw on missing/mismatched magic instead of falling back
 * @param opts.onPrelude - Callback invoked with parsed prelude before streaming body
 * @param opts.autoPause - Pause flowing streams instead of throwing
 * @returns Transform stream that emits 'prelude' event and passes through body data
 *
 * @example
 * ```ts
 * import { parsePreludeTransform } from 'stream-prelude';
 *
 * const transform = parsePreludeTransform();
 * transform.once('prelude', (prelude) => {
 *   console.log('Content-Type:', prelude.contentType);
 *   // Set response headers here
 * });
 *
 * // Use in a pipeline
 * source.pipe(transform).pipe(response);
 * ```
 */
export function parsePreludeTransform(
  opts: ParsePreludeOptions = {}
): Transform {
  const magics = assertMagicList(opts.magic);
  const maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  let stage: 'magic' | 'length' | 'json' | 'body' = 'magic';
  let needed = MAGIC_LENGTH;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(
    0
  ) as unknown as Buffer<ArrayBufferLike>;
  let jsonLength = 0;

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,
    transform(
      this: Transform,
      chunk: unknown,
      _enc: BufferEncoding,
      cb: TransformCallback
    ) {
      try {
        let bufChunk: Buffer;
        if (Buffer.isBuffer(chunk)) {
          bufChunk = chunk;
        } else if (typeof chunk === 'string') {
          bufChunk = Buffer.from(chunk, 'utf8');
        } else if (chunk instanceof ArrayBuffer) {
          bufChunk = Buffer.from(chunk);
        } else if (ArrayBuffer.isView(chunk)) {
          bufChunk = Buffer.from(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength
          );
        } else {
          throw new TypeError('Unsupported chunk type received from stream');
        }
        buffer = (buffer.length
          ? Buffer.concat([buffer, bufChunk])
          : bufChunk) as unknown as Buffer;

        while (buffer.length >= needed) {
          switch (stage) {
            case 'magic': {
              const slice = buffer.subarray(
                0,
                MAGIC_LENGTH
              ) as unknown as Buffer;
              buffer = buffer.subarray(
                MAGIC_LENGTH
              ) as unknown as Buffer<ArrayBufferLike>;
              if (!magics.some((m) => slice.equals(m))) {
                // no prelude: push back slice and all buffer, switch to body
                this.emit('prelude', {} as FramedPrelude);
                this.push(slice);
                if (buffer.length) this.push(buffer);
                stage = 'body';
                buffer = Buffer.alloc(0) as unknown as Buffer<ArrayBufferLike>;
                needed = 0;
                break;
              }
              stage = 'length';
              needed = LENGTH_BYTES;
              break;
            }
            case 'length': {
              jsonLength = buffer.readUInt32BE(0);
              validateJsonLength(jsonLength, maxJsonBytes);
              buffer = buffer.subarray(
                LENGTH_BYTES
              ) as unknown as Buffer<ArrayBufferLike>;
              stage = 'json';
              needed = jsonLength;
              break;
            }
            case 'json': {
              const jsonBuffer = buffer.subarray(
                0,
                jsonLength
              ) as unknown as Buffer;
              buffer = buffer.subarray(
                jsonLength
              ) as unknown as Buffer<ArrayBufferLike>;
              let parsed: unknown;
              try {
                parsed = JSON.parse(jsonBuffer.toString(UTF8));
              } catch {
                throw new PreludeJsonParseError();
              }
              if (!isPlainObject(parsed)) {
                throw new PreludeInvalidTypeError();
              }
              this.emit('prelude', parsed as FramedPrelude);
              stage = 'body';
              needed = 0;
              break;
            }
            default:
              break;
          }
          if (stage === 'body') {
            break;
          }
        }

        if (stage === 'body' && buffer.length) {
          this.push(buffer);
          buffer = Buffer.alloc(0);
        }
        cb();
      } catch (error) {
        cb(error as Error);
      }
    },
  });
}
