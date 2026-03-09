/**
 * Brand Context — Brand Profile Builder
 *
 * Reads brand profiles from:
 * 1. Brand Guardian GitHub cache (shared across bots, 7-day TTL)
 * 2. Google Docs Client Info Doc (user provides the link)
 * 3. Website crawl + Claude analysis (fallback)
 */

const { google } = require('googleapis');
const { readBrandGuardianCache } = require('./connectors/github');
const { askClaudeLong, extractJson } = require('./connectors/claude');

// ─── Main Entry Point ───

/**
 * Get brand profile for a client.
 *
 * Priority:
 * 1. Brand Guardian GitHub cache (7-day TTL, shared across bots)
 * 2. Google Docs Client Info Doc (if URL provided)
 * 3. Website-only research (if URL provided)
 *
 * @param {string} clientName - Client name
 * @param {string} clientDocUrl - Google Docs URL for client info doc
 * @param {string} websiteUrl - Optional website URL for fallback
 * @param {function} progressCallback - Progress reporter
 * @returns {object|null} Brand profile or null
 */
async function getBrandProfile(clientName, clientDocUrl, websiteUrl, progressCallback) {
  const cacheKey = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Step 1: Check Brand Guardian cache
  if (progressCallback) await progressCallback('Checking Brand Guardian cache...');
  const cached = await readBrandGuardianCache(cacheKey);

  if (cached) {
    const cacheAge = cached.cachedAt ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;
    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

    if (cacheAge < CACHE_TTL) {
      if (progressCallback) await progressCallback(`Brand profile loaded from cache (${cached.clientName})`);
      return cached;
    }
  }

  // Step 2: Try Google Docs Client Info Doc
  if (clientDocUrl) {
    if (progressCallback) await progressCallback('Reading Client Info Doc from Google Docs...');

    try {
      const docContent = await readGoogleDoc(clientDocUrl);
      if (docContent) {
        if (progressCallback) await progressCallback('Parsing brand profile from Client Info Doc...');
        const profile = await parseDocToProfile(clientName, docContent);
        if (profile) {
          return { ...profile, clientName, cacheKey };
        }
      } else {
        console.error('Google Doc returned empty content');
        if (progressCallback) await progressCallback('Google Doc was empty or unreadable. Trying website fallback...');
      }
    } catch (err) {
      console.error('Google Doc read failed:', err.message);
      if (progressCallback) await progressCallback(`Could not read Google Doc: ${err.message}. Trying website fallback...`);
    }
  }

  // Step 3: Website-only research
  if (websiteUrl) {
    if (progressCallback) await progressCallback(`Running website research for ${websiteUrl}...`);
    const profile = await websiteOnlyResearch(clientName, websiteUrl, progressCallback);
    if (profile) {
      return { ...profile, clientName, cacheKey };
    }
  }

  // No profile found
  return null;
}

// ─── Google Docs Reader ───

/**
 * Extract document ID from a Google Docs URL.
 * Supports formats:
 *   https://docs.google.com/document/d/DOCUMENT_ID/edit
 *   https://docs.google.com/document/d/DOCUMENT_ID/
 *   https://docs.google.com/document/d/DOCUMENT_ID
 */
