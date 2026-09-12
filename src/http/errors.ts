import type { ErrorCode } from '../errors.js';
export const domainStatus: Record<ErrorCode, number> = { INVALID_INPUT: 400, INVALID_QUERY: 400, NOT_FOUND: 404, CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, UNAUTHENTICATED: 401, TOO_MANY_REQUESTS: 429 };
export interface HttpError extends Error {
  statusCode: number;
}
export const createHttpError = (statusCode: number, message: string): HttpError => Object.assign(new Error(message), { statusCode });
