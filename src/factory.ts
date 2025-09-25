import { frameStream, parsePrelude } from './api';
import type {
  FrameStreamHeaders,
  FrameStreamOptions,
  ParsePreludeOptions,
} from './types';
import type { Readable } from 'node:stream';

/**
 * Creates a reusable framer function with pre-configured options.
 *
 * Useful for creating specialized framers with consistent settings across
 * your application, such as custom magic bytes or default headers.
 *
 * @param defaults - Default options to apply to all framed streams
 * @returns Function that frames streams with the pre-configured options
 *
 * @example
 * ```ts
 * import { createFramer } from 'stream-prelude';
 *
 * // Create a framer with custom magic and version
 * const customFramer = createFramer({
 *   magic: 'MYAPP',
 *   version: 2
 * });
 *
 * // Use the framer consistently
 * const framed = customFramer(source, {
 *   contentType: 'application/json'
 * });
 * ```
 */
export function createFramer(defaults: FrameStreamOptions = {}) {
  return (
    source: Readable,
    headers: FrameStreamHeaders,
    opts: FrameStreamOptions = {}
  ) => frameStream(source, headers, { ...defaults, ...opts });
}

/**
 * Creates a reusable parser function with pre-configured options.
 *
 * Useful for creating specialized parsers with consistent settings across
 * your application, such as custom magic bytes or strict parsing modes.
 *
 * @param defaults - Default options to apply to all parsed streams
 * @returns Function that parses streams with the pre-configured options
 *
 * @example
 * ```ts
 * import { createParser } from 'stream-prelude';
 *
 * // Create a parser that requires prelude validation
 * const strictParser = createParser({
 *   requirePrelude: true,
 *   magic: 'MYAPP'
 * });
 *
 * // Use the parser consistently
 * try {
 *   const { headers, remainder } = await strictParser(source);
 *   // Process headers and remainder
 * } catch (error) {
 *   // Handle missing or invalid prelude
 * }
 * ```
 */
export function createParser(defaults: ParsePreludeOptions = {}) {
  return (source: Readable, opts: ParsePreludeOptions = {}) =>
    parsePrelude(source, { ...defaults, ...opts });
}
