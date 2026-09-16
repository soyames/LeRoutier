// The vocabulary every model provider fails in.
//
// Its own module so the token source and the providers can both speak it
// without importing each other. A reason code is the only thing a failure is
// allowed to carry outwards: provider messages routinely quote the request,
// which for a token exchange means the credential that was being exchanged.

/** A provider failure that is safe to surface and to store. */
export class ModelUnavailable extends Error {
  constructor(reason, detail = '') {
    super(detail || reason);
    this.name = 'ModelUnavailable';
    this.reason = reason;
  }
}

export const MODEL_REASONS = {
  notConfigured: 'not_configured',
  timeout: 'timeout',
  rateLimited: 'rate_limited',
  unauthorized: 'unauthorized',
  providerError: 'provider_error',
  malformedOutput: 'malformed_output',
  modelUnavailable: 'model_unavailable',
};
