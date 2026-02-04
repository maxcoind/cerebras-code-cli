import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import * as Tracker from "./tracker"

export const RateLimitExceededError = NamedError.create(
  "RateLimitExceededError",
  z.object({
    message: z.string(),
    window: z.string(),
    metric: z.enum(["requests", "tokens"]),
    limit: z.number(),
    current: z.number(),
    retryAfterMs: z.number(),
  }),
)

export namespace RateLimit {
  export const WindowInfo = z.object({
    remaining: z.number(),
    limit: z.number(),
    reset: z.string().optional(),
    window: z.string(), // "minute", "hour", "day", or "unknown"
  })
  export type WindowInfo = z.infer<typeof WindowInfo>

  export const Info = z.object({
    providerID: z.string(),
    // Legacy fields for backwards compatibility
    remainingRequests: z.number().optional(),
    limitRequests: z.number().optional(),
    remainingTokens: z.number().optional(),
    limitTokens: z.number().optional(),
    resetRequests: z.string().optional(),
    resetTokens: z.string().optional(),
    updatedAt: z.number().optional(),
    // All rate limits by window
    requestLimits: z.array(WindowInfo).optional(),
    tokenLimits: z.array(WindowInfo).optional(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Update: Bus.event(
      "ratelimit.update",
      z.object({
        providerID: z.string(),
        info: Info,
      }),
    ),
  }

  // Simple global state (not instance-scoped since rate limits are global)
  const globalState = {
    data: {} as Record<string, Info>,
  }
  const state = () => globalState

  /**
   * Parse rate limit info from response headers.
   * Supports common header formats from various providers.
   * Captures all time windows (minute, hour, day) and finds the most restrictive.
   */
  export function parseHeaders(
    headers: Record<string, string | undefined> | Headers | undefined,
    providerID: string,
  ): Info | undefined {
    if (!headers) return undefined

    // Normalize headers to a simple object
    const h: Record<string, string | undefined> = {}
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        h[key.toLowerCase()] = value
      })
    } else {
      for (const [key, value] of Object.entries(headers)) {
        h[key.toLowerCase()] = value
      }
    }

    const info: Info = { providerID, requestLimits: [], tokenLimits: [] }

    // Helper to parse a window's limits
    const parseWindow = (
      type: "requests" | "tokens",
      window: string,
      remainingKey: string,
      limitKey: string,
      resetKey: string,
    ) => {
      const remaining = h[remainingKey]
      const limit = h[limitKey]
      const reset = h[resetKey]

      if (remaining !== undefined && limit !== undefined) {
        const remainingNum = parseInt(remaining, 10)
        const limitNum = parseInt(limit, 10)
        // Skip if values aren't valid numbers
        if (isNaN(remainingNum) || isNaN(limitNum)) return

        const windowInfo: WindowInfo = {
          remaining: remainingNum,
          limit: limitNum,
          reset,
          window,
        }
        if (type === "requests") {
          info.requestLimits!.push(windowInfo)
        } else {
          info.tokenLimits!.push(windowInfo)
        }
      }
    }

    // Parse all time windows for requests
    parseWindow(
      "requests",
      "minute",
      "x-ratelimit-remaining-requests-minute",
      "x-ratelimit-limit-requests-minute",
      "x-ratelimit-reset-requests-minute",
    )
    parseWindow(
      "requests",
      "hour",
      "x-ratelimit-remaining-requests-hour",
      "x-ratelimit-limit-requests-hour",
      "x-ratelimit-reset-requests-hour",
    )
    parseWindow(
      "requests",
      "day",
      "x-ratelimit-remaining-requests-day",
      "x-ratelimit-limit-requests-day",
      "x-ratelimit-reset-requests-day",
    )
    parseWindow(
      "requests",
      "unknown",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-limit-requests",
      "x-ratelimit-reset-requests",
    )
    parseWindow(
      "requests",
      "unknown",
      "ratelimit-remaining-requests",
      "ratelimit-limit-requests",
      "ratelimit-reset-requests",
    )

    // Parse all time windows for tokens
    parseWindow(
      "tokens",
      "minute",
      "x-ratelimit-remaining-tokens-minute",
      "x-ratelimit-limit-tokens-minute",
      "x-ratelimit-reset-tokens-minute",
    )
    parseWindow(
      "tokens",
      "hour",
      "x-ratelimit-remaining-tokens-hour",
      "x-ratelimit-limit-tokens-hour",
      "x-ratelimit-reset-tokens-hour",
    )
    parseWindow(
      "tokens",
      "day",
      "x-ratelimit-remaining-tokens-day",
      "x-ratelimit-limit-tokens-day",
      "x-ratelimit-reset-tokens-day",
    )
    parseWindow(
      "tokens",
      "unknown",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-reset-tokens",
    )
    parseWindow("tokens", "unknown", "ratelimit-remaining-tokens", "ratelimit-limit-tokens", "ratelimit-reset-tokens")

    // Find the most restrictive limits (lowest percentage remaining)
    const findMostRestrictive = (limits: WindowInfo[]): WindowInfo | undefined => {
      if (limits.length === 0) return undefined
      return limits.reduce((most, current) => {
        const mostPct = most.limit > 0 ? most.remaining / most.limit : 1
        const currentPct = current.limit > 0 ? current.remaining / current.limit : 1
        return currentPct < mostPct ? current : most
      })
    }

    const mostRestrictiveRequests = findMostRestrictive(info.requestLimits!)
    const mostRestrictiveTokens = findMostRestrictive(info.tokenLimits!)

    // Set legacy fields from most restrictive limits
    if (mostRestrictiveRequests) {
      info.remainingRequests = mostRestrictiveRequests.remaining
      info.limitRequests = mostRestrictiveRequests.limit
      info.resetRequests = mostRestrictiveRequests.reset
    }
    if (mostRestrictiveTokens) {
      info.remainingTokens = mostRestrictiveTokens.remaining
      info.limitTokens = mostRestrictiveTokens.limit
      info.resetTokens = mostRestrictiveTokens.reset
    }

    // Only return if we found any rate limit info
    if (
      info.remainingRequests !== undefined ||
      info.remainingTokens !== undefined ||
      info.limitRequests !== undefined ||
      info.limitTokens !== undefined
    ) {
      return info
    }

    return undefined
  }

  export function get(providerID: string): Info | undefined {
    return state().data[providerID]
  }

  /**
   * Store the latest rate limit info from a fetch response.
   * This is called from the provider's fetch wrapper.
   */
  export function setLatest(providerID: string, info: Info): void {
    const s = state()

    const infoWithTimestamp: Info = {
      ...info,
      updatedAt: Date.now(),
    }

    s.data[providerID] = infoWithTimestamp

    // Publish update event so UI can show progress bar
    Bus.publish(Event.Update, {
      providerID,
      info: infoWithTimestamp,
    })
  }

  /**
   * Get all rate limit info for all providers
   */
  export function getAll(): Record<string, Info> {
    return { ...state().data }
  }
}

export * from "./tracker"
