# stream-prelude

[![npm version](https://img.shields.io/npm/v/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![npm downloads](https://img.shields.io/npm/dm/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![license](https://img.shields.io/npm/l/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![node](https://img.shields.io/node/v/stream-prelude.svg?style=flat-square)](https://www.npmjs.com/package/stream-prelude)
[![CI](https://img.shields.io/badge/CI-Node.js%2020%2C%2022%2C%2024-blue?style=flat-square)](https://github.com/seggunn/stream-prelude/actions)
[![coverage](https://img.shields.io/badge/coverage-77%25-yellow?style=flat-square)](https://github.com/seggunn/stream-prelude)

Frame HTTP-style metadata in front of streaming bodies and recover it downstream. This package builds a tiny, dependency-free prelude that carries serialized headers before the actual payload so producers and consumers stay in sync without buffering the world.

## Installation

### From npm (recommended)

```bash
yarn add stream-prelude
npm install stream-prelude
```

## Usage (Node >= 20)

stream-prelude allows you to frame HTTP-style metadata in front of streaming data and recover it downstream. This is particularly useful for:

- **HTTP gateways and proxies** that need to extract and forward headers with streams
- **Service-to-service communication** where metadata needs to travel with the data and there is no other way to stable send them, f.e. with Moleculer framework upto v0.14
- **Protocol bridges** between different streaming protocols
- **File uploads/downloads** with metadata preservation

### Basic Example

```ts
import { frameStream, parsePrelude } from 'stream-prelude';
import { createReadStream } from 'node:fs';

// Producer: Frame a file stream with metadata
const sourceStream = createReadStream('document.pdf');
const framed = frameStream(sourceStream, {
  contentType: 'application/pdf',
  contentDisposition: 'inline; filename="document.pdf"',
  contentLength: 1024,
  customMetadata: {
    uploadedBy: 'user123',
    uploadDate: new Date().toISOString(),
  },
});

// Consumer: Extract metadata and get original stream
const { prelude, remainder } = await parsePrelude(framed);
console.log('Content-Type:', prelude.contentType);
console.log('Custom metadata:', prelude.customMetadata);

// Pipe the remaining content (without prelude)
remainder.pipe(response);
```

### Advanced Example with Error Handling

```ts
import {
  frameStream,
  parsePrelude,
  getPreludeSize,
  PreludeInvalidStreamError,
  PreludeMagicMismatchError
} from 'stream-prelude';

// Producer with comprehensive metadata
const metadata = {
  contentType: 'application/json',
  contentDisposition: 'attachment; filename="data.json"',
  etag: 'W/"abc123"',
  lastModified: new Date().toISOString(),
  compression: 'gzip',
  schemaVersion: 'v2.1',
};

const preludeSize = getPreludeSize(metadata);
console.log(`Prelude size: ${preludeSize} bytes`);

// Frame the stream
const framedStream = frameStream(sourceStream, metadata, {
  version: 2,           // Schema version
  magic: 'META',        // Custom magic bytes
  maxJsonBytes: 8192,   // Max JSON size (default: 16384)
});

// Consumer with robust error handling
try {
  const { prelude, remainder } = await parsePrelude(framedStream, {
    magic: ['META', 'PRE1'],    // Support multiple magic formats
    requirePrelude: true,       // Throw if no prelude found
    onPrelude: (prelude) => {   // Callback when prelude is parsed
      console.log('Received prelude:', prelude);
      // Set response headers immediately
      response.setHeader('Content-Type', prelude.contentType);
      response.setHeader('Content-Disposition', prelude.contentDisposition);
    }
  });

  // Process the remaining stream
  remainder.pipe(response);
} catch (error) {
  if (error instanceof PreludeInvalidStreamError) {
    console.error('Invalid stream provided');
  } else if (error instanceof PreludeMagicMismatchError) {
    console.error('Stream does not contain expected prelude');
  } else {
    console.error('Error parsing prelude:', error);
  }
}
```

## API Reference

### `frameStream(source, prelude, options?)`

Creates a new readable stream that prepends a binary prelude containing serialized prelude to the source stream.

**Parameters:**
- `source` *(Readable)*: The readable stream to frame. **Required.**
- `prelude` *(object)*: Plain JSON-serializable object describing the payload. The key `v` is reserved for versioning. **Required.**
- `options` *(object, optional)*: Configuration options
  - `magic` *(string | Buffer | Array, default: `'PRE1'`)*: 4-byte marker identifying the prelude. Can be a single value or array of values for compatibility.
  - `version` *(number, default: `1`)*: Schema version included in the serialized payload as `v`.
  - `maxJsonBytes` *(number, default: `16384`)*: Maximum size of JSON payload in bytes for security.

**Returns:** *(Readable)* A new readable stream starting with the prelude followed by the original source content.

**Example:**
```ts
import { frameStream } from 'stream-prelude';

// Simple framing
const framed = frameStream(sourceStream, {
  contentType: 'application/json',
  contentDisposition: 'attachment; filename="data.json"',
});

// With custom options
const customFramed = frameStream(sourceStream, {
  contentType: 'application/pdf',
  customField: 'value',
}, {
  magic: 'CUSTOM',      // Custom 4-byte magic marker
  version: 2,           // Schema version
  maxJsonBytes: 4096,   // Smaller JSON limit
});
```

### `parsePrelude(source, options?)`

Parses a prelude from a readable stream and extracts the embedded prelude.

**Parameters:**
- `source` *(Readable)*: The readable stream to parse. **Required.**
- `options` *(object, optional)*: Configuration options
  - `magic` *(string | Buffer | Array, default: `'PRE1'`)*: Expected magic marker(s). Can be single value or array for backward compatibility.
  - `maxJsonBytes` *(number, default: `16384`)*: Maximum JSON payload size for security.
  - `requirePrelude` *(boolean, default: `false`)*: Throw on missing/mismatched magic instead of falling back.
  - `onPrelude` *(function, optional)*: Callback invoked with parsed prelude before streaming body.
  - `autoPause` *(boolean, default: `false`)*: Pause flowing streams instead of throwing.

**Returns:** *(Promise<{ prelude: object, remainder: Readable }>)* Promise resolving to prelude object and remainder stream. If no prelude is found and `requirePrelude` is false, `prelude` is `{}` and `remainder` passes through the original bytes.

**Example:**
```ts
import { parsePrelude } from 'stream-prelude';

// Basic parsing
const { prelude, remainder } = await parsePrelude(framedStream);
console.log(prelude.contentType);
remainder.pipe(response);

// With options
const result = await parsePrelude(framedStream, {
  magic: ['NEW1', 'PRE1'],     // Support multiple magic formats
  requirePrelude: true,         // Strict mode - throw if no prelude
  maxJsonBytes: 8192,          // Custom JSON size limit
  onPrelude: (headers) => {     // Callback for immediate prelude processing
    console.log('Prelude received:', headers);
    response.setHeader('Content-Type', headers.contentType);
  },
});
```

### `getPreludeSize(prelude, options?)`

Calculates the total size in bytes of a prelude for the given prelude. Essential for setting HTTP Content-Length headers when serving framed streams.

**Parameters:**
- `prelude` *(object)*: Prelude object to calculate size for. **Required.**
- `options` *(object, optional)*: Configuration options
  - `magic` *(string | Buffer, default: `'PRE1'`)*: Magic marker (affects size if custom length).
  - `version` *(number, default: `1`)*: Version number (included in JSON).
  - `maxJsonBytes` *(number, default: `16384`)*: Maximum JSON payload size for validation.

**Returns:** *(number)* Total size in bytes of the prelude (magic + length field + JSON payload).

**Example:**
```ts
import { getPreludeSize } from 'stream-prelude';

// Calculate total response size
const prelude = {
  contentType: 'application/pdf',
  contentDisposition: 'attachment; filename="document.pdf"',
  etag: 'W/"abc123"',
  lastModified: new Date().toISOString(),
};

const preludeSize = getPreludeSize(prelude);
const bodySize = getFileSize('document.pdf'); // Your logic here
const totalSize = preludeSize + bodySize;

response.setHeader('Content-Length', totalSize);
response.setHeader('Content-Type', prelude.contentType);
```

### `isFramedStream(source, options?)`

Probes a readable stream to determine if it contains a valid prelude without consuming or modifying the stream.

**Parameters:**
- `source` *(Readable)*: The readable stream to probe. **Required.**
- `options` *(object, optional)*: Configuration options
  - `magic` *(string | Buffer | Array, default: `'PRE1'`)*: Expected magic marker(s).

**Returns:** *(Promise<boolean>)* Promise resolving to `true` if stream has valid prelude, `false` otherwise.

**Example:**
```ts
import { isFramedStream } from 'stream-prelude';

// Probe before processing
const stream = getIncomingStream();
const isFramed = await isFramedStream(stream);

if (isFramed) {
  const { prelude, remainder } = await parsePrelude(stream);
  // Handle framed stream
  processFramedStream(prelude, remainder);
} else {
  // Handle regular stream
  stream.pipe(response);
}
```

## How It Works: Prelude Extraction and Chunk Formation

Understanding how stream-prelude extracts metadata and forms chunks is crucial for building robust streaming applications.

### Prelude Structure

The prelude is a compact binary format prepended to your stream:

```
┌─────────────┬─────────────┬──────────────┐
│ Magic (4B)  │ Length (4B)  │ JSON Payload │
├─────────────┼─────────────┼──────────────┤
│ "PRE1"      │ 0x00000123  │ {"v":1,...}  │
└─────────────┴─────────────┴──────────────┘
```

- **Magic Bytes**: 4-byte identifier (default: `'PRE1'`) that marks the start of a prelude
- **Length Field**: 32-bit big-endian integer specifying the JSON payload size
- **JSON Payload**: UTF-8 encoded JSON containing your headers plus version info

### Parsing Process

When `parsePrelude()` is called, here's what happens internally:

1. **Stream State Check**: The parser first checks if the stream is in flowing mode with active data listeners. If so, it either pauses the stream (if `autoPause: true`) or throws a `PreludeFlowingModeError`.

2. **Magic Detection**: The parser reads exactly 4 bytes from the stream and compares them against expected magic markers. If no match is found:
   - If `requirePrelude: true`: throws `PreludeMagicMismatchError`
   - If `requirePrelude: false`: returns `{ prelude: {}, remainder: source }` (fallback mode)

3. **Length Extraction**: Reads 4 bytes to get the JSON payload length (32-bit big-endian).

4. **JSON Parsing**: Reads the specified number of bytes and parses as UTF-8 JSON. Validates that the result is a plain object.

5. **Remainder Creation**: Creates a new stream containing all data after the prelude:
   - **Zero-copy path**: If the source stream supports `unshift()`, bytes are pushed back and the original stream is returned
   - **PassThrough path**: Otherwise, creates a new `PassThrough` stream that pipes the remainder

### Chunk Formation Example

Let's trace through a concrete example:

```ts
// Original data: "Hello World!" (12 bytes)
// Headers: { contentType: 'text/plain', contentLength: 12 }

const source = createReadStream('hello.txt'); // Contains "Hello World!"
const framed = frameStream(source, {
  contentType: 'text/plain',
  contentLength: 12
});

// Internal prelude structure:
// Magic: "PRE1" (4 bytes)
// Length: 47 (4 bytes) - length of JSON.stringify({v:1, contentType: 'text/plain', contentLength: 12})
// JSON: {"v":1,"contentType":"text/plain","contentLength":12} (47 bytes)
// Body: "Hello World!" (12 bytes)
// Total: 67 bytes

const { prelude, remainder } = await parsePrelude(framed);

// Result:
// headers = { v: 1, contentType: 'text/plain', contentLength: 12 }
// remainder = Readable stream containing "Hello World!"
```

### Performance Characteristics

- **Memory Usage**: Prelude parsing reads only the header portion into memory, never buffering the entire stream
- **Chunk Boundaries**: The parser respects original chunk boundaries in the remainder stream
- **Backpressure**: Full backpressure support through the underlying stream implementation
- **Zero-copy**: When possible, uses stream `unshift()` to avoid creating intermediate PassThrough streams

### Error Scenarios

1. **Truncated Stream**: If the stream ends before the complete prelude is read, throws `PreludeTruncatedError`
2. **Invalid JSON**: If the JSON payload is malformed, throws `PreludeJsonParseError`
3. **Oversized JSON**: If JSON exceeds `maxJsonBytes`, throws `PreludeJsonTooLargeError`
4. **Invalid Headers**: If parsed JSON is not a plain object, throws `PreludeInvalidTypeError`
5. **Flowing Stream**: If stream has active data listeners, throws `PreludeFlowingModeError` (unless `autoPause: true`)

Notes:

- Prelude does not force early header flush through proxies; headers reach the client when the first payload bytes are forwarded.
- The `v` field is reserved for schema versioning. Consumers should ignore unknown keys to allow forward compatibility.
- Treat prelude JSON as untrusted input. Sanitize `contentDisposition` filenames and validate values before exposing to end-users.
- The library exports specific error classes (`PreludeMagicMismatchError`, `PreludeTruncatedError`, etc.) for better error handling.

## API Design Decision: Parameter Naming

For version 1.0.0, we've renamed the parameter from `headers` to `prelude` to better reflect the purpose and content of the parameter.

**Rationale for `prelude`:**
- **Precision**: The object becomes the prelude content, not just headers
- **Flexibility**: More accurately represents that it can contain any data, not just HTTP headers
- **Future-proofing**: Allows for non-HTTP use cases more naturally
- **Consistency**: Aligns with the library's naming (e.g., `parsePrelude`, `encodePrelude`)

**Breaking Change** (v1.0.0):
```ts
// Before (v0.x)
const framed = frameStream(source, headers, options);

// After (v1.0.0)
const framed = frameStream(source, prelude, options);
```

**Migration**:
- Update all calls to `frameStream()`, `encodePrelude()`, and `getPreludeSize()` to use `prelude` instead of `headers`
- The parsed result still uses `headers` to refer to the extracted metadata:
  ```ts
  const { prelude, remainder } = await parsePrelude(stream);
  ```

### Gateway Pattern

For HTTP gateways and proxies, use this pattern to extract headers and forward them to clients:

```ts
import {
  parsePrelude,
  getPreludeSize,
  PreludeInvalidStreamError,
  PreludeMagicMismatchError
} from 'stream-prelude';

async function handleRequest(clientResponse, upstreamStream) {
  try {
    const { prelude, remainder } = await parsePrelude(upstreamStream, {
      magic: ['PRE1', 'CUSTOM'],     // Support multiple formats
      requirePrelude: true,          // Strict mode for gateway
      maxJsonBytes: 4096,            // Smaller limit for security
    });

    // Set response headers from prelude
    if (prelude.contentType)
      clientResponse.setHeader('Content-Type', prelude.contentType);
    if (prelude.contentDisposition)
      clientResponse.setHeader('Content-Disposition', prelude.contentDisposition);
    if (prelude.etag) clientResponse.setHeader('ETag', prelude.etag);
    if (prelude.lastModified) clientResponse.setHeader('Last-Modified', prelude.lastModified);
    if (prelude.cacheControl) clientResponse.setHeader('Cache-Control', prelude.cacheControl);

    // Handle content length carefully
    if (prelude.contentLength && typeof prelude.contentLength === 'number') {
      // If prelude contains content length, use it for total size calculation
      const totalSize = getPreludeSize(prelude) + prelude.contentLength;
      clientResponse.setHeader('Content-Length', totalSize);
    }

    // Pipe the body
    remainder.pipe(clientResponse);

  } catch (error) {
    if (error instanceof PreludeInvalidStreamError) {
      clientResponse.statusCode = 400;
      clientResponse.end('Invalid stream format');
    } else if (error instanceof PreludeMagicMismatchError) {
      clientResponse.statusCode = 400;
      clientResponse.end('Unsupported stream format');
    } else {
      clientResponse.statusCode = 500;
      clientResponse.end('Internal server error');
    }
  }
}

// Advanced gateway with fallback handling
async function robustGateway(clientResponse, upstreamStream) {
  const { prelude, remainder } = await parsePrelude(upstreamStream, {
    magic: ['PRE1'],                // Only accept standard format
    requirePrelude: false,          // Allow fallback
  });

  if (Object.keys(prelude).length === 0) {
    // Fallback: treat as regular HTTP response
    // Extract headers from HTTP response object
    const contentType = upstreamStream.headers?.['content-type'];
    if (contentType) {
      clientResponse.setHeader('Content-Type', contentType);
    }

    // Pipe stream directly without prelude parsing
    upstreamStream.pipe(clientResponse);
  } else {
    // Standard prelude handling
    if (prelude.contentType) {
      clientResponse.setHeader('Content-Type', prelude.contentType);
    }

    remainder.pipe(clientResponse);
  }
}
```

### Migration Guide

#### Why Migrate to stream-prelude?

**Before stream-prelude**: When building HTTP gateways, proxies, or service-to-service communication systems, you often face these challenges:

- **Lost metadata**: HTTP headers are lost when streaming through multiple services
- **Buffering issues**: Need to buffer entire streams to extract metadata
- **Protocol mismatches**: Different services speak different streaming protocols
- **Error-prone parsing**: Manual binary parsing is complex and error-prone

**With stream-prelude**: These problems disappear because:

- **Zero-buffering**: Metadata travels with the stream without buffering
- **HTTP compatibility**: Works with existing HTTP infrastructure
- **Protocol agnostic**: Works with any readable stream
- **Automatic parsing**: Robust, error-handling built-in

#### Migrating from single magic to multiple magics

When evolving your framing protocol, you may need to change the magic marker. Here's how to handle the transition smoothly:

```ts
// Phase 1: Support both old and new formats
const { prelude, remainder } = await parsePrelude(stream, {
  magic: ['OLD1', 'NEW1'], // Accept either format
});

// Phase 2: Strict validation with new format
const { prelude, remainder } = await parsePrelude(stream, {
  magic: 'NEW1',
  requirePrelude: true, // Throw if not using new format
});

// Phase 3: Remove old format support
const { prelude, remainder } = await parsePrelude(stream, {
  magic: 'NEW1',
});
```

**Migration Benefits:**
- **Backward compatibility**: Old clients continue working during transition
- **Forward compatibility**: New clients can immediately use enhanced features
- **Controlled rollout**: Validate new format adoption before removing old support

#### Schema Versioning and Consumer Updates

When adding new header fields or changing the structure, increment the version number:

```ts
// Producer: Increment version for new fields
const framed = frameStream(source, {
  contentType: 'application/json',
  compression: 'gzip',    // New field in v2
  checksum: 'sha256:...', // New field in v2
}, { version: 2 });

// Consumer: Handle version differences gracefully
const { prelude, remainder } = await parsePrelude(stream);
const {
  v,
  contentType,
  contentDisposition,
  ...rest
} = headers;

// Version-aware processing
switch (v) {
  case 1:
    // Handle v1 format
    console.log('Legacy format detected');
    break;
  case 2:
    // Handle v2 format with new fields
    const { compression, checksum } = rest;
    console.log(`Compression: ${compression}`);
    console.log(`Checksum: ${checksum}`);
    break;
  default:
    // Future versions: ignore unknown fields
    console.log(`Unknown version ${v}, proceeding safely`);
}

// Always process known fields regardless of version
if (contentType) {
  response.setHeader('Content-Type', contentType);
}
```

**Versioning Best Practices:**
- **Increment on breaking changes**: Only when old consumers would break
- **Ignore unknown fields**: Future versions may add fields you don't understand
- **Validate new fields**: Even with versioning, validate field values for security
- **Document changes**: Keep a changelog of version differences

#### Real-World Migration Example

Here's how a team migrated their file upload service:

```ts
// OLD: Custom binary format (hard to maintain)
const oldParser = (stream) => {
  // 50+ lines of manual binary parsing...
  // Buffer management nightmares
  // Hard to extend
};

// NEW: stream-prelude (clean and maintainable)
const newParser = async (stream) => {
  const { prelude, remainder } = await parsePrelude(stream, {
    magic: ['OLD1', 'NEW1'], // Support both during migration
  });

  if (Object.keys(headers).length === 0) {
    // Fallback to old parser for truly old streams
    return oldParser(stream);
  }

  return { prelude, remainder };
};

// Migration complete: Remove old parser after 30 days
const finalParser = async (stream) => {
  const { prelude, remainder } = await parsePrelude(stream, {
    magic: 'NEW1',
    requirePrelude: true,
  });
  return { prelude, remainder };
};
```

**Migration Success Factors:**
- **Test coverage**: Comprehensive tests for both old and new formats
- **Gradual rollout**: Deploy to non-critical systems first
- **Monitoring**: Track adoption rates and error patterns
- **Documentation**: Clear communication to all stakeholders

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

1. **Validate stream sources**: Always validate that your source is actually a readable stream:

   ```ts
   import { PreludeInvalidStreamError } from 'stream-prelude';

   try {
     const { prelude, remainder } = await parsePrelude(sourceStream);
   } catch (error) {
     if (error instanceof PreludeInvalidStreamError) {
       throw new Error('Invalid stream source provided');
     }
     throw error; // Re-throw other errors
   }
   ```

2. **Sanitize filenames**: Always validate `contentDisposition` filenames before exposing to file systems:

   ```ts
   const { prelude } = await parsePrelude(stream);
   const filename = sanitizeFilename(
     prelude.contentDisposition?.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)?/)?.[1] || 'download'
   );
   ```

3. **Don't trust unbounded JSON**: The library enforces `maxJsonBytes`, but validate individual fields:

   ```ts
   const { prelude } = await parsePrelude(stream);

   if (prelude.contentLength && (typeof prelude.contentLength !== 'number' || prelude.contentLength > MAX_ALLOWED_SIZE)) {
     throw new Error('Content-Length is invalid or too large');
   }

   if (prelude.contentType && typeof prelude.contentType !== 'string') {
     throw new Error('Content-Type must be a string');
   }
   ```

4. **Use requirePrelude for internal APIs**: Enable strict mode when parsing streams from trusted sources:

   ```ts
   const { prelude, remainder } = await parsePrelude(stream, {
     requirePrelude: true,
   });
   ```

5. **Set Content-Length carefully**: When serving framed streams, account for prelude size:

   ```ts
   const preludeSize = getPreludeSize(headers);
   const totalSize = preludeSize + bodySize;
   response.setHeader('Content-Length', totalSize);
   ```

6. **Handle magic mismatches gracefully**: Different magic markers may indicate different protocols or versions:

   ```ts
   try {
     const { prelude, remainder } = await parsePrelude(stream, {
       magic: ['PRE1'], // Only accept expected format
       requirePrelude: true,
     });
   } catch (error) {
     if (error.name === 'PreludeMagicMismatchError') {
       // Handle unsupported stream format
       response.statusCode = 400;
       response.end('Unsupported stream format');
       return;
     }
     throw error;
   }
   ```

7. **Monitor for errors**: Log and monitor parsing errors to detect attacks or protocol issues:

   ```ts
   const { prelude, remainder } = await parsePrelude(stream, {
     maxJsonBytes: 8192, // Reasonable limit for your use case
   }).catch(error => {
     console.error('Prelude parsing failed:', error.message);
     // Decide whether to continue or fail based on your security model
     throw error;
   });
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
- Run tests with coverage to ensure adequate test coverage:
  ```bash
  yarn test:coverage
  ```
- Coverage reports are generated in HTML format in the `coverage/` directory
- Current coverage: 77% overall, 71% branches, 82% functions, 77% lines, 77% statements

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

## Publishing

### Automated Publishing

This project uses automated publishing to **npm** via GitHub Actions. Here's how releases work:

#### Creating a Release

1. **Create a version tag**: Create and push a version tag following semantic versioning:
   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```

2. **Automated workflow**: The [publish workflow](.github/workflows/publish.yml) will automatically:
   - Build the project
   - Run all tests and checks
   - Publish to **npm** with provenance
   - Make package publicly available on npm registry

#### Release Requirements

- Tags must follow the pattern `v*.*.*` (e.g., `v1.0.0`, `v2.1.3`)
- All CI checks must pass before publishing
- The commit must be tagged on the main branch
- npm token must be configured in repository secrets

#### Publishing Checklist

Before tagging a release, ensure:

- [ ] All tests pass (`yarn test`)
- [ ] Code coverage is acceptable (`yarn test:coverage`)
- [ ] Code is properly formatted (`yarn format`)
- [ ] No linting errors (`yarn lint`)
- [ ] Version updated in `package.json`
- [ ] Changelog updated (if applicable)

### Manual Publishing (Not Recommended)

For manual publishing when automation isn't available:

```bash
# Build the project
yarn build

# Publish to npm (requires auth)
npm publish --access public
```

**Note**: Manual publishing bypasses the CI/CD checks and provenance features.

## Warning

Prelude is a private wire protocol between your services. Do not expose framed streams to external clients unless they also parse the prelude.

## License

MIT
