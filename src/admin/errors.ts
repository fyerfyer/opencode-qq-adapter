export class AdminError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 500 | 503;
  readonly code: string;
  readonly details: string[];

  constructor(status: AdminError["status"], code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
