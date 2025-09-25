# stream-prelude

[![npm version](https://img.shields.io/npm/v/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![npm downloads](https://img.shields.io/npm/dm/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![license](https://img.shields.io/npm/l/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![node](https://img.shields.io/node/v/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)

Frame HTTP-style metadata in front of streaming bodies and recover it downstream. This package builds a tiny, dependency-free prelude that carries serialized headers before the actual payload so producers and consumers stay in sync without buffering the world.

## Installation

```
yarn add stream-prelude
```

## Usage (Node >= 20)

```ts
import { frameStream, parsePrelude } from 'stream-prelude';

// producer side
const framed = frameStream(sourceStream, {
  contentType: 'application/pdf',
  contentDisposition: "inline; filename*=UTF-8''x.pdf",
  headers: {
    etag: 'W/"123"',
  },
});

// consumer side
const { headers, remainder } = await parsePrelude(framed);
console.log(headers.contentType);
remainder.pipe(responseStream);
```

## API

### `frameStream(source, headers, options?)`

- source: `Readable` stream. Emits a framed stream that starts with the prelude.
- headers: plain JSON-serializable object describing the payload. The key `v` is reserved.
- options
  - magic (default `PRE1`): 4-byte marker identifying the prelude.
  - version (default `1`): included in the serialized payload as `v`.
  - maxJsonBytes (default `16384`): validates the JSON payload size.

### `parsePrelude(source, options?)`

- source: `Readable` stream to inspect.
- options
  - magic: expected magic marker(s). Can be string, Buffer, or array of either. Streams with mismatched magic fall back to the original source.
  - maxJsonBytes: maximum JSON payload size.
  - requirePrelude: throw on missing/mismatched magic instead of falling back.
  - onHeaders: callback invoked with parsed headers before streaming body.
  - autoPause: pause flowing streams instead of throwing.

Returns a promise resolving to `{ headers, remainder }`. If a prelude is not present, `headers` is `{}` and `remainder` passes through the original bytes.

### `getPreludeSize(headers, options?)`

- headers: headers object to compute size for.
- options
  - magic: magic marker (affects size if custom length).
  - version: version number (included in JSON).
  - maxJsonBytes: maximum JSON payload size (for validation).

Returns the total size in bytes of the prelude (magic + length + JSON). Use this to compute `Content-Length` for HTTP responses:

```ts
const headers = {
  contentType: 'application/pdf',
  contentDisposition: 'attachment; filename="doc.pdf"',
};
const preludeSize = getPreludeSize(headers);
const bodySize = getFileSize('doc.pdf'); // your logic here
const totalSize = preludeSize + bodySize;
response.setHeader('Content-Length', totalSize);
```

Notes:

- Prelude does not force early header flush through proxies; headers reach the client when the first payload bytes are forwarded.
- The `v` field is reserved for schema versioning. Consumers should ignore unknown keys to allow forward compatibility.
- Treat prelude JSON as untrusted input. Sanitize `contentDisposition` filenames and validate values before exposing to end-users.
- The library exports specific error classes (`PreludeMagicMismatchError`, `PreludeTruncatedError`, etc.) for better error handling.

### Gateway Pattern

For HTTP gateways and proxies, use this pattern to extract headers and forward them to clients:

```ts
import { parsePrelude } from 'stream-prelude';

async function handleRequest(clientResponse, upstreamStream) {
  const { headers, remainder } = await parsePrelude(upstreamStream);

  // Set response headers from prelude
  if (headers.contentType)
    clientResponse.setHeader('Content-Type', headers.contentType);
  if (headers.contentDisposition)
    clientResponse.setHeader('Content-Disposition', headers.contentDisposition);
  if (headers.etag) clientResponse.setHeader('ETag', headers.etag);
  if (headers.contentLength)
    clientResponse.setHeader('Content-Length', headers.contentLength);

  // Pipe the body
  remainder.pipe(clientResponse);
}
```

### Migration Guide

#### Migrating from single magic to multiple magics

To support multiple magic formats during migration:

```ts
// Old format
const oldMagic = 'OLD1';

// New format
const newMagic = 'NEW1';

// Support both during transition
const { headers, remainder } = await parsePrelude(stream, {
  magic: [oldMagic, newMagic],
});

// Or use requirePrelude for strict validation
const { headers, remainder } = await parsePrelude(stream, {
  magic: newMagic,
  requirePrelude: true,
});
```

#### Updating consumers

When adding new header fields, increment the version and ensure consumers handle unknown fields gracefully:

```ts
const { headers, remainder } = await parsePrelude(stream);
const { v, contentType, contentDisposition, ...rest } = headers;

// Handle version differences
if (v >= 2) {
  // New fields available
  const { newField } = rest;
}
```

### Transform & helpers

```ts
import {
  createFramer,
  createParser,
  decodePrelude,
  DEFAULT_MAGIC,
  DEFAULT_MAX_JSON_BYTES,
  encodePrelude,
  getPreludeSize,
  isFramedStream,
  parsePreludeTransform,
} from 'stream-prelude';

// In a pipeline
const t = parsePreludeTransform();
t.once('headers', (h) => {
  /* set response headers */
});
source.pipe(t).pipe(res);

// Probe
const framed = await isFramedStream(source);

// Non-stream
const buf = encodePrelude({ contentType: 'text/plain' });
const { headers, offset } = decodePrelude(Buffer.concat([buf, body]));

// Factories for ergonomic setup
const framer = createFramer({ magic: 'CUSTOM' });
const parser = createParser({ requirePrelude: true });
const framed = framer(source, { contentType: 'text/plain' });
const { headers } = await parser(framed);
```

### Benchmarks (indicative)

- Small headers parse: < 1 ms
- Overhead on large streams: negligible; body is piped with backpressure

## Security

### maxJsonBytes Trade-offs

The `maxJsonBytes` option (default: 16384) controls the maximum size of the JSON prelude:

- **Small values (1-4KB)**: Minimal memory usage, fast parsing, but limits header complexity
- **Medium values (16-64KB)**: Balances functionality with security, recommended for most applications
- **Large values (128KB+)**: Maximum flexibility but higher memory usage and parsing time

**Recommendations:**

- Use 16KB for typical HTTP headers
- Use 64KB for applications with complex metadata
- Never exceed 1MB without extensive testing

### Security Best Practices

1. **Sanitize filenames**: Always validate `contentDisposition` filenames before exposing to file systems:

   ```ts
   const { headers } = await parsePrelude(stream);
   const filename = sanitizeFilename(
     headers.contentDisposition?.filename || 'download'
   );
   ```

2. **Don't trust unbounded JSON**: The library enforces `maxJsonBytes`, but validate individual fields:

   ```ts
   if (headers.contentLength && headers.contentLength > MAX_ALLOWED_SIZE) {
     throw new Error('Content-Length too large');
   }
   ```

3. **Use requirePrelude for internal APIs**: Enable strict mode when parsing streams from trusted sources:

   ```ts
   const { headers, remainder } = await parsePrelude(stream, {
     requirePrelude: true,
   });
   ```

4. **Set Content-Length carefully**: When serving framed streams, account for prelude size:
   ```ts
   const preludeSize = getPreludeSize(headers);
   const totalSize = preludeSize + bodySize;
   response.setHeader('Content-Length', totalSize);
   ```

## Contributing

We welcome contributions! Please follow these guidelines to ensure a smooth contribution process.

### Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/seggunn/stream-prelude.git
   cd stream-prelude
   ```
3. **Install dependencies**:
   ```bash
   yarn install
   ```
4. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

### Development Workflow

1. **Make your changes** following the coding standards
2. **Add tests** for new functionality
3. **Run the test suite**:
   ```bash
   yarn test
   ```
4. **Build the project**:
   ```bash
   yarn build
   ```
5. **Ensure code formatting**:
   ```bash
   yarn format
   ```
6. **Commit your changes** using conventional commits:
   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```
7. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```
8. **Create a Pull Request** from your fork to the main repository

### Code Style

- We use **Prettier** for code formatting
- **ESLint** for linting with strict TypeScript rules
- Follow the existing code style and patterns
- Write **meaningful commit messages** following [Conventional Commits](https://conventionalcommits.org/)
- Add **JSDoc comments** for public APIs

### Testing

- All new features must include comprehensive tests
- Tests should cover both success and error cases
- Use descriptive test names that explain the behavior being tested
- Run the full test suite before submitting PRs:
  ```bash
  yarn test
  ```

### Pull Request Guidelines

- **One feature per PR**: Keep PRs focused and reviewable
- **Update documentation**: Include README updates for new features
- **Reference issues**: Link to related GitHub issues
- **Wait for reviews**: PRs require approval from maintainers
- **Be responsive**: Address review feedback promptly

### Reporting Issues

- Use the [GitHub Issues](https://github.com/seggunn/stream-prelude/issues) page
- Include **reproducible examples** with your bug reports
- Check existing issues before creating new ones
- Use issue templates when available

### Code of Conduct

Please be respectful and constructive when participating in discussions. We follow the [Contributor Covenant](https://www.contributor-covenant.org/) Code of Conduct.

## Warning

Prelude is a private wire protocol between your services. Do not expose framed streams to external clients unless they also parse the prelude.

## License

MIT
