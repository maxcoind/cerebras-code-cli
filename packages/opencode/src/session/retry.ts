import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"
import { RateLimitExceededError } from "@/ratelimit"

export namespace SessionRetry {
  export const RETRY_MAX_DELAY = 60_000 // absolute cap per retry (ms)
  const BASE_DELAY = 1_000 // 1s starting point for exponential backoff

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout)
          reject(new DOMException("Aborted", "AbortError"))
        },
        { once: true },
      )
    })
  }

  function msUntilNextHour(): number {
    const now = new Date()
    return (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds()
  }

  function serverDelay(error: MessageV2.APIError): number | undefined {
    const headers = error.data.responseHeaders
    if (!headers) return undefined

    const retryAfterMs = headers["retry-after-ms"]
    if (retryAfterMs) {
      const parsed = Number.parseFloat(retryAfterMs)
      if (!Number.isNaN(parsed) && parsed > 0) return parsed
    }

    const retryAfter = headers["retry-after"]
    if (retryAfter) {
      const parsedSeconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(parsedSeconds) && parsedSeconds > 0) {
        return Math.ceil(parsedSeconds * 1_000)
      }
      const parsedDate = Date.parse(retryAfter) - Date.now()
      if (!Number.isNaN(parsedDate) && parsedDate > 0) {
        return Math.ceil(parsedDate)
      }
    }

    return undefined
  }

  export function delay(attempt: number, error?: MessageV2.APIError | NamedError): number | undefined {
    // Rate limit errors have exact timing from the error
    if (error && RateLimitExceededError.isInstance(error)) {
      return Math.min(error.data.retryAfterMs, RETRY_MAX_DELAY)
    }

    // Estimate cumulative wait so far: geometric series BASE_DELAY * (2^(attempt) - 2)
    const cumulativeEstimate = BASE_DELAY * (Math.pow(2, attempt) - 2)
    if (cumulativeEstimate >= msUntilNextHour()) return undefined

    // Exponential backoff with jitter (±25%)
    const exponential = BASE_DELAY * Math.pow(2, attempt)
    const jitter = 0.75 + Math.random() * 0.5
    let computed = Math.min(Math.round(exponential * jitter), RETRY_MAX_DELAY)

    // Prefer server guidance when it asks for longer than our calculation
    if (error && MessageV2.APIError.isInstance(error)) {
      const server = serverDelay(error)
      if (server !== undefined) {
        computed = Math.min(Math.max(computed, server), RETRY_MAX_DELAY)
      }
    }

    return computed
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (RateLimitExceededError.isInstance(error)) {
      return error.data.message
    }

    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    if (typeof error.data?.message === "string") {
      const msg = error.data.message

      // Transient network/server errors worth retrying
      if (msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || msg.includes("ENOTFOUND")) {
        return "Network error"
      }
      if (msg.includes("socket hang up") || msg.includes("fetch failed")) {
        return "Connection lost"
      }

      try {
        const json = JSON.parse(msg)
        if (json.type === "error" && json.error?.type === "too_many_requests") {
          return "Too Many Requests"
        }
        if (json.code === "Some resource has been exhausted") {
          return "Provider is overloaded"
        }
        const status = json.status ?? json.statusCode
        if (status === 500 || status === 502 || status === 503) {
          return "Server error"
        }
      } catch {}
    }

    return undefined
  }
}
