export type ErrorCode = 'INVALID_INPUT' | 'INVALID_QUERY' | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'UNAUTHENTICATED' | 'TOO_MANY_REQUESTS' | 'FORBIDDEN';
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
/** Создаёт исключение с отдельным кодом и сообщением.
 * @example domainError('NOT_FOUND', 'Нет записи') → Error с code = 'NOT_FOUND' и message = 'Нет записи'.
 */
export const domainError = (code: ErrorCode, message: string): DomainError => new DomainError(code, message);
