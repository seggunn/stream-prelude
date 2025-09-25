import { Buffer } from 'node:buffer';
import { PassThrough, type Readable } from 'node:stream';
import {
  DEFAULT_MAX_JSON_BYTES,
  LENGTH_BYTES,
  MAGIC_LENGTH,
  UTF8,
} from './constants';
import {
  PreludeFlowingModeError,
  PreludeInvalidTypeError,
  PreludeJsonParseError,
  PreludeMagicMismatchError,
  PreludeTruncatedError,
} from './errors';
import {
  assertMagicList,
  isPlainObject,
  makePreludeBuffer,
  readExactly,
  validateHeaders,
  validateJsonLength,
} from './utils';
import type {
  FramedHeaders,
  FrameStreamHeaders,
  FrameStreamOptions,
  MultipleMagic,
  ParsePreludeOptions,
  ParsePreludeResult,
} from './types';

/**
 * Frames a readable stream with HTTP-style metadata as a binary prelude.
 *
 * This function prepends a binary prelude containing serialized headers to the source stream.
 * The prelude format consists of: magic bytes (4 bytes) + JSON length (4 bytes) + JSON payload.
 *
 * @param source - The readable stream to frame
 * @param headers - JSON-serializable headers object describing the payload. The 'v' key is reserved for versioning.
 * @param opts - Optional configuration for framing behavior
 * @param opts.magic - Magic marker for prelude identification (default: 'PRE1')
 * @param opts.version - Version number included in headers as 'v' (default: 1)
 * @param opts.maxJsonBytes - Maximum size of JSON payload in bytes (default: 16384)
 * @returns A new readable stream that starts with the prelude followed by the original source content
 *
 * @example
 * ```ts
 * import { frameStream } from 'stream-prelude';
 *
 * const source = fs.createReadStream('file.pdf');
 * const framed = frameStream(source, {
 *   contentType: 'application/pdf',
 *   contentDisposition: 'attachment; filename="document.pdf"'
 * });
 *
 * // Use framed stream in HTTP response
 * framed.pipe(response);
 * ```
 */
export function frameStream(
  source: Readable,
  headers: FrameStreamHeaders,
  opts: FrameStreamOptions = {}
): Readable {
  const magics = assertMagicList(opts.magic);
  const magic = magics[0]!; // assertMagicList always returns at least one Buffer
  const version = opts.version ?? 1;
  const maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;

  validateHeaders(headers);

  const payload = { v: version, ...headers };

  let jsonString: string;
  try {
    jsonString = JSON.stringify(payload);
  } catch {
    throw new TypeError('headers must be JSON serializable');
  }

  const jsonBuffer: Buffer = Buffer.from(jsonString, UTF8);
  validateJsonLength(jsonBuffer.length, maxJsonBytes);
  const prelude: Buffer = makePreludeBuffer(magic, jsonBuffer);

  const framed = new PassThrough();
  const wrote = framed.write(prelude);

  const onError = (error: Error) => framed.destroy(error);
  source.once('error', onError);
  framed.once('close', () => {
    source.off('error', onError);
  });

  const startPipe = () => source.pipe(framed, { end: true });
  if (wrote) {
    startPipe();
  } else {
    framed.once('drain', startPipe);
  }
  return framed;
}

// Helper: Try to unshift any leftover bytes back to source and return source directly
function _tryUnshiftRemainder(source: Readable): Readable | null {
  try {
    // Check if source supports unshift (most Readable streams do)
    if (typeof source.unshift !== 'function') {
      return null;
    }

    // Only safe to unshift if stream is paused and not flowing
    // If stream is flowing, unshift could interfere with existing consumers
    if (source.readableFlowing) {
      return null;
    }

    // Check if the source has been read from (if there are buffered chunks)
    // If there are buffered chunks, unshift might not be safe
    if (source.readableLength > 0) {
      return null;
    }

    // If there are no buffered chunks, we can return source directly
    // The prelude bytes have already been read, so source is positioned correctly
    return source;
  } catch {
    // If anything goes wrong, fall back to PassThrough
    return null;
  }
}

