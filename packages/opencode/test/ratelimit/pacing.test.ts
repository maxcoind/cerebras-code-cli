import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as Tracker from "@/ratelimit"
import { Storage } from "@/storage/storage"

const TRACKING_KEY = ["ratelimit", "tracker"]

describe("RateLimit Pacing", () => {
  const providerID = "test-provider"
  const modelID = "test-model"

  beforeEach(async () => {
    await Storage.remove(TRACKING_KEY)
  })

  afterEach(async () => {
    await Storage.remove(TRACKING_KEY)
  })

  describe("calculatePacingDelay", () => {
    test("returns 0 when not approaching limit", async () => {
      const limits = {
        "1s": { requests: 10 },
      }

      await Tracker.recordRequest(providerID, modelID, ["1s"])

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBe(0)
    })

    test("returns delay when approaching request limit", async () => {
      const limits = {
        "10s": { requests: 10 },
      }

      for (let i = 0; i < 8; i++) {
        await Tracker.recordRequest(providerID, modelID, ["10s"])
      }

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBeGreaterThan(0)
    })

    test("returns delay when approaching token limit", async () => {
      const limits = {
        "10s": { tokens: 1000 },
      }

      await Tracker.recordTokens(providerID, modelID, ["10s"], 800, 0, 0)

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBeGreaterThan(0)
    })

    test("respects minimum delay", async () => {
      const limits = {
        "10s": { requests: 10 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["10s"])
      }

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80, 5000)

      expect(delay).toBeGreaterThanOrEqual(5000)
    })

    test("pacing increases as usage approaches limit", async () => {
      const limits = {
        "10s": { requests: 10 },
      }

      for (let i = 0; i < 5; i++) {
        await Tracker.recordRequest(providerID, modelID, ["10s"])
      }

      const delay5 = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      for (let i = 0; i < 4; i++) {
        await Tracker.recordRequest(providerID, modelID, ["10s"])
      }

      const delay9 = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay9).toBeGreaterThan(delay5)
    })

    test("returns 0 for zero limit", async () => {
      const limits = {
        "10s": { requests: 0 },
      }

      await Tracker.recordRequest(providerID, modelID, ["10s"])

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBe(0)
    })

    test("handles multiple windows independently", async () => {
      const limits = {
        "1s": { requests: 10 },
        "10s": { requests: 10 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["1s", "10s"])
      }

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBeGreaterThan(0)
    })

    test("pacing based on window closest to limit", async () => {
      const limits = {
        "10s": { requests: 10 },
        "1m": { requests: 100 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["10s", "1m"])
      }

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBeGreaterThan(0)
    })
  })

  describe("pacing behavior with window expiration", () => {
    test("no pacing when window expired", async () => {
      const limits = {
        "1s": { requests: 10 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["1s"])
      }

      await new Promise((resolve) => setTimeout(resolve, 1100))

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBe(0)
    })

    test("no pacing for expired window but still pacing for active window", async () => {
      const limits = {
        "1s": { requests: 10 },
        "1m": { requests: 10 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["1s", "1m"])
      }

      await new Promise((resolve) => setTimeout(resolve, 1100))

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBeGreaterThan(0)
    })
  })

  describe("pacing with tokens vs requests", () => {
    test("paces based on token limit if closer", async () => {
      const limits = {
        "10s": { requests: 100, tokens: 1000 },
      }

      const delayBefore = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      await Tracker.recordTokens(providerID, modelID, ["10s"], 850, 0, 0)
      await Tracker.recordRequest(providerID, modelID, ["10s"])

      const delayAfter = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delayBefore).toBe(0)
      expect(delayAfter).toBeGreaterThan(0)
    })

    test("paces based on request limit if closer", async () => {
      const limits = {
        "10s": { requests: 10, tokens: 10000 },
      }

      for (let i = 0; i < 9; i++) {
        await Tracker.recordRequest(providerID, modelID, ["10s"])
      }

      const delay = await Tracker.calculatePacingDelay(providerID, modelID, limits, 80)

      expect(delay).toBeGreaterThan(0)
    })
  })
})