function extractGoogleDocId(url) {
  const match = (url || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Read a Google Doc's content as plain text using the Google Docs API.
 * Uses the same service account as Google Sheets.
 * The doc must be shared with the service account email or set to "anyone with link".
 */
async function readGoogleDoc(docUrl) {
  const docId = extractGoogleDocId(docUrl);
  if (!docId) {
    throw new Error(`Invalid Google Docs URL: ${docUrl}`);
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    try {
      creds = JSON.parse(raw.replace(/\\n/g, '\n'));
    } catch (e2) {
      throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_KEY');
    }
  }

  if (!creds.client_email || !creds.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY missing client_email or private_key');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
  });

  const docs = google.docs({ version: 'v1', auth });

  const response = await docs.documents.get({ documentId: docId });
  const doc = response.data;

  // Extract text content from the document body
  let text = '';
  if (doc.body?.content) {
    for (const element of doc.body.content) {
      text += extractTextFromElement(element);
    }
  }

  return text.trim() || null;
}

/**
 * Recursively extract text from a Google Docs structural element.
 */
function extractTextFromElement(element) {
  let text = '';

  if (element.paragraph) {
    for (const el of element.paragraph.elements || []) {
      if (el.textRun?.content) {
        text += el.textRun.content;
      }
    }
  }

  if (element.table) {
    for (const row of element.table.tableRows || []) {
      const cells = [];
      for (const cell of row.tableCells || []) {
        let cellText = '';
        for (const cellElement of cell.content || []) {
          cellText += extractTextFromElement(cellElement);
        }
        cells.push(cellText.trim());
      }
      text += cells.join(' | ') + '\n';
    }
  }

  if (element.sectionBreak) {
    text += '\n';
  }

  return text;
}

// ─── Doc → Profile Parser ───

async function parseDocToProfile(clientName, docContent) {
  try {
    const result = await askClaudeLong(
      `Parse this client's brand document into a structured profile. Extract everything relevant.

OUTPUT — valid JSON only, no markdown fences:
{
  "brandOverview": "string",
  "website": "string",
  "industry": "string",
  "targetAudience": { "primary": "", "secondary": "", "demographics": "", "psychographics": "" },
  "brandVoice": { "tone": "", "personality": "", "doNotSay": [], "preferredTerms": [] },
  "coreOfferings": { "products": [], "valueProposition": "", "keyBenefits": [], "pricingTier": "" },
  "competitors": [{"name": "", "differentiator": ""}],
  "competitiveDifferentiators": "",
  "contentThemes": { "onBrandTopics": [], "adjacentTopics": [], "offLimitTopics": [] },
  "keyMessages": [],
  "websiteInsights": { "contentStyle": "", "ctaPatterns": "", "socialProof": "", "mainPages": [] },
  "industryContext": ""
}`,
      `CLIENT: ${clientName}\n\nDOCUMENT:\n${docContent.slice(0, 20000)}`,
      { maxTokens: 5000, timeout: 90000 }
    );

    return extractJson(result);
  } catch (err) {
    console.error('parseDocToProfile failed:', err.message);
    return null;
  }
}

// ─── Website-Only Research ───

async function websiteOnlyResearch(clientName, websiteUrl, progressCallback) {
  if (!websiteUrl.startsWith('http')) websiteUrl = `https://${websiteUrl}`;
  const baseUrl = new URL(websiteUrl).origin;

  const pagePaths = ['/', '/about', '/about-us', '/services', '/products', '/solutions', '/pricing', '/features', '/how-it-works', '/blog'];
  const pages = [];

  for (const path of pagePaths) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'RedditStrategyBot/1.0' },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (resp.ok && resp.headers.get('content-type')?.includes('text/html')) {
        const html = await resp.text();
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);

        if (text.length > 100) {
          pages.push({ path, text });
        }
      }
    } catch (err) { /* skip */ }
    await new Promise(r => setTimeout(r, 300));
  }

  if (progressCallback) await progressCallback(`Crawled ${pages.length} pages. Analyzing...`);

  const websiteData = pages.map(p => `--- ${p.path} ---\n${p.text}`).join('\n\n').slice(0, 20000);

  try {
    const result = await askClaudeLong(
      `You are a Brand Research Specialist. Analyze this website and build a comprehensive brand profile.

OUTPUT — valid JSON only, no markdown fences:
{
  "brandOverview": "string",
  "website": "string",
  "industry": "string",
  "targetAudience": { "primary": "", "secondary": "", "demographics": "", "psychographics": "" },
  "brandVoice": { "tone": "", "personality": "", "doNotSay": [], "preferredTerms": [] },
  "coreOfferings": { "products": [], "valueProposition": "", "keyBenefits": [], "pricingTier": "" },
  "competitors": [{"name": "", "differentiator": ""}],
  "competitiveDifferentiators": "",
  "contentThemes": { "onBrandTopics": [], "adjacentTopics": [], "offLimitTopics": [] },
  "keyMessages": [],
  "websiteInsights": { "contentStyle": "", "ctaPatterns": "", "socialProof": "", "mainPages": [] },
  "industryContext": ""
}

Be specific and opinionated. Don't just say "professional" — say HOW they sound.`,
      `CLIENT: ${clientName}\nWEBSITE: ${websiteUrl}\n\n${websiteData}`,
      { maxTokens: 5000, timeout: 120000 }
    );

    return extractJson(result);
  } catch (err) {
    console.error('websiteOnlyResearch failed:', err.message);
    return null;
  }
}

module.exports = { getBrandProfile };
