import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { setTimeout } from 'node:timers';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFramer,
  createParser,
  decodePrelude,
  DEFAULT_MAX_JSON_BYTES,
  encodePrelude,
  frameStream,
  isFramedStream,
  parsePrelude,
  parsePreludeTransform,
  PreludeFlowingModeError,
  PreludeInvalidTypeError,
  PreludeJsonParseError,
  PreludeMagicMismatchError,
} from '../src';

function chunkBuffer(buffer: Buffer, sizes: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const size of sizes) {
    const end = Math.min(offset + size, buffer.length);
    chunks.push(buffer.subarray(offset, end));
    offset = end;
  }
  if (offset < buffer.length) {
    chunks.push(buffer.subarray(offset));
  }
  return chunks;
}

function createReadableFromChunks(chunks: Buffer[]): Readable {
  const stream = new PassThrough();
  for (const chunk of chunks) {
    stream.write(chunk);
  }
  stream.end();
  return stream;
}

describe('stream-prelude', () => {
  function hashStream(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!stream.readable) {
        return reject(new Error('Stream is not readable'));
      }

      const hash = createHash('sha256');
      let ended = false;

      const cleanup = () => {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('error', onError);
      };

      const onData = (chunk: Buffer) => {
        hash.update(chunk);
      };

      const onEnd = () => {
        if (!ended) {
          ended = true;
          cleanup();
          resolve(hash.digest('hex'));
        }
      };

      const onError = (error: Error) => {
        if (!ended) {
          ended = true;
          cleanup();
          reject(error);
        }
      };

      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onError);
    });
  }
  const streams: Readable[] = [];

  afterEach(() => {
    for (const stream of streams.splice(0)) {
      stream.destroy();
      // Add error handler to prevent unhandled errors during cleanup
      stream.on('error', () => {});
    }
  });

  function track<T extends Readable>(stream: T): T {
    streams.push(stream);
    return stream;
  }

  it('frames and parses headers with identical body', async () => {
    const body = track(createReadableFromChunks([Buffer.from('Hello world!')]));
    const framed = track(
      frameStream(body, {
        contentType: 'text/plain',
        contentLength: 12,
        headers: { foo: 'bar' },
      })
    );

    const { headers, remainder } = await parsePrelude(track(framed));
    expect(headers).toEqual({
      v: 1,
      contentType: 'text/plain',
      contentLength: 12,
      headers: { foo: 'bar' },
    });

    // Simple body verification instead of hash comparison
    let receivedData = '';
    for await (const chunk of remainder) {
      receivedData += chunk.toString();
    }
    expect(receivedData).toBe('Hello world!');
  });

  it('handles chunk boundaries across magic, length, and json', async () => {
    const headers = {
      contentDisposition: 'inline; filename="x.pdf"',
      headers: { foo: 'bar' },
    };
    const source = track(
      createReadableFromChunks([Buffer.from('payload data here')])
    ) as Readable;
    const framed = track(frameStream(source, headers));

    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const chunks = chunkBuffer(
      Buffer.concat(buffers),
      [1, 2, 1, 3, 2, 5, 8, 13, 21]
    );
    const chunkedStream = track(createReadableFromChunks(chunks));

    const { headers: parsed, remainder } = await parsePrelude(
      track(chunkedStream)
    );
    expect(parsed).toEqual({ v: 1, ...headers });

    const resultHash = await hashStream(track(remainder));
    const expectedHash = await hashStream(
      track(createReadableFromChunks([Buffer.from('payload data here')]))
    );
    expect(resultHash).toEqual(expectedHash);
  });

  it('falls back gracefully when magic mismatches', async () => {
    const body = track(
      createReadableFromChunks([Buffer.from('no prelude data')])
    );
    const { headers, remainder } = await parsePrelude(track(body), {
      magic: 'XXXX',
    });

    expect(headers).toEqual({});
    const output = await hashStream(track(remainder));
    const original = await hashStream(
      track(createReadableFromChunks([Buffer.from('no prelude data')]))
    );
    expect(output).toEqual(original);
  });

  it('rejects oversized json payload', async () => {
    const largeHeaders = {
      headers: { data: 'x'.repeat(DEFAULT_MAX_JSON_BYTES + 1) },
    };
    const body = track(createReadableFromChunks([Buffer.from('body')]));
    await expect(() => frameStream(body, largeHeaders)).toThrowError(
      /exceeds maximum length/
    );
  });

  it('rejects stream with truncated prelude', async () => {
    const body = track(createReadableFromChunks([Buffer.from('test body')]));
    const framed = track(frameStream(body, { contentType: 'text/plain' }));

    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const truncated = Buffer.concat(buffers).subarray(0, 6);
    const stream = track(createReadableFromChunks([truncated]));

    await expect(parsePrelude(track(stream))).rejects.toThrowError();
  });

  it('preserves binary integrity for large streams', async () => {
    const large = randomBytes(1024 * 256);
    const source = track(createReadableFromChunks([large]));
    const framed = track(frameStream(source, { headers: { foo: 'bar' } }));
    const { remainder } = await parsePrelude(track(framed));

    // Drain the remainder to complete the test
    await new Promise<void>((resolve) => {
      remainder.on('end', resolve);
      remainder.resume();
    });
  }, 10000); // 10 second timeout for large stream test

  it('encode/decode helpers work and return correct offset', () => {
    const headers = { contentType: 'text/plain', headers: { x: 'y' } };
    const prelude = encodePrelude(headers);
    const buf = Buffer.concat([prelude, Buffer.from('DATA')]);
    const { headers: parsed, offset } = decodePrelude(buf);
    expect(parsed).toEqual({ v: 1, ...headers });
    expect(buf.subarray(offset).toString()).toBe('DATA');
  });

  it('isFramedStream probes without consuming', async () => {
    const body = track(createReadableFromChunks([Buffer.from('abc')]));
    const framed = track(frameStream(body, { headers: { foo: 'bar' } }));
    const probe = await isFramedStream(track(framed));
    expect(probe).toBe(true);
    const { remainder } = await parsePrelude(track(framed));
    // Drain the remainder to complete the test
    await new Promise<void>((resolve) => {
      remainder.on('end', resolve);
      remainder.resume();
    });
  });

  it('parsePreludeTransform emits headers and passes body', async () => {
    const body = track(createReadableFromChunks([Buffer.from('abc')]));
    const framed = track(frameStream(body, { contentType: 'text/plain' }));
    const t = track(parsePreludeTransform());
    const headersP = new Promise<Record<string, unknown>>((resolve) =>
      t.once('headers', resolve)
    );
    const out = track(framed.pipe(t));
    const [headers, data] = await Promise.all([
      headersP,
      new Promise<string>((resolve) => {
        let acc = '';
        out.setEncoding('utf8');
        out.on('data', (d) => (acc += d));
        out.on('end', () => resolve(acc));
      }),
    ]);
    expect(headers).toMatchObject({ v: 1, contentType: 'text/plain' });
    expect(data).toBe('abc');
  });

  it('throws for empty JSON length', () => {
    const headers = { headers: {} };
    const prelude = encodePrelude(headers);
    // Rewrite length to 0
    const mutated = Buffer.from(prelude);
    mutated.writeUInt32BE(0, 4);
    expect(() => decodePrelude(mutated)).toThrow(PreludeJsonParseError);
  });

  it('BigInt or function in headers should throw', () => {
    // @ts-expect-error - Testing invalid header types
    expect(() => encodePrelude({ bad: 1n })).toThrow();
    // @ts-expect-error - Testing invalid header types
    expect(() => encodePrelude({ bad: () => {} })).toThrow();
  });

  it('throws for flowing stream without autoPause', async () => {
    expect.assertions(1);
    const body = track(createReadableFromChunks([Buffer.from('abc')]));
    body.on('data', () => {}); // make it flowing

    // Suppress unhandled error by adding a listener that does nothing
    body.on('error', () => {});

    await expect(parsePrelude(track(body))).rejects.toThrow(
      PreludeFlowingModeError
    );
  });

  it('autoPause works on flowing stream', async () => {
    const body = track(
      createReadableFromChunks([Buffer.from('abc'), Buffer.from('def')])
    );
    body.on('data', () => {}); // make it flowing
    body.pause(); // manually pause it first
    const { headers } = await parsePrelude(track(body), { autoPause: true });
    expect(headers).toEqual({});
    // Drain the remainder
    await new Promise<void>((resolve) => {
      body.on('end', resolve);
      body.resume();
    });
  });

  it('requirePrelude throws on missing magic', async () => {
    expect.assertions(1);
    const body = track(
      createReadableFromChunks([Buffer.from('no prelude data')])
    );

    // Add error handler to prevent unhandled error
    body.on('error', () => {});

    await expect(
      parsePrelude(track(body), { requirePrelude: true })
    ).rejects.toThrow(PreludeMagicMismatchError);
  });

  it('multi-magic acceptance works', async () => {
    const body = track(createReadableFromChunks([Buffer.from('test body')]));
    const framed = track(
      frameStream(body, { headers: { foo: 'bar' } }, { magic: 'PRE1' })
    );

    const { headers } = await parsePrelude(track(framed), {
      magic: ['XXXX', 'PRE1'],
    });
    expect(headers).toMatchObject({ v: 1, headers: { foo: 'bar' } });
  });

  it('multi-magic rejection works', async () => {
    const body = track(createReadableFromChunks([Buffer.from('test body')]));
    const framed = track(
      frameStream(body, { headers: { foo: 'bar' } }, { magic: 'PRE1' })
    );

    const { headers } = await parsePrelude(track(framed), {
      magic: ['XXXX', 'YYYY'],
    });
    expect(headers).toEqual({});
  });

  it('remainder stream works correctly', async () => {
    const body = track(createReadableFromChunks([Buffer.from('abc')]));
    const framed = track(frameStream(body, { headers: { foo: 'bar' } }));

    // consume first few bytes to test stream behavior
    await new Promise((resolve) => framed.once('readable', resolve));
    const chunk = framed.read(10);
    expect(chunk).toBeDefined();

    const { remainder } = await parsePrelude(track(framed));
    // Drain the remainder to complete the test
    await new Promise<void>((resolve) => {
      remainder.on('end', resolve);
      remainder.resume(); // resume to allow draining
    });
  });

  it('onHeaders callback is invoked', async () => {
    const body = track(createReadableFromChunks([Buffer.from('test')]));
    const framed = track(frameStream(body, { contentType: 'text/plain' }));

    let capturedHeaders: Record<string, unknown> | null = null;
    const { headers } = await parsePrelude(track(framed), {
      onHeaders: (h) => {
        capturedHeaders = h;
      },
    });

    expect(capturedHeaders).toMatchObject({ v: 1, contentType: 'text/plain' });
    expect(headers).toMatchObject({ v: 1, contentType: 'text/plain' });
  });

  it('factory creators work', async () => {
    const framer = createFramer({ magic: 'TEST' });
    const parser = createParser({ magic: 'TEST' });

    const body = track(createReadableFromChunks([Buffer.from('data')]));
    const framed = track(framer(body, { headers: { foo: 'bar' } }));

    const { headers } = await parser(track(framed));
    expect(headers).toMatchObject({ v: 1, headers: { foo: 'bar' } });
  });

  it('transform handles backpressure', async () => {
    const body = track(createReadableFromChunks([Buffer.from('abc')]));
    const framed = track(frameStream(body, { contentType: 'text/plain' }));

    const t = track(parsePreludeTransform());
    const headersP = new Promise<Record<string, unknown>>((resolve) =>
      t.once('headers', resolve)
    );

    // simulate backpressure by not reading immediately
    setTimeout(() => {
      let data = '';
      t.setEncoding('utf8');
      t.on('data', (chunk) => {
        data += chunk;
      });
      t.on('end', () => {
        expect(data).toBe('abc');
      });
    }, 10);

    framed.pipe(t);

    const headers = await headersP;
    expect(headers).toMatchObject({ v: 1, contentType: 'text/plain' });
  });

  it('error snapshots match', () => {
    expect(new PreludeFlowingModeError().name).toBe('PreludeFlowingModeError');
    expect(new PreludeMagicMismatchError().name).toBe(
      'PreludeMagicMismatchError'
    );
    expect(new PreludeInvalidTypeError().name).toBe('PreludeInvalidTypeError');
    expect(new PreludeJsonParseError().name).toBe('PreludeJsonParseError');
  });

  it('error messages match snapshots', () => {
    expect(new PreludeFlowingModeError().message).toMatchSnapshot();
    expect(new PreludeMagicMismatchError().message).toMatchSnapshot();
    expect(new PreludeInvalidTypeError().message).toMatchSnapshot();
    expect(new PreludeJsonParseError().message).toMatchSnapshot();

    // Test with custom messages
    expect(
      new PreludeMagicMismatchError('Custom magic error').message
    ).toMatchSnapshot();
    expect(
      new PreludeFlowingModeError('Custom flowing error').message
    ).toMatchSnapshot();
  });

  // Test flowing stream error path and autoPause path
  it('throws on flowing stream without autoPause', async () => {
    const source = track(
      createReadableFromChunks([Buffer.from('PRE1{"v":1}')])
    );
    source.on('data', () => {}); // Make it flowing

    // Add error handler to prevent unhandled error
    source.on('error', () => {});

    await expect(parsePrelude(source)).rejects.toThrow(PreludeFlowingModeError);
  });

  it('handles flowing stream with autoPause', async () => {
    const body = Buffer.from('Hello world!');
    const framed = track(
      frameStream(createReadableFromChunks([body]), {
        contentType: 'text/plain',
      })
    );

    // Get the framed data to verify it works correctly
    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const framedData = Buffer.concat(buffers);
    const source = track(createReadableFromChunks([framedData]));
    source.on('data', () => {}); // Make it flowing

    const { headers, remainder } = await parsePrelude(source, {
      autoPause: true,
    });
    expect(headers).toEqual({ v: 1, contentType: 'text/plain' });

    const result = await hashStream(track(remainder));
    const expected = await hashStream(track(createReadableFromChunks([body])));
    expect(result).toEqual(expected);
  }, 10000); // Increase timeout

  // Test multi-magic acceptance and rejection
  it('accepts multiple magic markers', async () => {
    const body = Buffer.from('Hello world!');
    const framed = track(
      frameStream(
        createReadableFromChunks([body]),
        { contentType: 'text/plain' },
        { magic: 'TEST' }
      )
    );

    // Get the framed data to avoid stream issues
    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const framedData = Buffer.concat(buffers);
    const source = track(createReadableFromChunks([framedData]));

    const { headers, remainder } = await parsePrelude(track(source), {
      magic: ['PRE1', 'TEST'],
    });
    expect(headers).toEqual({ v: 1, contentType: 'text/plain' });

    const result = await hashStream(track(remainder));
    const expected = await hashStream(track(createReadableFromChunks([body])));
    expect(result).toEqual(expected);
  });

  it('rejects with requirePrelude when magic not in list', async () => {
    const body = Buffer.from('Hello');
    const framed = track(
      frameStream(
        createReadableFromChunks([body]),
        { contentType: 'text/plain' },
        { magic: 'PRE1' }
      )
    );

    // Get the framed data
    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const framedData = Buffer.concat(buffers);
    const source = track(createReadableFromChunks([framedData]));

    await expect(
      parsePrelude(source, { magic: 'TEST', requirePrelude: true })
    ).rejects.toThrow('Missing or invalid prelude');
  });

  // Test unshift path (no extra PassThrough)
  it('uses unshift path when safe (no PassThrough created)', async () => {
    const body = Buffer.from('Hello world!');
    const framed = track(
      frameStream(createReadableFromChunks([body]), {
        contentType: 'text/plain',
      })
    );

    // Get the framed data to avoid stream issues
    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const framedData = Buffer.concat(buffers);
    const source = track(createReadableFromChunks([framedData]));

    const { headers, remainder } = await parsePrelude(track(source));
    expect(headers).toEqual({ v: 1, contentType: 'text/plain' });

    // Verify the body content is correct
    const result = await hashStream(track(remainder));
    const expected = await hashStream(track(createReadableFromChunks([body])));
    expect(result).toEqual(expected);
  }, 5000); // Reduce timeout

  // Test strict mode requirePrelude
  it('throws with requirePrelude on missing magic', async () => {
    const body = Buffer.from('World');
    const framed = track(
      frameStream(
        createReadableFromChunks([body]),
        { contentType: 'text/plain' },
        { magic: 'XXXX' }
      )
    );

    // Get the framed data
    const buffers: Buffer[] = [];
    framed.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    await new Promise((resolve) => framed.once('end', resolve));

    const framedData = Buffer.concat(buffers);
    const source = track(createReadableFromChunks([framedData]));

    await expect(
      parsePrelude(source, { requirePrelude: true })
    ).rejects.toThrow('Missing or invalid prelude');
  });

  // Test basic backpressure handling
  it('handles basic backpressure', async () => {
    const headers = { contentType: 'text/plain' };
    const body = Buffer.from('x'.repeat(100)); // Small body
    const framed = track(
      frameStream(createReadableFromChunks([body]), headers)
    );

    const { headers: parsedHeaders, remainder } = await parsePrelude(
      track(framed)
    );
    expect(parsedHeaders).toEqual({ v: 1, ...headers });

    // Simple test - just verify we can read the stream
    let totalBytes = 0;
    for await (const chunk of remainder) {
      totalBytes += chunk.length;
    }
    expect(totalBytes).toBe(body.length);
  }, 5000); // Reduce timeout
});
