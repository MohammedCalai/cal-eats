const sleepDefault = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ApiError extends Error {
  constructor(message, { status = null, retryable = false, code = "API_ERROR" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

function unwrap(body) {
  return body && typeof body === "object" && Object.hasOwn(body, "data") ? body.data : body;
}

export class ApiClient {
  constructor({ baseUrl, token = null, timeoutMs, retry, fetchImpl = globalThis.fetch, sleep = sleepDefault, random = Math.random }) {
    if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.retry = retry;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.random = random;
  }

  _delay(attempt) {
    const base = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const variation = base * this.retry.jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + variation));
  }

  async _once(pathname, body, authenticated) {
    const headers = { "content-type": "application/json", accept: "application/json", "user-agent": "cal-eats-print-bridge/0.1.0" };
    if (authenticated) {
      if (!this.token) throw new ApiError("Device is not paired", { code: "NOT_PAIRED" });
      headers.authorization = `Bearer ${this.token}`;
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(error.name === "TimeoutError" ? "Device API timed out" : "Device API is unavailable", { retryable: true, code: "NETWORK_ERROR" });
    }
    let responseText;
    try {
      responseText = await response.text();
    } catch {
      throw new ApiError("Device API response was interrupted", { status: response.status, retryable: true, code: "NETWORK_ERROR" });
    }
    let parsed = null;
    if (responseText) {
      try { parsed = JSON.parse(responseText); } catch { throw new ApiError("Device API returned invalid JSON", { status: response.status, retryable: response.status >= 500 }); }
    }
    if (!response.ok) {
      const message = parsed?.error?.message || parsed?.message || `Device API returned HTTP ${response.status}`;
      throw new ApiError(message, { status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500, code: parsed?.error?.code || "HTTP_ERROR" });
    }
    return unwrap(parsed);
  }

  async _request(pathname, body, { authenticated = true, retry = true } = {}) {
    const attempts = retry ? this.retry.maxAttempts : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await this._once(pathname, body, authenticated); }
      catch (error) {
        lastError = error;
        if (!(error instanceof ApiError) || !error.retryable || attempt === attempts) throw error;
        await this.sleep(this._delay(attempt));
      }
    }
    throw lastError;
  }

  pair(code, name) {
    return this._request("/api/devices/pair", { code, name }, { authenticated: false, retry: false });
  }

  heartbeat() {
    return this._request("/api/devices/heartbeat", {});
  }

  async claim() {
    const data = await this._request("/api/devices/jobs/claim", {});
    if (!data || !Object.hasOwn(data, "job")) throw new ApiError("Claim response is malformed", { code: "INVALID_RESPONSE" });
    return data.job;
  }

  ack(jobId, acknowledgement) {
    return this._request(`/api/devices/jobs/${encodeURIComponent(jobId)}/ack`, acknowledgement);
  }
}
