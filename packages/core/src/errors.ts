export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends ApiError {}
export class HttpError extends ApiError {}
export class ParseError extends ApiError {}

export class RateLimitError extends ApiError {
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super(message, 429);
  }
}

export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 1000);
}

export class ErrorCollector {
  count = 0;
  private samples: string[] = [];

  add(context: string, err: unknown): void {
    this.count++;
    if (this.samples.length < 5) this.samples.push(`${context}: ${errorMessage(err)}`);
  }

  get sample(): string | undefined {
    return this.samples.length > 0 ? this.samples.join('\n') : undefined;
  }
}
