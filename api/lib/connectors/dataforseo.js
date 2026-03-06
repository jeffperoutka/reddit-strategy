/**
 * DataForSEO Connector
 *
 * Uses SERP API to find Reddit threads ranking in Google for target keywords.
 * Auth: Basic auth with Base64 encoded login:password
 */

const BASE_URL = 'https://api.dataforseo.com/v3';

function getAuthHeader() {
  // Use pre-encoded Base64 if available, otherwise encode from login:password
  if (process.env.DATAFORSEO_AUTH_BASE64) {
    return `Basic ${process.env.DATAFORSEO_AUTH_BASE64}`;
  }
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('DataForSEO credentials not configured');
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

async function apiRequest(endpoint, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await resp.json();

    if (data.status_code !== 20000) {
      console.error('DataForSEO error:', data.status_message);
      throw new Error(`DataForSEO: ${data.status_message || 'Unknown error'}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Search Google SERP for Reddit threads about a keyword.
 * Uses "site:reddit.com" to filter to Reddit only.
 *
 * @param {string} keyword - The search keyword
 * @param {object} options - Search options
 * @returns {Array} Array of Reddit thread results
 */
async function searchRedditThreads(keyword, options = {}) {
  const searchQuery = `${keyword} site:reddit.com`;
  const depth = options.depth || 30; // How many results to scan

  try {
    const data = await apiRequest('/serp/google/organic/live/regular', [{
      keyword: searchQuery,
      location_code: options.locationCode || 2840, // US
      language_code: options.languageCode || 'en',
      depth,
      se_domain: 'google.com',
    }]);

    const results = data.tasks?.[0]?.result?.[0]?.items || [];

    // Filter to only reddit.com results and extract useful data
    const redditResults = results
      .filter(item => item.type === 'organic' && item.domain?.includes('reddit.com'))
      .map(item => ({
        url: item.url,
        title: item.title,
        description: item.description || '',
        breadcrumb: item.breadcrumb || '',
        position: item.rank_absolute,
        subreddit: extractSubreddit(item.url),
      }));

    return redditResults;
  } catch (err) {
    console.error(`searchRedditThreads("${keyword}") error:`, err.message);
    return [];
  }
}

/**
 * Search for AI citation data — which Reddit threads are being cited by AI engines.
 * Uses DataForSEO's AI Overview data when available.
 */
async function searchAICitations(keyword, options = {}) {
  try {
    const data = await apiRequest('/serp/google/organic/live/regular', [{
      keyword,
      location_code: options.locationCode || 2840,
      language_code: options.languageCode || 'en',
      depth: 20,
      se_domain: 'google.com',
    }]);

    const results = data.tasks?.[0]?.result?.[0]?.items || [];

    // Look for AI overview items that reference Reddit
    const aiItems = results.filter(item =>
      item.type === 'ai_overview' ||
      item.type === 'featured_snippet' ||
      item.type === 'people_also_ask'
    );

    // Also get organic Reddit results with their ranking positions
    const organicReddit = results
      .filter(item => item.type === 'organic' && item.domain?.includes('reddit.com'))
      .map(item => ({
        url: item.url,
        title: item.title,
        position: item.rank_absolute,
        subreddit: extractSubreddit(item.url),
      }));

    return {
      aiOverview: aiItems,
      redditInOrganic: organicReddit,
      totalResults: results.length,
    };
  } catch (err) {
    console.error(`searchAICitations("${keyword}") error:`, err.message);
    return { aiOverview: [], redditInOrganic: [], totalResults: 0 };
  }
}

/**
 * Batch search multiple keywords for Reddit threads.
 * Deduplicates URLs across keywords.
 *
 * @param {string[]} keywords - Array of keywords to search
 * @param {object} options - Search options
 * @returns {Array} Deduplicated array of Reddit threads with keyword attribution
 */
async function batchSearchReddit(keywords, options = {}) {
  const urlMap = new Map(); // url -> thread data with all matching keywords

  for (const keyword of keywords.slice(0, 10)) { // Cap at 10 keywords
    const results = await searchRedditThreads(keyword, options);

    for (const result of results) {
      if (urlMap.has(result.url)) {
        const existing = urlMap.get(result.url);
        existing.keywords.push(keyword);
        existing.totalScore += scoreResult(result);
      } else {
        urlMap.set(result.url, {
          ...result,
          keywords: [keyword],
          totalScore: scoreResult(result),
        });
      }
    }

    // Small delay between requests to be respectful
    await new Promise(r => setTimeout(r, 500));
  }

  // Sort by totalScore (higher = better) and return top results
  return Array.from(urlMap.values())
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 25); // Cap at 25 threads
}

/**
 * Score a search result based on position
 */
function scoreResult(result) {
  // Higher score for higher ranking position
  const positionScore = Math.max(0, 31 - (result.position || 30));
  return positionScore;
}

/**
 * Extract subreddit name from a Reddit URL
 */
function extractSubreddit(url) {
  const match = url?.match(/reddit\.com\/r\/([^\/]+)/);
  return match ? `r/${match[1]}` : 'unknown';
}

/**
 * Get DataForSEO account balance
 */
async function getBalance() {
  try {
    const resp = await fetch(`${BASE_URL}/appendix/user_data`, {
      method: 'GET',
      headers: { 'Authorization': getAuthHeader() },
    });
    const data = await resp.json();
    return data.tasks?.[0]?.result?.[0]?.money?.balance || 0;
  } catch (err) {
    console.error('getBalance error:', err.message);
    return null;
  }
}

module.exports = {
  searchRedditThreads,
  searchAICitations,
  batchSearchReddit,
  getBalance,
  extractSubreddit,
};
