import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as Tracker from "@/ratelimit"
import { Storage } from "@/storage/storage"

const TRACKING_KEY = ["ratelimit", "tracker"]

describe("RateLimit Tracker", () => {
  const providerID = "test-provider"
  const modelID = "test-model"

  beforeEach(async () => {
    await Storage.remove(TRACKING_KEY)
  })

  afterEach(async () => {
    await Storage.remove(TRACKING_KEY)
  })

  describe("checkLimit", () => {
    test("allows request when under limit", async () => {
      const limits = {
        "1s": { requests: 10 },
      }

      const result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(true)
      expect(result.error).toBeUndefined()
    })

    test("blocks request when over request limit", async () => {
      const limits = {
        "1s": { requests: 1 },
      }

      await Tracker.recordRequest(providerID, modelID, ["1s"])

      const result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.metric).toBe("requests")
      expect(result.error!.limit).toBe(1)
      expect(result.error!.current).toBe(1)
    })

    test("blocks request when over token limit", async () => {
      const limits = {
        "1s": { tokens: 100 },
      }

      await Tracker.recordTokens(providerID, modelID, ["1s"], 100, 0, 0)

      const result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.metric).toBe("tokens")
      expect(result.error!.limit).toBe(100)
      expect(result.error!.current).toBe(100)
    })

    test("allows request after window expires", async () => {
      const limits = {
        "1s": { requests: 1 },
      }

      await Tracker.recordRequest(providerID, modelID, ["1s"])

      let result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 1100))

      result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(true)
    })

    test("checks multiple windows independently", async () => {
      const limits = {
        "10s": { requests: 5 },
        "1m": { requests: 10 },
      }

      await Tracker.recordRequest(providerID, modelID, ["10s", "1m"])

      const result1 = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result1.allowed).toBe(true)

      await Tracker.recordRequest(providerID, modelID, ["10s", "1m"])
      await Tracker.recordRequest(providerID, modelID, ["10s", "1m"])

      const result3 = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result3.allowed).toBe(true)

      await Tracker.recordRequest(providerID, modelID, ["10s", "1m"])
      await Tracker.recordRequest(providerID, modelID, ["10s", "1m"])

      const result5 = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result5.allowed).toBe(false)
      expect(result5.error!.window).toBe("10s")
    })

    test("calculates retryAfterMs correctly", async () => {
      const limits = {
        "1s": { requests: 1 },
      }

      await Tracker.recordRequest(providerID, modelID, ["1s"])

      const result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(false)
      expect(result.error!.retryAfterMs).toBeGreaterThan(0)
      expect(result.error!.retryAfterMs).toBeLessThanOrEqual(1000)
    })
  })

  describe("recordRequest", () => {
    test("records request count", async () => {
      const windows = ["1s", "1m"]

      await Tracker.recordRequest(providerID, modelID, windows)
      await Tracker.recordRequest(providerID, modelID, windows)
      await Tracker.recordRequest(providerID, modelID, windows)

      const usage = await Tracker.getUsage(providerID, modelID)

      expect(usage["1s"].requests.count).toBe(3)
      expect(usage["1m"].requests.count).toBe(3)
    })

    test("handles multiple models independently", async () => {
      const modelID1 = "model-1"
      const modelID2 = "model-2"

      await Tracker.recordRequest(providerID, modelID1, ["1s"])
      await Tracker.recordRequest(providerID, modelID2, ["1s"])

      const usage1 = await Tracker.getUsage(providerID, modelID1)
      const usage2 = await Tracker.getUsage(providerID, modelID2)

      expect(usage1["1s"].requests.count).toBe(1)
      expect(usage2["1s"].requests.count).toBe(1)
    })
  })

  describe("recordTokens", () => {
    test("records token usage", async () => {
      const windows = ["1s", "1m"]

      await Tracker.recordTokens(providerID, modelID, windows, 100, 50, 25)

      const usage = await Tracker.getUsage(providerID, modelID)

      expect(usage["1s"].tokens.count).toBe(175)
      expect(usage["1m"].tokens.count).toBe(175)
    })

    test("sums all token types correctly", async () => {
      await Tracker.recordTokens(providerID, modelID, ["1s"], 100, 200, 50)
      await Tracker.recordTokens(providerID, modelID, ["1s"], 50, 100, 25)

      const usage = await Tracker.getUsage(providerID, modelID)

      expect(usage["1s"].tokens.count).toBe(525)
    })

    test("handles zero tokens", async () => {
      await Tracker.recordTokens(providerID, modelID, ["1s"], 0, 0, 0)

      const usage = await Tracker.getUsage(providerID, modelID)

      expect(usage["1s"].tokens.count).toBe(0)
    })
  })

  describe("sliding window cleanup", () => {
    test("removes old entries from sliding window", async () => {
      const limits = {
        "1s": { requests: 2 },
      }

      await Tracker.recordRequest(providerID, modelID, ["1s"])
      await Tracker.recordRequest(providerID, modelID, ["1s"])

      let result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 1100))

      result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(true)
    })

    test("keeps recent entries within window", async () => {
      const limits = {
        "1s": { requests: 10 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["1s"])
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(true)
    })
  })

  describe("persistence", () => {
    test("persists data across storage reads", async () => {
      await Tracker.recordRequest(providerID, modelID, ["1s", "1m"])
      await Tracker.recordTokens(providerID, modelID, ["1s", "1m"], 100, 50, 25)

      const usage1 = await Tracker.getUsage(providerID, modelID)
      expect(usage1["1s"].requests.count).toBe(1)
      expect(usage1["1s"].tokens.count).toBe(175)

      await Tracker.recordRequest(providerID, modelID, ["1s"])
      await Tracker.recordTokens(providerID, modelID, ["1s"], 50, 25, 12)

      const usage2 = await Tracker.getUsage(providerID, modelID)
      expect(usage2["1s"].requests.count).toBe(2)
      expect(usage2["1s"].tokens.count).toBe(262)
    })

    test("different providers are isolated", async () => {
      const provider1 = "provider-1"
      const provider2 = "provider-2"

      await Tracker.recordRequest(provider1, modelID, ["1s"])
      await Tracker.recordRequest(provider2, modelID, ["1s"])

      const usage1 = await Tracker.getUsage(provider1, modelID)
      const usage2 = await Tracker.getUsage(provider2, modelID)

      expect(usage1["1s"].requests.count).toBe(1)
      expect(usage2["1s"].requests.count).toBe(1)
    })
  })

  describe("getUsage", () => {
    test("returns empty object when no usage", async () => {
      const usage = await Tracker.getUsage(providerID, modelID)
      expect(Object.keys(usage)).toHaveLength(0)
    })

    test("returns usage for all windows", async () => {
      const windows = ["1s", "10s", "1m", "1h", "1d"]

      for (const window of windows) {
        await Tracker.recordRequest(providerID, modelID, [window])
        await Tracker.recordTokens(providerID, modelID, [window], 100, 50, 25)
      }

      const usage = await Tracker.getUsage(providerID, modelID)

      expect(Object.keys(usage)).toHaveLength(5)
      for (const window of windows) {
        expect(usage[window].requests.count).toBe(1)
        expect(usage[window].tokens.count).toBe(175)
      }
    })
  })

  describe("edge cases", () => {
    test("handles concurrent requests", async () => {
      const promises = []
      for (let i = 0; i < 50; i++) {
        promises.push(Tracker.recordRequest(providerID, modelID, ["1s"]))
      }

      await Promise.all(promises)

      const usage = await Tracker.getUsage(providerID, modelID)
      expect(usage["1s"].requests.count).toBe(50)
    })

    test("handles large token counts", async () => {
      const largeTokenCount = 1000000

      await Tracker.recordTokens(providerID, modelID, ["1s"], largeTokenCount, largeTokenCount, largeTokenCount)

      const usage = await Tracker.getUsage(providerID, modelID)
      expect(usage["1s"].tokens.count).toBe(3000000)
    })

    test("handles zero limit as no limit", async () => {
      const limits = {
        "1s": { requests: 0 },
      }

      await Tracker.recordRequest(providerID, modelID, ["1s"])

      const result = await Tracker.checkLimit(providerID, modelID, limits)
      expect(result.allowed).toBe(true)
    })
  })

  describe("RateLimitExceededError", () => {
    test("creates error with correct structure", () => {
      const error = new Tracker.RateLimitExceededError({
        message: "Rate limit exceeded",
        window: "1s",
        metric: "requests",
        limit: 10,
        current: 10,
        retryAfterMs: 1000,
      })

      expect(error.data.message).toBe("Rate limit exceeded")
      expect(error.data.window).toBe("1s")
      expect(error.data.metric).toBe("requests")
      expect(error.data.limit).toBe(10)
      expect(error.data.current).toBe(10)
      expect(error.data.retryAfterMs).toBe(1000)
    })

    test("isInstance works correctly", () => {
      const error = new Tracker.RateLimitExceededError({
        message: "Rate limit exceeded",
        window: "1s",
        metric: "requests",
        limit: 10,
        current: 10,
        retryAfterMs: 1000,
      })

      expect(Tracker.RateLimitExceededError.isInstance(error)).toBe(true)
      expect(Tracker.RateLimitExceededError.isInstance(new Error())).toBe(false)
    })
  })
})
