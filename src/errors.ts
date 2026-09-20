export type SlcmErrorCode =
  | "AUTHENTICATION_FAILED"
  | "NETWORK_ERROR"
  | "PROTOCOL_ERROR"
  | "INVALID_ARGUMENT";

export class SlcmError extends Error {
  readonly code: SlcmErrorCode;

  constructor(code: SlcmErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlcmError";
    this.code = code;
  }
}

export class SlcmAuthenticationError extends SlcmError {
  constructor(message = "SLCM authentication failed.", options?: ErrorOptions) {
    super("AUTHENTICATION_FAILED", message, options);
    this.name = "SlcmAuthenticationError";
  }
}

export class SlcmNetworkError extends SlcmError {
  constructor(message: string, options?: ErrorOptions) {
    super("NETWORK_ERROR", message, options);
    this.name = "SlcmNetworkError";
  }
}

export class SlcmProtocolError extends SlcmError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROTOCOL_ERROR", message, options);
    this.name = "SlcmProtocolError";
  }
}

export class SlcmInvalidArgumentError extends SlcmError {
  constructor(message: string) {
    super("INVALID_ARGUMENT", message);
    this.name = "SlcmInvalidArgumentError";
  }
}