// Helper: Create PassThrough remainder with proper error handling
function _createPassThroughRemainder(source: Readable): Readable {
  const remainder = new PassThrough();
  const onError = (error: Error) => remainder.destroy(error);
  source.once('error', onError);
  remainder.once('close', () => source.off('error', onError));
  source.pipe(remainder, { end: true });
  return remainder;
}

// Helper: Try to unshift bytes back to source and return source directly
function _tryUnshiftRemainderWithBytes(
  source: Readable,
  bytes: Buffer
): Readable | null {
  try {
    // Check if source supports unshift (most Readable streams do)
    if (typeof source.unshift !== 'function') {
      return null;
    }

    // Only safe to unshift if stream is paused and not flowing
    if (source.readableFlowing) {
      return null;
    }

    // Check if the source has been read from (if there are buffered chunks)
    // If there are buffered chunks, unshift might not be safe
    if (source.readableLength > 0) {
      return null;
    }

    // Unshift the probed bytes back so they're available to consumers
    source.unshift(bytes);
    return source;
  } catch {
    // If anything goes wrong, fall back to PassThrough
    return null;
  }
}

// Helper: Create PassThrough remainder with initial bytes
function _createPassThroughRemainderWithBytes(
  source: Readable,
  bytes: Buffer
): Readable {
  const remainder = new PassThrough();
  remainder.write(bytes);
  const onError = (error: Error) => remainder.destroy(error);
  source.once('error', onError);
  remainder.once('close', () => source.off('error', onError));
  source.pipe(remainder, { end: true });
  return remainder;
}

/**
 * Parses a prelude from a readable stream and extracts the embedded headers.
 *
 * This function reads the binary prelude from the stream and returns both the parsed headers
 * and a remainder stream containing the original content without the prelude. If no valid
 * prelude is found, it returns empty headers and the original stream (or fallback stream).
 *
 * @param source - The readable stream to parse
 * @param opts - Optional configuration for parsing behavior
 * @param opts.magic - Expected magic marker(s). Can be string, Buffer, or array of either
 * @param opts.maxJsonBytes - Maximum size of JSON payload in bytes (default: 16384)
 * @param opts.requirePrelude - Throw on missing/mismatched magic instead of falling back
 * @param opts.onHeaders - Callback invoked with parsed headers before streaming body
 * @param opts.autoPause - Pause flowing streams instead of throwing
 * @returns Promise resolving to headers object and remainder stream
 *
 * @example
 * ```ts
 * import { parsePrelude } from 'stream-prelude';
 *
 * const { headers, remainder } = await parsePrelude(request);
 *
 * // Set response headers from prelude
 * if (headers.contentType) {
 *   response.setHeader('Content-Type', headers.contentType);
 * }
 *
 * // Pipe the remaining content
 * remainder.pipe(response);
 * ```
 */
export async function parsePrelude(
  source: Readable,
  opts: ParsePreludeOptions = {}
): Promise<ParsePreludeResult> {
  const magics = assertMagicList(opts.magic);
  const maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;

  try {
    // Deterministic read mode: guard and pause
    if (source.readableFlowing === true && source.listenerCount('data') > 0) {
      if (opts.autoPause) {
        source.pause();
      } else {
        throw new PreludeFlowingModeError();
      }
    }
    source.pause();

    const receivedMagic = await readExactly(source, MAGIC_LENGTH);
    if (!magics.some((m) => receivedMagic.equals(m))) {
      if (opts.requirePrelude) {
        throw new PreludeMagicMismatchError(
          'Missing or invalid prelude. Remove requirePrelude or pass correct magic.'
        );
      }
      // fallback: try unshift-based remainder with probed bytes
      const remainder =
        _tryUnshiftRemainderWithBytes(source, receivedMagic) ||
        _createPassThroughRemainderWithBytes(source, receivedMagic);
      const headers: FramedHeaders = {};
      return { headers, remainder };
    }

    const lengthBuffer = await readExactly(source, LENGTH_BYTES);
    const jsonLength = lengthBuffer.readUInt32BE(0);
    validateJsonLength(jsonLength, maxJsonBytes);

    const jsonBuffer = await readExactly(source, jsonLength);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBuffer.toString(UTF8));
    } catch {
      throw new PreludeJsonParseError();
    }

    if (!isPlainObject(parsed)) {
      throw new PreludeInvalidTypeError();
    }

    const headers = parsed as FramedHeaders;
    if (opts.onHeaders) {
      try {
        opts.onHeaders(headers);
      } catch {
        // Ignore callback errors
      }
    }

    // Try unshift-based remainder for zero-copy when safe
    // Check if we have leftover bytes to unshift back to source
    const remainder =
      _tryUnshiftRemainder(source) || _createPassThroughRemainder(source);

    return { headers, remainder };
  } catch (error) {
    source.destroy(error as Error);
    throw error;
  }
}

