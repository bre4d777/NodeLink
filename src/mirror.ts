const log = {
  info:  (msg: string) => console.log(`\x1b[32m[INFO]\x1b[0m  [Mirroring] ${msg}`),
  debug: (msg: string) => console.log(`\x1b[34m[DEBUG]\x1b[0m [Mirroring] ${msg}`),
  warn:  (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m  [Mirroring] ${msg}`),
}

const DURATION_TOLERANCE_MS = 3000
const MIN_SIMILARITY = 0.50
const HIGH_CONFIDENCE = 0.75
const IMMEDIATE_USE = 0.88

const WEIGHTS = {
  title: 0.50,
  artist: 0.30,
  duration: 0.20
}

interface Track {
  title?: string
  author?: string
  length?: number
  info?: {
    title?: string
    author?: string
    length?: number
  }
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
  const len1 = s1.length
  const len2 = s2.length
  const dp: number[][] = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0))
  for (let i = 0; i <= len1; i++) dp[i]![0] = i
  for (let j = 0; j <= len2; j++) dp[0]![j] = j
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost)
    }
  }
  return dp[len1]![len2]!
}

function stringSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0
  if (!s1 || !s2) return 0.0
  const n1 = normalize(s1)
  const n2 = normalize(s2)
  if (n1 === n2) return 1.0
  if (n1.includes(n2) || n2.includes(n1)) {
    const ratio = Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length)
    return 0.80 + (ratio * 0.15)
  }
  const maxLen = Math.max(n1.length, n2.length)
  if (maxLen === 0) return 1.0
  return 1.0 - levenshteinDistance(n1, n2) / maxLen
}

function durationSimilarity(d1: number, d2: number): number {
  if (d1 <= 0 || d2 <= 0) return 0.5
  const diff = Math.abs(d1 - d2)
  if (diff <= DURATION_TOLERANCE_MS) return 1.0
  return Math.max(0.0, 1.0 - diff / Math.max(d1, d2))
}

function scoreMatch(original: Track, candidate: Track): number {
  const origTitle = normalize(original.title || '')
  const candTitle = normalize(candidate.info?.title || candidate.title || '')

  let titleScore: number
  if (origTitle === candTitle) {
    titleScore = 1.0
  } else if (candTitle.startsWith(origTitle)) {
    titleScore = 0.95
  } else if (candTitle.includes(origTitle) || origTitle.includes(candTitle)) {
    const ratio = Math.min(origTitle.length, candTitle.length) / Math.max(origTitle.length, candTitle.length)
    titleScore = 0.82 + (ratio * 0.10)
  } else {
    titleScore = stringSimilarity(origTitle, candTitle)
  }

  const artistScore = stringSimilarity(
    original.author || '',
    candidate.info?.author || candidate.author || ''
  )

  const durScore = durationSimilarity(
    original.length || 0,
    candidate.info?.length || candidate.length || 0
  )

  return (titleScore * WEIGHTS.title) + (artistScore * WEIGHTS.artist) + (durScore * WEIGHTS.duration)
}

function rankCandidates(original: Track, candidates: Track[]): ScoredMatch[] {
  if (!candidates.length) return []
  const limit = Math.min(candidates.length, 10)
  const scored: ScoredMatch[] = []
  for (let i = 0; i < limit; i++) {
    const candidate = candidates[i]!
    const score = scoreMatch(original, candidate)
    scored.push({ match: candidate, score })
    log.debug(`Candidate ${i + 1}: "${candidate.info?.title || candidate.title}" | Score: ${score.toFixed(3)}`)
  }
  return scored.sort((a, b) => b.score - a.score)
}

async function validateStream(nodelink: any, match: Track): Promise<{ valid: boolean; streamInfo?: StreamInfo; error?: string }> {
  const title = match.info?.title ?? match.title ?? 'unknown'
  try {
    const streamInfo: StreamInfo | null = await nodelink.sources.getTrackUrl(match.info ?? match)
    if (!streamInfo || streamInfo.exception || !streamInfo.url) {
      const error = streamInfo?.exception?.message ?? 'Invalid or missing stream URL'
      log.debug(`Stream invalid for "${title}": ${error}`)
      return { valid: false, error }
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
  if (candidates.length === 0) {
    log.debug(`No candidates above threshold ${threshold.toFixed(2)}`)
    return null
  }
  for (const { match, score } of candidates) {
    const validation = await validateStream(nodelink, match)
    if (validation.valid) {
      log.info(`Match found: "${match.info?.title ?? match.title}" (score: ${score.toFixed(3)})`)
      return { match, score, streamInfo: validation.streamInfo }
    }
  }
  return null
}

async function mirror(nodelink: any, track: Track, mirroringSources?: string[]): Promise<(ScoredMatch & { prefix: string }) | null> {
  const sources: string[] = mirroringSources ?? ['ytmsearch', 'ytsearch']

  if (sources.length === 0) {
    log.warn('No providers available')
    return null
  }

  const query = track.author && track.author !== 'unknown'
    ? `${track.title} ${track.author}`
    : track.title ?? ''

  let globalBest: (ScoredMatch & { prefix: string }) | null = null

  for (let i = 0; i < sources.length; i++) {
    const prefix = sources[i]!

    log.debug(`[${prefix}] priority ${i} | query: "${query}"`)

    let searchResult: any
    try {
      searchResult = await nodelink.sources.search(prefix, query)
    } catch (e: any) {
      log.warn(`[${prefix}] search failed: ${e.message}`)
      continue
    }

    if (searchResult.loadType !== 'search' || !searchResult.data?.length) continue

    const ranked = rankCandidates(track, searchResult.data)
    if (!ranked.length) continue

    const top = ranked[0]!.score

    if (top >= IMMEDIATE_USE) {
      const result = await findBestValidMatch(nodelink, ranked.slice(0, 1), IMMEDIATE_USE)
      if (result) {
        log.info(`[${prefix}] Resolved: "${result.match.info?.title ?? result.match.title}" (score: ${result.score.toFixed(3)})`)
        return { ...result, prefix }
      }
    }

    const result = await findBestValidMatch(
      nodelink,
      ranked.slice(0, top >= HIGH_CONFIDENCE ? 2 : 3),
      top >= HIGH_CONFIDENCE ? HIGH_CONFIDENCE : MIN_SIMILARITY
    )

    if (result) {
      if (!globalBest || result.score > globalBest.score + 0.08) globalBest = { ...result, prefix }
      if (result.score >= IMMEDIATE_USE) {
        log.info(`[${prefix}] Resolved: "${result.match.info?.title ?? result.match.title}" (score: ${result.score.toFixed(3)})`)
        return { ...result, prefix }
      }
    }
  }

  if (globalBest) {
    log.info(`[${globalBest.prefix}] Resolved (global best): "${globalBest.match.info?.title || 'unknown'}" (score: ${globalBest.score.toFixed(3)})`)
    return globalBest
  }

  log.warn('No valid mirror found')
  return null
}

export { mirror }