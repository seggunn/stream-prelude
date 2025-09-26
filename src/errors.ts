// Error classes for better consumer handling
export class PreludeMagicMismatchError extends Error {
  constructor(message = 'Prelude magic mismatch') {
    super(message);
    this.name = 'PreludeMagicMismatchError';
  }
}

export class PreludeTruncatedError extends Error {
  constructor(message = 'Unexpected end of stream while reading prelude') {
    super(message);
    this.name = 'PreludeTruncatedError';
  }
}

export class PreludeJsonTooLargeError extends Error {
  constructor(message = 'JSON payload exceeds maximum length') {
    super(message);
    this.name = 'PreludeJsonTooLargeError';
  }
}

export class PreludeJsonParseError extends Error {
  constructor(message = 'Failed to parse JSON payload') {
    super(message);
    this.name = 'PreludeJsonParseError';
  }
}

export class PreludeInvalidTypeError extends Error {
  constructor(message = 'Parsed headers must be a JSON object') {
    super(message);
    this.name = 'PreludeInvalidTypeError';
  }
}

export class PreludeFlowingModeError extends Error {
  constructor(
    message = 'Stream is in flowing mode with active data listeners. Pass { autoPause: true } or detach listeners.'
  ) {
    super(message);
    this.name = 'PreludeFlowingModeError';
  }
}

export class PreludeInvalidStreamError extends Error {
  constructor(message = 'Source must be a readable stream') {
    super(message);
    this.name = 'PreludeInvalidStreamError';
  }
}
