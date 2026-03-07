const log = {
  info: (msg: string) => console.log(`\x1b[32m[INFO]\x1b[0m  [Mirroring] ${msg}`),
  warn: (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m  [Mirroring] ${msg}`),
}

const DURATION_TOLERANCE_MS = 3000
const MIN_SIMILARITY = 0.50
const HIGH_CONFIDENCE = 0.75
const IMMEDIATE_USE = 0.88
const THROTTLED_SOURCES = new Set(['ytmsearch', 'ytsearch'])
const WEIGHTS = { title: 0.50, artist: 0.30, duration: 0.20 }

interface Track {
  title?: string
  author?: string
  length?: number
  info?: { title?: string; author?: string; length?: number }
}

interface StreamInfo {
  url: string
  exception?: { message: string }
}

interface ScoredMatch {
  match: Track
  score: number
  streamInfo?: StreamInfo
}

interface CancelToken { cancelled: boolean }

function normalize(str: string): string {
  if (!str) return ''
  return str.toLowerCase()
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '')
    .replace(/\b(?:feat|ft)\.?\s*/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshteinDistance(s1: string, s2: string): number {
  const len1 = s1.length, len2 = s2.length
  const dp: number[][] = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0))
  for (let i = 0; i <= len1; i++) dp[i]![0] = i
  for (let j = 0; j <= len2; j++) dp[0]![j] = j
  for (let i = 1; i <= len1; i++)
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost)
    }
  return dp[len1]![len2]!
}

function stringSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0
  if (!s1 || !s2) return 0.0
  const n1 = normalize(s1), n2 = normalize(s2)
  if (n1 === n2) return 1.0
  if (n1.includes(n2) || n2.includes(n1))
    return 0.80 + (Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length)) * 0.15
  const maxLen = Math.max(n1.length, n2.length)
  return maxLen === 0 ? 1.0 : 1.0 - levenshteinDistance(n1, n2) / maxLen
}

function durationSimilarity(d1: number, d2: number): number {
  if (d1 <= 0 || d2 <= 0) return 0.5
  const diff = Math.abs(d1 - d2)
  return diff <= DURATION_TOLERANCE_MS ? 1.0 : Math.max(0.0, 1.0 - diff / Math.max(d1, d2))
}

function scoreMatch(original: Track, candidate: Track): number {
  const origTitle = normalize(original.title || '')
  const candTitle = normalize(candidate.info?.title || candidate.title || '')
  let titleScore: number
  if (origTitle === candTitle) titleScore = 1.0
  else if (candTitle.startsWith(origTitle)) titleScore = 0.95
  else if (candTitle.includes(origTitle) || origTitle.includes(candTitle))
    titleScore = 0.82 + (Math.min(origTitle.length, candTitle.length) / Math.max(origTitle.length, candTitle.length)) * 0.10
  else titleScore = stringSimilarity(origTitle, candTitle)
  return (titleScore * WEIGHTS.title)
    + (stringSimilarity(original.author || '', candidate.info?.author || candidate.author || '') * WEIGHTS.artist)
    + (durationSimilarity(original.length || 0, candidate.info?.length || candidate.length || 0) * WEIGHTS.duration)
}

function rankCandidates(original: Track, candidates: Track[]): ScoredMatch[] {
  if (!candidates.length) return []
  return candidates.slice(0, 10)
    .map(match => ({ match, score: scoreMatch(original, match) }))
    .sort((a, b) => b.score - a.score)
}

function fmt(ms: number): string {
  const s = Math.round((ms || 0) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function logResolved(original: Track, prefix: string, result: ScoredMatch): void {
  const m = result.match.info ?? result.match as any
  log.info(
    `"${original.title ?? '?'}" | ${original.author ?? '?'} | ${fmt(original.length ?? 0)}` +
    ` => ${prefix} | "${m.title ?? '?'}" | ${m.author ?? '?'} | ${fmt(m.length ?? 0)} | score: ${result.score.toFixed(3)}`
  )
}

async function validateStream(nodelink: any, match: Track): Promise<{ valid: boolean; streamInfo?: StreamInfo }> {
  try {
    const streamInfo: StreamInfo | null = await nodelink.sources.getTrackUrl(match.info ?? match)
    if (!streamInfo || streamInfo.exception || !streamInfo.url) return { valid: false }
    return { valid: true, streamInfo }
  } catch {
    return { valid: false }
  }
}

async function findBestValidMatch(nodelink: any, scoredMatches: ScoredMatch[], threshold: number): Promise<ScoredMatch | null> {
  for (const { match, score } of scoredMatches) {
    if (score < threshold) continue
    const { valid, streamInfo } = await validateStream(nodelink, match)
    if (valid) return { match, score, streamInfo }
  }
  return null
}

async function searchSource(
  nodelink: any,
  track: Track,
  prefix: string,
  query: string,
  cancel: CancelToken,
  trustAny = false
): Promise<(ScoredMatch & { prefix: string }) | null> {
  if (cancel.cancelled) return null
  let searchResult: any
  try {
    searchResult = await nodelink.sources.search(prefix, query)
  } catch (e: any) {
    log.warn(`[${prefix}] search failed: ${e.message}`)
    return null
  }
  if (cancel.cancelled || searchResult.loadType !== 'search' || !searchResult.data?.length) return null

  const ranked = rankCandidates(track, searchResult.data)
  if (!ranked.length) return null

  let result: ScoredMatch | null
  if (trustAny) {
    result = await findBestValidMatch(nodelink, ranked, 0)
  } else {
    const top = ranked[0]!.score
    const limit     = top >= IMMEDIATE_USE ? 1 : top >= HIGH_CONFIDENCE ? 2 : 3
    const threshold = top >= IMMEDIATE_USE ? IMMEDIATE_USE : top >= HIGH_CONFIDENCE ? HIGH_CONFIDENCE : MIN_SIMILARITY
    result = await findBestValidMatch(nodelink, ranked.slice(0, limit), threshold)
  }

  if (!result || cancel.cancelled) return null
  return { ...result, prefix }
}

async function raceToImmediate(
  promises: Promise<(ScoredMatch & { prefix: string }) | null>[]
): Promise<{ winner: (ScoredMatch & { prefix: string }) | null; rest: Promise<(ScoredMatch & { prefix: string }) | null>[] }> {
  return new Promise(resolve => {
    let settled = 0
    promises.forEach((p, i) => {
      p.then(result => {
        settled++
        if (result && result.score >= IMMEDIATE_USE)
          return resolve({ winner: result, rest: promises.filter((_, j) => j !== i) })
        if (settled === promises.length) resolve({ winner: null, rest: [] })
      }).catch(() => {
        if (++settled === promises.length) resolve({ winner: null, rest: [] })
      })
    })
  })
}

async function mirror(nodelink: any, track: Track, mirroringSources?: string[]): Promise<(ScoredMatch & { prefix: string }) | null> {
  const sources: string[] = mirroringSources ?? ['ytmsearch', 'ytsearch']
  if (!sources.length) { log.warn('No providers available'); return null }

  const query = track.author && track.author !== 'unknown'
    ? `${track.title} ${track.author}`
    : track.title ?? ''

  const freeSources      = sources.filter(s => !THROTTLED_SOURCES.has(s))
  const throttledSources = sources.filter(s => THROTTLED_SOURCES.has(s))

  const cancel: CancelToken = { cancelled: false }
  let globalBest: (ScoredMatch & { prefix: string }) | null = null

  if (freeSources.length) {
    const freePromises = freeSources.map(prefix => searchSource(nodelink, track, prefix, query, cancel))
    const { winner, rest } = await raceToImmediate(freePromises)

    if (winner) {
      cancel.cancelled = true
      logResolved(track, winner.prefix, winner)
      return winner
    }

    const remaining = await Promise.all(rest.length ? rest : freePromises)
    for (const r of remaining) {
      if (r && (!globalBest || r.score > globalBest.score)) globalBest = r
    }
    if (globalBest && globalBest.score >= IMMEDIATE_USE) {
      cancel.cancelled = true
      logResolved(track, globalBest.prefix, globalBest)
      return globalBest
    }
  }

  for (const prefix of throttledSources) {
    if (cancel.cancelled) break
    const result = await searchSource(nodelink, track, prefix, query, cancel, true)
    if (!result) continue
    cancel.cancelled = true
    logResolved(track, result.prefix, result)
    return result
  }

  if (globalBest) {
    logResolved(track, globalBest.prefix, globalBest)
    return globalBest
  }

  log.warn('No valid mirror found')
  return null
}

export { mirror }
