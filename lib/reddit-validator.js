/**
 * Reddit Thread Validator
 *
 * Checks Reddit threads for:
 * - Archived status (posts older than 6 months can't receive new comments)
 * - Deleted/removed posts
 * - Locked threads (mod-locked, can't comment)
 * - NSFW content (avoid for brand safety)
 *
 * Uses Reddit's public JSON API (append .json to any Reddit URL).
 * No auth required, but rate-limited to ~10 req/min for unauthenticated.
 */

const REDDIT_USER_AGENT = 'AEOLabs-RedditStrategy/1.0 (by /u/aeo-labs)';
const RATE_DELAY_MS = 1500; // Stay well under Reddit's rate limit

/**
 * Validate a single Reddit thread URL.
 * Returns { valid, url, reason, details }
 */
async function validateThread(url) {
  const result = { valid: false, url, reason: '', details: {} };

  try {
    // Normalize URL and build JSON endpoint
    const jsonUrl = buildJsonUrl(url);
    if (!jsonUrl) {
      result.reason = 'invalid_url';
      return result;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch(jsonUrl, {
      headers: { 'User-Agent': REDDIT_USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (resp.status === 404) {
      result.reason = 'deleted';
      return result;
    }

    if (resp.status === 403) {
      result.reason = 'private_or_banned_subreddit';
      return result;
    }

    if (resp.status === 429) {
      result.reason = 'rate_limited';
      result.details.retryable = true;
      return result;
    }

    if (!resp.ok) {
      result.reason = `http_${resp.status}`;
      return result;
    }

    const data = await resp.json();

    // Reddit returns an array: [post_listing, comments_listing]
    const postData = data?.[0]?.data?.children?.[0]?.data;
    if (!postData) {
      result.reason = 'no_post_data';
      return result;
    }

    result.details = {
      title: postData.title,
      subreddit: postData.subreddit_name_prefixed || `r/${postData.subreddit}`,
      author: postData.author,
      created: new Date(postData.created_utc * 1000).toISOString(),
      ageInDays: Math.floor((Date.now() / 1000 - postData.created_utc) / 86400),
      score: postData.score,
      numComments: postData.num_comments,
      archived: postData.archived || false,
      locked: postData.locked || false,
      removed: postData.removed_by_category != null,
      deleted: postData.author === '[deleted]' || postData.selftext === '[deleted]',
      nsfw: postData.over_18 || false,
      quarantined: postData.quarantine || false,
      isRedditMedia: postData.is_reddit_media_domain || false,
      postType: postData.is_self ? 'text' : (postData.is_video ? 'video' : 'link'),
    };

    // ── Check disqualifiers ──

    if (result.details.deleted) {
      result.reason = 'deleted';
      return result;
    }

    if (result.details.removed) {
      result.reason = 'removed';
      return result;
    }

    if (result.details.archived) {
      result.reason = 'archived';
      return result;
    }

    if (result.details.locked) {
      result.reason = 'locked';
      return result;
    }

    if (result.details.quarantined) {
      result.reason = 'quarantined';
      return result;
    }

    if (result.details.nsfw) {
      result.reason = 'nsfw';
      return result;
    }

    // Extra safety: flag posts older than 5 months (approaching archive)
    if (result.details.ageInDays > 150) {
      result.reason = 'approaching_archive';
      result.details.warning = true;
      // Still valid but risky — mark as valid with warning
      result.valid = true;
      return result;
    }

    result.valid = true;
    result.reason = 'ok';
    return result;

  } catch (err) {
    if (err.name === 'AbortError') {
      result.reason = 'timeout';
    } else {
      result.reason = 'fetch_error';
      result.details.error = err.message;
    }
    return result;
  }
}

/**
 * Validate multiple Reddit thread URLs with rate limiting.
 * Returns { valid: [...], invalid: [...], summary }
 */
async function validateThreads(urls, options = {}) {
  const concurrency = options.concurrency || 3; // Parallel requests
  const results = { valid: [], invalid: [], warnings: [], summary: {} };

  // Process in batches of `concurrency`
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(url => validateThread(url)));

    for (const r of batchResults) {
      if (r.valid) {
        if (r.details?.warning) {
          results.warnings.push(r);
        }
        results.valid.push(r);
      } else {
        results.invalid.push(r);
      }
    }

    // Rate limit between batches
    if (i + concurrency < urls.length) {
      await new Promise(r => setTimeout(r, RATE_DELAY_MS));
    }
  }

  // Build summary
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

/**
 * Convert a Reddit URL to its JSON API endpoint.
 */
function buildJsonUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('reddit.com')) return null;

    // Strip query params and trailing slash
    let path = parsed.pathname.replace(/\/+$/, '');

    // Must be a post URL (contains /comments/)
    if (!path.includes('/comments/')) return null;

    return `https://www.reddit.com${path}.json?limit=1&raw_json=1`;
  } catch {
    return null;
  }
}

module.exports = {
  validateThread,
  validateThreads,
  buildJsonUrl,
};
