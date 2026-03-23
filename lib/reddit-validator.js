/**
 * Reddit Thread Validator
 *
 * Checks Reddit threads for:
 * - Archived status (posts older than 6 months can't receive new comments)
 * - Deleted/removed posts (via oEmbed check)
 *
 * No Reddit OAuth required. Uses two techniques:
 * 1. Post ID age estimation (Reddit IDs are sequential base36, map to creation time)
 * 2. oEmbed endpoint check (works without auth, detects deleted/removed posts)
 */

const MAX_AGE_DAYS = 150; // 5 months — safe buffer before 6-month archive
const ARCHIVE_AGE_DAYS = 180; // Reddit archives at 6 months
const RATE_DELAY_MS = 1500;

// ── Age estimation from post ID ──
// Reddit post IDs are roughly sequential base36 numbers.
// Calibrated with known reference: post ID "1japksh" was active on 2026-03-16.
const REF_ID_NUM = parseInt('1japksh', 36); // 3343629185
const REF_TIMESTAMP = 1773663000; // 2026-03-16 ~12:10 UTC
const SEC_PER_ID_UNIT = 0.133; // seconds per base36 increment (empirically calibrated)

/**
 * Estimate post creation date from its Reddit ID.
 */
function estimatePostAge(postId) {
  const num = parseInt(postId, 36);
  if (isNaN(num)) return { ageInDays: 999, confidence: 'none' };

  const estimatedTs = REF_TIMESTAMP + (num - REF_ID_NUM) * SEC_PER_ID_UNIT;
  const now = Date.now() / 1000;
  const ageInDays = Math.floor((now - estimatedTs) / 86400);

  // Confidence based on distance from reference
  const distance = Math.abs(num - REF_ID_NUM);
  const confidence = distance < 100000000 ? 'high' : distance < 500000000 ? 'medium' : 'low';

  return {
    ageInDays: Math.max(0, ageInDays),
    estimatedDate: new Date(estimatedTs * 1000).toISOString().split('T')[0],
    confidence,
  };
}

/**
 * Extract the post ID from a Reddit URL.
 * e.g. "https://reddit.com/r/SEO/comments/1japksh/title" → "1japksh"
 */
function extractPostId(url) {
  const match = url?.match(/\/comments\/([a-z0-9]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Check if a thread is still accessible via Reddit's oEmbed endpoint.
 * No OAuth required. Returns null if check fails.
 */
async function checkOEmbed(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(
      `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      {
        headers: { 'User-Agent': 'AEOLabs-Validator/1.0' },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (resp.status === 404 || resp.status === 400) {
      return { accessible: false, reason: 'not_found' };
    }
    if (resp.status === 403 || resp.status === 429) {
      return null; // Blocked or rate limited — can't determine
    }
    if (!resp.ok) return null;

    const data = await resp.json();
    if (data.title && data.author_name) {
      return { accessible: true, title: data.title, author: data.author_name };
    }
    // oEmbed returned empty data — likely deleted
    return { accessible: false, reason: 'empty_response' };
  } catch {
    return null; // Network error — can't determine
  }
}

/**
 * Check if a Reddit thread is locked or archived via the JSON API.
 * Returns { locked, archived } or null if check fails.
 */
async function checkThreadLocked(url) {
  try {
    // Convert URL to Reddit JSON endpoint
    let jsonUrl = url.replace(/\/$/, '') + '.json';
    // Ensure it uses www.reddit.com
    jsonUrl = jsonUrl.replace('://reddit.com', '://www.reddit.com');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(jsonUrl, {
      headers: { 'User-Agent': 'AEOLabs-Validator/1.0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;

    const data = await resp.json();

    // Reddit JSON returns an array: [listing, comments]
    // The first element contains the post data
    const postData = data?.[0]?.data?.children?.[0]?.data;
    if (!postData) return null;

    return {
      locked: !!postData.locked,
      archived: !!postData.archived,
      num_comments: postData.num_comments || 0,
      score: postData.score || 0,
    };
  } catch {
    return null; // Network error — can't determine
  }
}

/**
 * Validate a single Reddit thread URL.
 * Returns { valid, url, reason, details }
 */
async function validateThread(url) {
  const result = { valid: false, url, reason: '', details: {} };

  // ── Layer 1: URL structure check ──
  const postId = extractPostId(url);
  if (!postId) {
    result.reason = 'invalid_url';
    return result;
  }

  // ── Layer 2: Age-based filter ──
  const age = estimatePostAge(postId);
  result.details.postId = postId;
  result.details.estimatedAge = age.ageInDays;
  result.details.estimatedDate = age.estimatedDate;
  result.details.ageConfidence = age.confidence;

  if (age.ageInDays > ARCHIVE_AGE_DAYS) {
    result.reason = 'archived';
    result.details.note = `Post is ~${age.ageInDays} days old (archived after ${ARCHIVE_AGE_DAYS} days)`;
    return result;
  }

  if (age.ageInDays > MAX_AGE_DAYS) {
    // Approaching archive — valid but with warning
    result.reason = 'approaching_archive';
    result.details.warning = true;
    result.details.note = `Post is ~${age.ageInDays} days old (archive at ${ARCHIVE_AGE_DAYS} days)`;
    result.valid = true;
    return result;
  }

  // ── Layer 3: oEmbed accessibility check (detect deleted/removed) ──
  const oembed = await checkOEmbed(url);
  if (oembed !== null) {
    result.details.oembedCheck = oembed.accessible ? 'accessible' : oembed.reason;
    if (!oembed.accessible) {
      result.reason = 'deleted_or_removed';
      return result;
    }
    if (oembed.title) result.details.title = oembed.title;
  } else {
    result.details.oembedCheck = 'unavailable';
    // oEmbed check failed — still pass the thread (don't block on network issues)
  }

  // ── Layer 4: Locked thread check (via Reddit JSON API) ──
  const lockCheck = await checkThreadLocked(url);
  if (lockCheck !== null) {
    result.details.locked = lockCheck.locked;
    result.details.archived_reddit = lockCheck.archived;
    if (lockCheck.locked) {
      result.reason = 'locked';
      result.valid = false;
      result.details.note = 'Thread is locked by moderators — cannot comment';
      return result;
    }
    if (lockCheck.archived) {
      result.reason = 'archived';
      result.valid = false;
      result.details.note = 'Thread is archived by Reddit — cannot comment';
      return result;
    }
  }

  result.valid = true;
  result.reason = 'ok';
  return result;
}

/**
 * Validate multiple Reddit thread URLs with rate limiting.
 * Returns { valid: [...], invalid: [...], warnings: [], summary }
 */
async function validateThreads(urls, options = {}) {
  const concurrency = options.concurrency || 3;
  const results = { valid: [], invalid: [], warnings: [], summary: {} };

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(url => validateThread(url)));

    for (const r of batchResults) {
      if (r.valid) {
        if (r.details?.warning) results.warnings.push(r);
        results.valid.push(r);
      } else {
        results.invalid.push(r);
      }
    }

    if (i + concurrency < urls.length) {
      await new Promise(r => setTimeout(r, RATE_DELAY_MS));
    }
  }

  const reasons = {};
  for (const r of results.invalid) {
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }

  results.summary = {
    total: urls.length,
    valid: results.valid.length,
    invalid: results.invalid.length,
    warnings: results.warnings.length,
    invalidReasons: reasons,
  };

  console.log(`[Reddit Validator] ${results.summary.valid}/${results.summary.total} threads valid, ${results.summary.invalid} filtered out`, reasons);

  return results;
}

module.exports = {
  validateThread,
  validateThreads,
  extractPostId,
  estimatePostAge,
};