/**
 * Encodes headers into a binary prelude buffer without requiring a stream.
 *
 * Creates a standalone prelude buffer that can be prepended to data. The prelude format
 * consists of: magic bytes (4 bytes) + JSON length (4 bytes) + JSON payload.
 *
 * @param headers - JSON-serializable headers object. The 'v' key is reserved for versioning.
 * @param opts - Optional configuration for encoding behavior
 * @param opts.magic - Magic marker for prelude identification (default: 'PRE1')
 * @param opts.version - Version number included in headers as 'v' (default: 1)
 * @param opts.maxJsonBytes - Maximum size of JSON payload in bytes (default: 16384)
 * @returns Buffer containing the complete prelude ready to prepend to data
 *
 * @example
 * ```ts
 * import { encodePrelude } from 'stream-prelude';
 *
 * const headers = {
 *   contentType: 'application/pdf',
 *   contentDisposition: 'attachment; filename="doc.pdf"'
 * };
 *
 * const prelude = encodePrelude(headers);
 * const totalSize = prelude.length + pdfBuffer.length;
 *
 * // Use in HTTP response
 * response.setHeader('Content-Length', totalSize);
 * response.write(prelude);
 * response.write(pdfBuffer);
 * response.end();
 * ```
 */
export function encodePrelude(
  headers: FrameStreamHeaders,
  opts: {
    magic?: string | Buffer;
    version?: number;
    maxJsonBytes?: number;
  } = {}
): Buffer {
  const magics = assertMagicList(opts.magic);
  const magic = magics[0]!; // assertMagicList always returns at least one Buffer
  const version = opts.version ?? 1;
  const maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  validateHeaders(headers);
  const jsonString = JSON.stringify({ v: version, ...headers });
  const jsonBuffer = Buffer.from(jsonString, UTF8);
  validateJsonLength(jsonBuffer.length, maxJsonBytes);
  return makePreludeBuffer(magic, jsonBuffer);
}

/**
 * Decodes a binary prelude buffer and extracts the embedded headers.
 *
 * Parses a complete prelude buffer containing magic bytes, length, and JSON payload.
 * Returns the parsed headers and the offset where the actual data begins.
 *
 * @param buffer - Buffer containing the prelude followed by data
 * @param opts - Optional configuration for decoding behavior
 * @param opts.magic - Expected magic marker(s). Can be string, Buffer, or array of either
 * @param opts.maxJsonBytes - Maximum size of JSON payload in bytes (default: 16384)
 * @returns Object containing parsed headers and byte offset to data
 * @throws {PreludeTruncatedError} If buffer is too small for complete prelude
 * @throws {PreludeMagicMismatchError} If magic bytes don't match expected values
 * @throws {PreludeJsonParseError} If JSON payload cannot be parsed
 * @throws {PreludeInvalidTypeError} If parsed JSON is not a plain object
 *
 * @example
 * ```ts
 * import { decodePrelude } from 'stream-prelude';
 *
 * const buffer = Buffer.concat([preludeBuffer, dataBuffer]);
 * const { headers, offset } = decodePrelude(buffer);
 *
 * console.log('Content-Type:', headers.contentType);
 * const actualData = buffer.subarray(offset);
 * ```
 */
