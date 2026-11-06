export class GatewayError extends Error {
  constructor(public code: string, message: string, public outcomeUnknown = false) { super(message); }
}

export function publicError(error: unknown) {
  // Browser, HTTP and upstream exceptions may contain session URLs or tool code.
  return error instanceof GatewayError
    ? { code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown }
    : { code: 'OPERATION_FAILED', message: 'Operation failed; check authentication, upstream availability and Penpot compatibility.', outcomeUnknown: false };
}
