/** Provider/model selection or configuration is invalid (e.g. a missing key). */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** The backend returned a non-2xx HTTP response. */
export class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}
