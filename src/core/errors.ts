import type { Platform } from './types.js';

/** Base error for anything a platform provider throws. */
export class ProviderError extends Error {
  constructor(
    readonly platform: Platform,
    message: string,
    /** True when retrying later may succeed (network, 5xx, 429). */
    readonly retryable = true,
    options?: { cause?: unknown },
  ) {
    super(`[${platform}] ${message}`, options);
    this.name = 'ProviderError';
  }
}

/** The channel/user does not exist on the platform. */
export class ChannelNotFoundError extends ProviderError {
  constructor(platform: Platform, input: string) {
    super(platform, `Channel not found: ${input}`, false);
    this.name = 'ChannelNotFoundError';
  }
}

/** Provider credentials are missing or rejected. */
export class ProviderNotConfiguredError extends ProviderError {
  constructor(platform: Platform, detail = 'credentials are not configured') {
    super(platform, detail, false);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Platform asked us to slow down. */
export class RateLimitedError extends ProviderError {
  constructor(
    platform: Platform,
    readonly retryAfterMs: number,
  ) {
    super(platform, `Rate limited, retry after ${retryAfterMs}ms`, true);
    this.name = 'RateLimitedError';
  }
}

/** Input from the dashboard/commands failed validation. Message is user-facing (Arabic). */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
