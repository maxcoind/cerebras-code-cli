import { Storage } from "@/storage/storage"
import { Lock } from "@/util/lock"

const LOCK_KEY = "ratelimit-tracker"

interface RequestEntry {
  timestamp: number
  count: number
}

interface TokenEntry {
  timestamp: number
  input: number
  output: number
  reasoning: number
}

interface WindowData {
  requests: RequestEntry[]
  tokens: TokenEntry[]
}

interface TrackerData {
  [providerID_modelID: string]: {
    [windowKey: string]: WindowData
  }
}

const TRACKING_KEY = ["ratelimit", "tracker"]

export interface RateLimitWindow {
  requests?: number
  tokens?: number
}

export interface CheckResult {
  allowed: boolean
  error?: RateLimitError
}

export interface RateLimitError {
  window: string
  metric: "requests" | "tokens"
  limit: number
  current: number
  retryAfterMs: number
}

function parseWindow(window: string): number {
  const match = window.match(/^(\d+)([smhd])$/)
  if (!match) throw new Error(`Invalid window format: ${window}`)

  const value = parseInt(match[1], 10)
  const unit = match[2]
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
  }

  return value * multipliers[unit]
}

function getWindowKey(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`
}

function cleanupEntries<T extends { timestamp: number }>(entries: T[], windowMs: number): T[] {
  const now = Date.now()
  const cutoff = now - windowMs
  return entries.filter((entry) => entry.timestamp > cutoff)
}

async function getTrackerData(): Promise<TrackerData> {
  try {
    return await Storage.read<TrackerData>(TRACKING_KEY)
  } catch {
    return {}
  }
}

async function saveTrackerData(data: TrackerData): Promise<void> {
  await Storage.write(TRACKING_KEY, data)
}

async function updateTrackerData(fn: (data: TrackerData) => void): Promise<void> {
  using _ = await Lock.write(LOCK_KEY)
  const data = await getTrackerData()
  fn(data)
  await saveTrackerData(data)
}

export async function checkLimit(
  providerID: string,
  modelID: string,
  limits: Record<string, RateLimitWindow>,
): Promise<CheckResult> {
  using _ = await Lock.write(LOCK_KEY)
  const data = await getTrackerData()
  const key = getWindowKey(providerID, modelID)
  const modelData = data[key] || {}

  const now = Date.now()

  for (const [windowKey, limit] of Object.entries(limits)) {
    const windowMs = parseWindow(windowKey)
    const windowData = modelData[windowKey] || { requests: [], tokens: [] }

    const cleanedRequests = cleanupEntries(windowData.requests, windowMs)
    const cleanedTokens = cleanupEntries(windowData.tokens, windowMs)

    const requestCount = cleanedRequests.reduce((sum, entry) => sum + entry.count, 0)
    const tokenCount = cleanedTokens.reduce((sum, entry) => sum + entry.input + entry.output + entry.reasoning, 0)

    if (limit.requests && requestCount >= limit.requests) {
      const oldestRequest = cleanedRequests[0]
      const retryAfterMs = oldestRequest ? oldestRequest.timestamp + windowMs - now : windowMs

      return {
        allowed: false,
        error: {
          window: windowKey,
          metric: "requests",
          limit: limit.requests,
          current: requestCount,
          retryAfterMs,
        },
      }
    }

    if (limit.tokens && tokenCount >= limit.tokens) {
      const oldestToken = cleanedTokens[0]
      const retryAfterMs = oldestToken ? oldestToken.timestamp + windowMs - now : windowMs

      return {
        allowed: false,
        error: {
          window: windowKey,
          metric: "tokens",
          limit: limit.tokens,
          current: tokenCount,
          retryAfterMs,
        },
      }
    }
  }

  return { allowed: true }
}

export async function recordRequest(providerID: string, modelID: string, windows: string[]): Promise<void> {
  await updateTrackerData((data) => {
    const key = getWindowKey(providerID, modelID)
    if (!data[key]) data[key] = {}

    const timestamp = Date.now()

    for (const windowKey of windows) {
      if (!data[key][windowKey]) {
        data[key][windowKey] = { requests: [], tokens: [] }
      }

      const windowMs = parseWindow(windowKey)
      data[key][windowKey].requests = cleanupEntries(data[key][windowKey].requests, windowMs)
      data[key][windowKey].requests.push({ timestamp, count: 1 })
    }
  })
}

export async function recordTokens(
  providerID: string,
  modelID: string,
  windows: string[],
  input: number,
  output: number,
  reasoning: number,
): Promise<void> {
  await updateTrackerData((data) => {
    const key = getWindowKey(providerID, modelID)
    if (!data[key]) data[key] = {}

    const timestamp = Date.now()

    for (const windowKey of windows) {
      if (!data[key][windowKey]) {
        data[key][windowKey] = { requests: [], tokens: [] }
      }

      const windowMs = parseWindow(windowKey)
      data[key][windowKey].tokens = cleanupEntries(data[key][windowKey].tokens, windowMs)
      data[key][windowKey].tokens.push({ timestamp, input, output, reasoning })
    }
  })
}

export async function getUsage(
  providerID: string,
  modelID: string,
): Promise<
  Record<
    string,
    {
      requests: { count: number; limit?: number }
      tokens: { count: number; limit?: number }
    }
  >
> {
  using _ = await Lock.read(LOCK_KEY)
  const data = await getTrackerData()
  const key = getWindowKey(providerID, modelID)
  const modelData = data[key] || {}

  const result: Record<
    string,
    {
      requests: { count: number; limit?: number }
      tokens: { count: number; limit?: number }
    }
  > = {}

  for (const [windowKey, windowData] of Object.entries(modelData)) {
    const windowMs = parseWindow(windowKey)

    const cleanedRequests = cleanupEntries(windowData.requests, windowMs)
    const cleanedTokens = cleanupEntries(windowData.tokens, windowMs)

    result[windowKey] = {
      requests: {
        count: cleanedRequests.reduce((sum, e) => sum + e.count, 0),
      },
      tokens: {
        count: cleanedTokens.reduce((sum, e) => sum + e.input + e.output + e.reasoning, 0),
      },
    }
  }

  return result
}
