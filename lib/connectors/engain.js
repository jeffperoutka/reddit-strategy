/**
 * Engain API Connector
 *
 * Handles all communication with the Engain Reddit execution platform.
 * Docs: https://docs.engain.io/
 *
 * Auth: X-API-Key header (env: ENGAIN_API_KEY)
 * Rate limit: 30 req/min
 */

const BASE_URL = 'https://api.engain.io/api/v1';

function getApiKey() {
  const key = process.env.ENGAIN_API_KEY;
  if (!key) throw new Error('ENGAIN_API_KEY not set');
  return key;
}

async function engainFetch(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'X-API-Key': getApiKey(),
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const data = await resp.json();

  if (!resp.ok) {
    const msg = data?.message || data?.error || `HTTP ${resp.status}`;
    const err = new Error(`Engain ${method} ${path}: ${msg}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

// ── Identity & Balance ──

async function getMe() {
  return engainFetch('GET', '/me');
}

async function getBalance() {
  return engainFetch('GET', '/balance');
}

// ── Task Creation ──

/**
 * Post a comment on a Reddit thread.
 * @param {string} projectId - Engain project ID
 * @param {string} url - Reddit post URL
 * @param {string} content - Comment text
 * @param {string} [scheduledAt] - ISO 8601 datetime (optional)
 */
async function createComment(projectId, url, content, scheduledAt) {
  const body = { projectId, url, content };
  if (scheduledAt) body.scheduledAt = scheduledAt;
  return engainFetch('POST', '/tasks/comment', body);
}

/**
 * Create a new Reddit post.
 * @param {string} projectId - Engain project ID
 * @param {string} subredditUrl - e.g. "https://reddit.com/r/technology/"
 * @param {string} postTitle - Post title
 * @param {string} content - Post body text
 * @param {string} [scheduledAt] - ISO 8601 datetime (optional)
 */
async function createPost(projectId, subredditUrl, postTitle, content, scheduledAt) {
  const body = { projectId, subredditUrl, postTitle, content };
  if (scheduledAt) body.scheduledAt = scheduledAt;
  return engainFetch('POST', '/tasks/post', body);
}

/**
 * Reply to a Reddit comment (for follow-up comments on posts).
 * @param {string} projectId - Engain project ID
 * @param {string} url - Reddit comment permalink URL
 * @param {string} content - Reply text
 * @param {string} [scheduledAt] - ISO 8601 datetime (optional)
 */
async function createReply(projectId, url, content, scheduledAt) {
  const body = { projectId, url, content };
  if (scheduledAt) body.scheduledAt = scheduledAt;
  return engainFetch('POST', '/tasks/reply', body);
}

/**
 * Submit upvotes on a Reddit post or comment.
 * @param {string} projectId - Engain project ID
 * @param {string} url - Reddit post or comment URL
 * @param {number} quantity - 1–2000
 * @param {string} target - "post" or "comment"
 * @param {object} [opts] - { scheduledAt, upvotesPerDay (1-6, default 5) }
 */
async function createUpvote(projectId, url, quantity, target, opts = {}) {
  const body = { projectId, url, quantity, target };
  if (opts.scheduledAt) body.scheduledAt = opts.scheduledAt;
  if (opts.upvotesPerDay) body.upvotesPerDay = opts.upvotesPerDay;
  return engainFetch('POST', '/tasks/upvote', body);
}

// ── Task Tracking ──

async function getTask(taskId) {
  return engainFetch('GET', `/tasks/${taskId}`);
}

async function listTasks(projectId, opts = {}) {
  const params = new URLSearchParams({ projectId });
  if (opts.numItems) params.set('numItems', String(opts.numItems));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.status) params.set('status', opts.status);
  return engainFetch('GET', `/tasks?${params}`);
}

async function getBulkTasks(projectId, ids) {
  const params = new URLSearchParams({ projectId, ids: ids.join(',') });
  return engainFetch('GET', `/tasks/bulk?${params}`);
}

// ── Order Tracking ──

async function getOrder(orderId) {
  return engainFetch('GET', `/orders/${orderId}`);
}

async function listOrders(projectId, opts = {}) {
  const params = new URLSearchParams({ projectId });
  if (opts.numItems) params.set('numItems', String(opts.numItems));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.status) params.set('status', opts.status);
  if (opts.campaignId) params.set('campaignId', opts.campaignId);
  return engainFetch('GET', `/orders?${params}`);
}

module.exports = {
  getMe,
  getBalance,
  createComment,
  createPost,
  createReply,
  createUpvote,
  getTask,
  listTasks,
  getBulkTasks,
  getOrder,
  listOrders,
};
