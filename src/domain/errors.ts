/** Errors that map onto HTTP responses. */
export class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const unauthorized = (msg = 'authentication required') =>
  new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'not permitted') =>
  new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'not found') =>
  new HttpError(404, 'not_found', msg);
export const conflict = (msg: string, details?: Record<string, unknown>) =>
  new HttpError(409, 'conflict', msg, details);
export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new HttpError(400, 'bad_request', msg, details);
export const gone = (msg: string) => new HttpError(410, 'gone', msg);
