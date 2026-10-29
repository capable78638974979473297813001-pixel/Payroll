/** An error that is safe to show a caller: it carries the HTTP status and a stable machine code. */
export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'invalid_request', message, details);
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);
export const unauthorized = (message = 'Missing or invalid credentials') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new ApiError(403, 'forbidden', message);
