import { Buffer } from 'node:buffer';
import { DEFAULT_MAGIC, LENGTH_BYTES, MAGIC_LENGTH, UTF8 } from './constants';
import {
  PreludeInvalidStreamError,
  PreludeJsonParseError,
  PreludeJsonTooLargeError,
  PreludeTruncatedError,
} from './errors';
import type { FrameStreamPrelude, JsonValue, MultipleMagic } from './types';
import type { Readable } from 'node:stream';

function assertMagic(magic: string | Buffer): Buffer {
  const buffer = Buffer.isBuffer(magic) ? magic : Buffer.from(magic, UTF8);
  if (buffer.length !== MAGIC_LENGTH) {
    throw new TypeError('magic must be exactly 4 bytes');
  }
  return buffer;
}

export function assertMagicList(magic: MultipleMagic | undefined): Buffer[] {
  const items =
    magic === undefined
      ? [DEFAULT_MAGIC]
      : Array.isArray(magic)
        ? magic
        : [magic];
  return items.map((m) => assertMagic(m as string | Buffer));
}

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function assertSerializable(value: JsonValue, path: string): void {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSerializable(entry, `${path}[${index}]`);
    });
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertSerializable(entry as JsonValue, `${path}.${key}`);
    }
    return;
  }

  throw new TypeError(`${path} contains a non-serializable value`);
}

export function validatePrelude(prelude: FrameStreamPrelude): void {
  if (!isPlainObject(prelude)) {
    throw new TypeError('prelude must be a plain object');
  }

  if (Object.prototype.hasOwnProperty.call(prelude, 'v')) {
    throw new TypeError('prelude must not declare the reserved key "v"');
  }

  for (const [key, value] of Object.entries(prelude)) {
    if (value === undefined) {
      throw new TypeError(`prelude.${key} is undefined`);
    }
    assertSerializable(value as JsonValue, `prelude.${key}`);
  }
}

export function makePreludeBuffer(magic: Buffer, json: Buffer): Buffer {
  const buffer = Buffer.allocUnsafe(MAGIC_LENGTH + LENGTH_BYTES + json.length);
  magic.copy(buffer, 0);
  buffer.writeUInt32BE(json.length, MAGIC_LENGTH);
  json.copy(buffer, MAGIC_LENGTH + LENGTH_BYTES);
  return buffer;
}

export function validateJsonLength(length: number, max: number): void {
  if (!Number.isInteger(length) || length < 0) {
    throw new TypeError('JSON length must be a non-negative integer');
  }
  if (length > max) {
    throw new PreludeJsonTooLargeError();
  }
  if (length === 0) {
    throw new PreludeJsonParseError('JSON payload must be non-empty');
  }
}

export function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, UTF8);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    const view = chunk as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new TypeError('Unsupported chunk type received from stream');
}

export async function readExactly(
  stream: Readable,
  size: number
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let collected = 0;

  while (collected < size) {
    const chunk = stream.read(size - collected);
    if (chunk !== null) {
      const buf = toBuffer(chunk);
      buffers.push(buf);
      collected += buf.length;
      continue;
    }

    if (stream.readableEnded) {
      throw new PreludeTruncatedError();
    }

    await new Promise<void>((resolve, reject) => {
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new PreludeTruncatedError());
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        stream.off('readable', onReadable);
        stream.off('end', onEnd);
        stream.off('error', onError);
      };

      stream.once('readable', onReadable);
      stream.once('end', onEnd);
      stream.once('error', onError);
    });
  }

  if (buffers.length === 1) {
    return buffers[0]!;
  }

  return Buffer.concat(buffers, collected);
}

export function validateReadableStream(
  stream: unknown
): asserts stream is Readable {
  if (stream === null || stream === undefined) {
    throw new PreludeInvalidStreamError('Source cannot be null or undefined');
  }

  if (typeof stream !== 'object') {
    throw new PreludeInvalidStreamError('Source must be an object');
  }

  // Check if it's a Readable stream by looking for readable stream properties
  const candidate = stream as Record<string, unknown>;

  if (typeof candidate.pipe !== 'function') {
    throw new PreludeInvalidStreamError('Source must be a readable stream');
  }

  if (typeof candidate.on !== 'function') {
    throw new PreludeInvalidStreamError('Source must be an event emitter');
  }

  // Check for readable stream specific properties
  if (!('readable' in candidate) || typeof candidate.readable !== 'boolean') {
    throw new PreludeInvalidStreamError('Source must be a readable stream');
  }

  if (!('destroy' in candidate) || typeof candidate.destroy !== 'function') {
    throw new PreludeInvalidStreamError('Source must be a readable stream');
  }
}
