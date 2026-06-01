/**
 * DOMException Polyfill
 *
 * Provides a spec-compliant DOMException implementation for environments
 * where it is missing or incomplete (e.g. Node.js < 17, some older browsers).
 *
 * Spec: https://webidl.spec.whatwg.org/#idl-DOMException
 */

const DOM_EXCEPTION_CODES: Record<string, number> = {
  IndexSizeError: 1,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InUseAttributeError: 10,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
};

const DOM_EXCEPTION_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(DOM_EXCEPTION_CODES).map(([name, code]) => [code, name]),
);

export interface DOMExceptionConstructor {
  new (message?: string, name?: string): DOMException;
  readonly prototype: DOMException;

  readonly INDEX_SIZE_ERR: 1;
  readonly DOMSTRING_SIZE_ERR: 2;
  readonly HIERARCHY_REQUEST_ERR: 3;
  readonly WRONG_DOCUMENT_ERR: 4;
  readonly INVALID_CHARACTER_ERR: 5;
  readonly NO_DATA_ALLOWED_ERR: 6;
  readonly NO_MODIFICATION_ALLOWED_ERR: 7;
  readonly NOT_FOUND_ERR: 8;
  readonly NOT_SUPPORTED_ERR: 9;
  readonly INUSE_ATTRIBUTE_ERR: 10;
  readonly INVALID_STATE_ERR: 11;
  readonly SYNTAX_ERR: 12;
  readonly INVALID_MODIFICATION_ERR: 13;
  readonly NAMESPACE_ERR: 14;
  readonly INVALID_ACCESS_ERR: 15;
  readonly VALIDATION_ERR: 16;
  readonly TYPE_MISMATCH_ERR: 17;
  readonly SECURITY_ERR: 18;
  readonly NETWORK_ERR: 19;
  readonly ABORT_ERR: 20;
  readonly URL_MISMATCH_ERR: 21;
  readonly QUOTA_EXCEEDED_ERR: 22;
  readonly TIMEOUT_ERR: 23;
  readonly INVALID_NODE_TYPE_ERR: 24;
  readonly DATA_CLONE_ERR: 25;
}

// ---------------------------------------------------------------------------
// Polyfill class
// ---------------------------------------------------------------------------

class DOMExceptionPolyfill extends Error {
  // Instance numeric legacy code (0 when name has no legacy code)
  readonly code: number;
  // Error name (defaults to "Error" per spec)
  readonly name: string;

  // --- Static legacy-code constants ---
  static readonly INDEX_SIZE_ERR = 1 as const;
  static readonly DOMSTRING_SIZE_ERR = 2 as const;
  static readonly HIERARCHY_REQUEST_ERR = 3 as const;
  static readonly WRONG_DOCUMENT_ERR = 4 as const;
  static readonly INVALID_CHARACTER_ERR = 5 as const;
  static readonly NO_DATA_ALLOWED_ERR = 6 as const;
  static readonly NO_MODIFICATION_ALLOWED_ERR = 7 as const;
  static readonly NOT_FOUND_ERR = 8 as const;
  static readonly NOT_SUPPORTED_ERR = 9 as const;
  static readonly INUSE_ATTRIBUTE_ERR = 10 as const;
  static readonly INVALID_STATE_ERR = 11 as const;
  static readonly SYNTAX_ERR = 12 as const;
  static readonly INVALID_MODIFICATION_ERR = 13 as const;
  static readonly NAMESPACE_ERR = 14 as const;
  static readonly INVALID_ACCESS_ERR = 15 as const;
  static readonly VALIDATION_ERR = 16 as const;
  static readonly TYPE_MISMATCH_ERR = 17 as const;
  static readonly SECURITY_ERR = 18 as const;
  static readonly NETWORK_ERR = 19 as const;
  static readonly ABORT_ERR = 20 as const;
  static readonly URL_MISMATCH_ERR = 21 as const;
  static readonly QUOTA_EXCEEDED_ERR = 22 as const;
  static readonly TIMEOUT_ERR = 23 as const;
  static readonly INVALID_NODE_TYPE_ERR = 24 as const;
  static readonly DATA_CLONE_ERR = 25 as const;

  constructor(message = '', name = 'Error') {
    super(message);

    // Restore the correct prototype chain when transpiled to ES5
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = name;
    this.message = message;
    this.code = DOM_EXCEPTION_CODES[name] ?? 0;

    // Provide a useful stack trace in V8 / SpiderMonkey
    if (typeof (Error as ErrorConstructor).captureStackTrace === 'function') {
      (Error as ErrorConstructor).captureStackTrace(this, new.target);
    }
  }

  /** Mirror static constants on the prototype (spec §3.1.2) */
  get INDEX_SIZE_ERR() {
    return 1;
  }
  get DOMSTRING_SIZE_ERR() {
    return 2;
  }
  get HIERARCHY_REQUEST_ERR() {
    return 3;
  }
  get WRONG_DOCUMENT_ERR() {
    return 4;
  }
  get INVALID_CHARACTER_ERR() {
    return 5;
  }
  get NO_DATA_ALLOWED_ERR() {
    return 6;
  }
  get NO_MODIFICATION_ALLOWED_ERR() {
    return 7;
  }
  get NOT_FOUND_ERR() {
    return 8;
  }
  get NOT_SUPPORTED_ERR() {
    return 9;
  }
  get INUSE_ATTRIBUTE_ERR() {
    return 10;
  }
  get INVALID_STATE_ERR() {
    return 11;
  }
  get SYNTAX_ERR() {
    return 12;
  }
  get INVALID_MODIFICATION_ERR() {
    return 13;
  }
  get NAMESPACE_ERR() {
    return 14;
  }
  get INVALID_ACCESS_ERR() {
    return 15;
  }
  get VALIDATION_ERR() {
    return 16;
  }
  get TYPE_MISMATCH_ERR() {
    return 17;
  }
  get SECURITY_ERR() {
    return 18;
  }
  get NETWORK_ERR() {
    return 19;
  }
  get ABORT_ERR() {
    return 20;
  }
  get URL_MISMATCH_ERR() {
    return 21;
  }
  get QUOTA_EXCEEDED_ERR() {
    return 22;
  }
  get TIMEOUT_ERR() {
    return 23;
  }
  get INVALID_NODE_TYPE_ERR() {
    return 24;
  }
  get DATA_CLONE_ERR() {
    return 25;
  }

  /** Canonical string representation */
  toString(): string {
    return `${this.name}: ${this.message}`;
  }
}

export const DOMExceptionImpl = (globalThis as Record<string, unknown>)
  .DOMException
  ? ((globalThis as Record<string, unknown>)
      .DOMException as DOMExceptionConstructor)
  : (DOMExceptionPolyfill as DOMExceptionConstructor);

export {
  DOM_EXCEPTION_CODES,
  DOM_EXCEPTION_NAMES,
  DOMExceptionImpl as DOMException,
};
