export type ErrorCode = 'INVALID_INPUT' | 'INVALID_QUERY' | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE';
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export const domainError = (code: ErrorCode, message: string): DomainError => new DomainError(code, message);