export function decodePrelude(
  buffer: Buffer,
  opts: { magic?: MultipleMagic; maxJsonBytes?: number } = {}
): { headers: Record<string, unknown>; offset: number } {
  const magics = assertMagicList(opts.magic);
  const maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (buffer.length < MAGIC_LENGTH + LENGTH_BYTES) {
    throw new PreludeTruncatedError();
  }
  const sliceMagic = buffer.subarray(0, MAGIC_LENGTH);
  if (!magics.some((m) => sliceMagic.equals(m))) {
    throw new PreludeMagicMismatchError();
  }
  const jsonLength = buffer.readUInt32BE(MAGIC_LENGTH);
  validateJsonLength(jsonLength, maxJsonBytes);
  const start = MAGIC_LENGTH + LENGTH_BYTES;
  const end = start + jsonLength;
  if (buffer.length < end) {
    throw new PreludeTruncatedError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.subarray(start, end).toString(UTF8));
  } catch {
    throw new PreludeJsonParseError();
  }
  if (!isPlainObject(parsed)) {
    throw new PreludeInvalidTypeError();
  }
  return { headers: parsed as Record<string, unknown>, offset: end };
}

/**
 * Calculates the total size in bytes of a prelude for the given headers.
 *
 * This is useful for setting HTTP Content-Length headers when serving framed streams.
 * The prelude size includes: magic bytes + length field (4 bytes) + JSON payload.
 *
 * @param headers - Headers object to calculate size for
 * @param opts - Optional configuration for size calculation
 * @param opts.magic - Magic marker (affects size if custom length)
 * @param opts.version - Version number (included in JSON)
 * @param opts.maxJsonBytes - Maximum JSON payload size for validation
 * @returns Total size in bytes of the prelude
 *
 * @example
 * ```ts
 * import { getPreludeSize } from 'stream-prelude';
 *
 * const headers = {
 *   contentType: 'application/pdf',
 *   contentDisposition: 'attachment; filename="doc.pdf"'
 * };
 *
 * const preludeSize = getPreludeSize(headers);
 * const bodySize = getFileSize('doc.pdf');
 * const totalSize = preludeSize + bodySize;
 *
 * response.setHeader('Content-Length', totalSize);
 * ```
 */
export function getPreludeSize(
  headers: FrameStreamHeaders,
  opts: {
    magic?: string | Buffer;
    version?: number;
    maxJsonBytes?: number;
  } = {}
): number {
  const magics = assertMagicList(opts.magic);
  const magic = magics[0]!; // assertMagicList always returns at least one Buffer
  const version = opts.version ?? 1;
  const maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  validateHeaders(headers);
  const jsonString = JSON.stringify({ v: version, ...headers });
  const jsonLength = Buffer.byteLength(jsonString, UTF8);
  validateJsonLength(jsonLength, maxJsonBytes);
  return magic.length + LENGTH_BYTES + jsonLength;
}

/**
 * Probes a readable stream to determine if it contains a valid prelude.
 *
 * This function safely checks if a stream starts with a prelude without consuming
 * or modifying the stream. It pauses the stream temporarily to read the magic bytes
 * for identification, then restores the stream to its original state.
 *
 * @param source - The readable stream to probe
 * @param opts - Optional configuration for probing behavior
 * @param opts.magic - Expected magic marker(s). Can be string, Buffer, or array of either
 * @returns Promise resolving to true if stream has valid prelude, false otherwise
 *
 * @example
 * ```ts
 * import { isFramedStream } from 'stream-prelude';
 *
 * const stream = getIncomingStream();
 * const isFramed = await isFramedStream(stream);
 *
 * if (isFramed) {
 *   const { headers, remainder } = await parsePrelude(stream);
 *   // Handle framed stream
 * } else {
 *   // Handle regular stream
 *   stream.pipe(response);
 * }
 * ```
 */
export async function isFramedStream(
  source: Readable,
  opts: { magic?: MultipleMagic } = {}
): Promise<boolean> {
  const magics = assertMagicList(opts.magic);
  if (source.readableFlowing === true && source.listenerCount('data') > 0) {
    // avoid interfering with existing consumers
    return false;
  }
  source.pause();
  try {
    const probe = await readExactly(source, MAGIC_LENGTH);
    // For probing, we'll just check the magic without unshift
    // This is acceptable since we're only reading 4 bytes
    return magics.some((m) => probe.equals(m));
  } catch {
    return false;
  }
}
