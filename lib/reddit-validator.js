/**
 * Reddit Thread Validator
 *
 * Checks Reddit threads for:
 * - Archived status (posts older than 6 months can't receive new comments)
 * - Deleted/removed posts
 * - Locked threads (mod-locked, can't comment)
 * - NSFW content (avoid for brand safety)
 *
 * Uses Reddit's OAuth API (oauth.reddit.com) for server-side access.
 * Requires: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET env vars.
 * Create a "script" app at https://www.reddit.com/prefs/apps
 */

const RATE_DELAY_MS = 1200; // ~50 req/min with OAuth

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get an OAuth2 access token using client credentials (application-only flow).
 * Reddit requires this for server-side API access.
 */
async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET must be set. Create a script app at https://www.reddit.com/prefs/apps');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AEOLabs-RedditValidator/1.0',
    },
    body: 'grant_type=client_credentials',
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit OAuth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  return cachedToken;
}

/**
 * Fetch from Reddit's OAuth API.
 */
async function redditApiFetch(path) {
  const token = await getAccessToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(`https://oauth.reddit.com${path}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'AEOLabs-RedditValidator/1.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Validate a single Reddit thread URL.
 * Returns { valid, url, reason, details }
 */
async function validateThread(url) {
  const result = { valid: false, url, reason: '', details: {} };

  try {
    const path = extractApiPath(url);
    if (!path) {
      result.reason = 'invalid_url';
      return result;
    }

    const resp = await redditApiFetch(`${path}?limit=1&raw_json=1`);

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
 * Returns { valid: [...], invalid: [...], warnings: [], summary }
 */
async function validateThreads(urls, options = {}) {
  const concurrency = options.concurrency || 3;
  const results = { valid: [], invalid: [], warnings: [], summary: {} };

  // Pre-warm the OAuth token
  try {
    await getAccessToken();
  } catch (err) {
    console.error('[Reddit Validator] OAuth failed:', err.message);
    // If OAuth fails, return all as "unchecked" valid (don't block pipeline)
    for (const url of urls) {
      results.valid.push({ valid: true, url, reason: 'oauth_unavailable', details: { unchecked: true } });
    }
    results.summary = { total: urls.length, valid: urls.length, invalid: 0, warnings: 0, invalidReasons: {}, note: 'OAuth unavailable — threads not validated' };
    return results;
  }

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
 * Extract the API path from a Reddit URL.
 * e.g. "https://reddit.com/r/SEO/comments/abc123/some_title" → "/r/SEO/comments/abc123/some_title"
 */
function extractApiPath(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('reddit.com')) return null;

    let path = parsed.pathname.replace(/\/+$/, '');
    if (!path.includes('/comments/')) return null;

    return path;
  } catch {
    return null;
  }
}

module.exports = {
  validateThread,
  validateThreads,
  extractApiPath,
  getAccessToken,
};
