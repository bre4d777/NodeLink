const log = {
  info:  (msg: string) => console.log(`\x1b[32m[INFO]\x1b[0m  [Mirroring] ${msg}`),
  debug: (msg: string) => console.log(`\x1b[34m[DEBUG]\x1b[0m [Mirroring] ${msg}`),
  warn:  (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m  [Mirroring] ${msg}`),
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
  const scored: ScoredMatch[] = candidates.slice(0, 10).map((match, i) => {
    const score = scoreMatch(original, match)
    log.debug(`Candidate ${i + 1}: "${match.info?.title || match.title}" | Score: ${score.toFixed(3)}`)
    return { match, score }
  })
  return scored.sort((a, b) => b.score - a.score)
}

async function validateStream(nodelink: any, match: Track): Promise<{ valid: boolean; streamInfo?: StreamInfo; error?: string }> {
  const title = match.info?.title ?? match.title ?? 'unknown'
  try {
    const streamInfo: StreamInfo | null = await nodelink.sources.getTrackUrl(match.info ?? match)
    if (!streamInfo || streamInfo.exception || !streamInfo.url) {
      log.debug(`Stream invalid for "${title}": ${streamInfo?.exception?.message ?? 'no url'}`)
      return { valid: false, error: streamInfo?.exception?.message ?? 'Invalid or missing stream URL' }
    }
    log.debug(`Stream validated for "${title}": ${streamInfo.url}`)
    return { valid: true, streamInfo }
  } catch (e: any) {
    log.debug(`Stream exception for "${title}": ${e.message}`)
    return { valid: false, error: e.message }
  }
}

async function findBestValidMatch(nodelink: any, scoredMatches: ScoredMatch[], threshold: number): Promise<ScoredMatch | null> {
  const candidates = scoredMatches.filter(({ score }) => score >= threshold)
  if (!candidates.length) {
    log.debug(`No candidates above threshold ${threshold.toFixed(2)}`)
    return null
  }
  for (const { match, score } of candidates) {
    const { valid, streamInfo } = await validateStream(nodelink, match)
    if (valid) {
      log.info(`Match found: "${match.info?.title ?? match.title}" (score: ${score.toFixed(3)})`)
      return { match, score, streamInfo }
    }
  }
  return null
}

async function searchSource(nodelink: any, track: Track, prefix: string, priority: number, query: string): Promise<(ScoredMatch & { prefix: string }) | null> {
  log.debug(`[${prefix}] priority ${priority} | query: "${query}"`)
  let searchResult: any
  try {
    searchResult = await nodelink.sources.search(prefix, query)
  } catch (e: any) {
    log.warn(`[${prefix}] search failed: ${e.message}`)
    return null
  }
  if (searchResult.loadType !== 'search' || !searchResult.data?.length) return null

  const ranked = rankCandidates(track, searchResult.data)
  if (!ranked.length) return null
  const top = ranked[0]!.score

  const result = await findBestValidMatch(
    nodelink,
    ranked.slice(0, top >= IMMEDIATE_USE ? 1 : top >= HIGH_CONFIDENCE ? 2 : 3),
    top >= IMMEDIATE_USE ? IMMEDIATE_USE : top >= HIGH_CONFIDENCE ? HIGH_CONFIDENCE : MIN_SIMILARITY
  )
  if (!result) return null
  log.info(`[${prefix}] Resolved: "${result.match.info?.title ?? result.match.title}" (score: ${result.score.toFixed(3)})`)
  return { ...result, prefix }
}

async function raceToImmediate(promises: Promise<(ScoredMatch & { prefix: string }) | null>[]): Promise<{
  winner: (ScoredMatch & { prefix: string }) | null
  rest: Promise<(ScoredMatch & { prefix: string }) | null>[]
}> {
  return new Promise(resolve => {
    const remaining = [...promises]
    let settled = 0
    const results: ((ScoredMatch & { prefix: string }) | null)[] = []

    promises.forEach((p, i) => {
      p.then(result => {
        settled++
        results[i] = result
        if (result?.score !== undefined && result.score >= IMMEDIATE_USE) {
          resolve({ winner: result, rest: remaining.filter((_, j) => j !== i) })
        } else if (settled === promises.length) {
          resolve({ winner: null, rest: [] })
        }
      }).catch(() => {
        settled++
        results[i] = null
        if (settled === promises.length) resolve({ winner: null, rest: [] })
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

  const freeSources     = sources.filter(s => !THROTTLED_SOURCES.has(s))
  const throttledSources = sources.filter(s => THROTTLED_SOURCES.has(s))

  let globalBest: (ScoredMatch & { prefix: string }) | null = null

  if (freeSources.length) {
    const freePromises = freeSources.map((prefix, i) => searchSource(nodelink, track, prefix, i, query))
    const { winner, rest } = await raceToImmediate(freePromises)

    if (winner) return winner

    const remaining = await Promise.all(rest.length ? rest : freePromises)
    for (const r of remaining) {
      if (r && (!globalBest || r.score > globalBest.score)) globalBest = r
    }
    if (globalBest?.score !== undefined && globalBest.score >= IMMEDIATE_USE) return globalBest
  }

  for (let i = 0; i < throttledSources.length; i++) {
    const result = await searchSource(nodelink, track, throttledSources[i]!, freeSources.length + i, query)
    if (!result) continue
    if (result.score >= IMMEDIATE_USE) return result
    if (!globalBest || result.score > globalBest.score + 0.08) globalBest = result
  }

  if (globalBest) {
    log.info(`[${globalBest.prefix}] Resolved (global best): "${globalBest.match.info?.title || 'unknown'}" (score: ${globalBest.score.toFixed(3)})`)
    return globalBest
  }

  log.warn('No valid mirror found')
  return null
}

export { mirror }