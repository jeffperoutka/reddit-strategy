/**
 * Brand Context — Integration with Brand Guardian
 *
 * Reads brand profiles from Brand Guardian's GitHub cache.
 * If no cached profile exists, attempts to build one using the same
 * pattern as Brand Guardian (ClickUp + website crawl + Claude analysis).
 *
 * This module shares the Brand Guardian's cache — when Brand Guardian
 * builds a profile, Reddit Strategy can read it immediately, and vice versa.
 */

const { readBrandGuardianCache } = require('./connectors/github');
const { askClaudeLong, extractJson } = require('./connectors/claude');

// ─── Main Entry Point ───

/**
 * Get brand profile for a client.
 *
 * Priority:
 * 1. Brand Guardian GitHub cache (7-day TTL, shared across bots)
 * 2. ClickUp Client Info Doc → parse into profile
 * 3. Website-only research (if URL provided)
 *
 * @param {string} clientName - Client name
 * @param {string} websiteUrl - Optional website URL for new clients
 * @param {function} progressCallback - Progress reporter
 * @returns {object|null} Brand profile or null
 */
async function getBrandProfile(clientName, websiteUrl, progressCallback) {
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

  // Step 2: Try ClickUp Client Info Doc
  const cuToken = process.env.CLICKUP_API_TOKEN;
  const wsId = process.env.CLICKUP_WORKSPACE_ID;

  if (cuToken && wsId) {
    if (progressCallback) await progressCallback('Searching ClickUp for Client Info Doc...');

    const docInfo = await findClientInfoDoc(clientName, cuToken, wsId);
    if (docInfo) {
      if (progressCallback) await progressCallback(`Found "${docInfo.docName}". Reading content...`);
      const docContent = await readDocContent(docInfo.docId, cuToken, wsId);

      if (docContent) {
        if (progressCallback) await progressCallback('Parsing brand profile from Client Info Doc...');
        const profile = await parseDocToProfile(clientName, docContent);
        if (profile) {
          return { ...profile, clientName, cacheKey };
        }
      } else {
        // Doc found but content fetch failed — log and continue to website fallback
        console.error(`ClickUp doc "${docInfo.docName}" (${docInfo.docId}) found but content fetch returned empty`);
        if (progressCallback) await progressCallback(`ClickUp doc found but content couldn't be read. Trying website fallback...`);
      }
    }
  }

  // Step 3: Website-only research
  if (websiteUrl) {
    if (progressCallback) await progressCallback(`No cached profile. Running website research for ${websiteUrl}...`);
    const profile = await websiteOnlyResearch(clientName, websiteUrl, progressCallback);
    if (profile) {
      return { ...profile, clientName, cacheKey };
    }
  }

  // No profile found
  return null;
}

// ─── ClickUp Helpers ───

// Client Info Docs folder ID in ClickUp "Client Delivery" space
const CLIENT_INFO_DOCS_FOLDER_ID = '901812024928';

async function findClientInfoDoc(clientName, token, workspaceId) {
  try {
    // Use v3 docs list API (search endpoint returns 404 with personal tokens)
    const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs`, {
      headers: { 'Authorization': token },
    });

    if (!resp.ok) {
      console.error('findClientInfoDoc: docs list failed', resp.status);
      return null;
    }

    const data = await resp.json();
    const clientDocs = (data.docs || []).filter(doc =>
      doc.parent?.id === CLIENT_INFO_DOCS_FOLDER_ID &&
      !doc.deleted &&
      doc.name &&
      !doc.name.toLowerCase().includes('template') &&
      !doc.name.toLowerCase().includes('definitions')
    );

    // Match by client name (fuzzy — check if client name appears in doc name)
    const clientLower = clientName.toLowerCase().trim();
    const match = clientDocs.find(doc => {
      const docName = doc.name.toLowerCase();
      return docName.includes(clientLower) ||
        clientLower.includes(docName.replace(/\s*(client\s+)?info(\s+doc)?$/i, '').trim());
    });

    if (match) {
      return { docId: match.id, docName: match.name };
    }

    console.log(`findClientInfoDoc: no match for "${clientName}" among ${clientDocs.length} docs`);
    return null;
  } catch (err) {
    console.error('findClientInfoDoc error:', err.message);
    return null;
  }
}

async function readDocContent(docId, token, workspaceId) {
  try {
    // Use page_listing endpoint to get page IDs
    const listResp = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/page_listing`,
      { headers: { 'Authorization': token } }
    );

    if (!listResp.ok) {
      console.error(`readDocContent: page_listing failed for doc ${docId} — status ${listResp.status}`);
      // Fallback: try the pages endpoint directly
      return await readDocContentFallback(docId, token, workspaceId);
    }

    const listData = await listResp.json();
    // Response may be a raw array or {pages: [...]}
    const pageList = Array.isArray(listData) ? listData : (listData.pages || []);

    if (!pageList.length) {
      console.error(`readDocContent: doc ${docId} has no pages in listing`);
      return null;
    }

    console.log(`readDocContent: found ${pageList.length} pages for doc ${docId}`);

    // Collect all page IDs (flatten any nested sub-pages)
    const pageIds = [];
    const collectIds = (pages) => {
      for (const p of pages) {
        if (p.id) pageIds.push(p.id);
        if (p.pages?.length) collectIds(p.pages);
        if (p.children?.length) collectIds(p.children);
      }
    };
    collectIds(pageList);

    // Read each page's content using the correct query param: description_format
    let allContent = '';
    let pagesRead = 0;
    for (const pageId of pageIds.slice(0, 10)) {
      try {
        const pageResp = await fetch(
          `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}?description_format=text/md`,
          { headers: { 'Authorization': token } }
        );
        if (pageResp.ok) {
          const pageData = await pageResp.json();
          const content = pageData.content || '';
          if (content) {
            allContent += `\n\n${content}`;
            pagesRead++;
          }
        } else {
          const errText = await pageResp.text().catch(() => '');
          console.error(`readDocContent: page ${pageId} failed — status ${pageResp.status} — ${errText.slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`readDocContent: page ${pageId} error:`, err.message);
      }
    }

    console.log(`readDocContent: read ${pagesRead}/${pageIds.length} pages for doc ${docId}`);
    return allContent.trim() || null;
  } catch (err) {
    console.error('readDocContent error:', err.message);
    return null;
  }
}

// Fallback: try fetching pages directly (handles different API response shapes)
async function readDocContentFallback(docId, token, workspaceId) {
  try {
    const pagesResp = await fetch(
      `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages`,
      { headers: { 'Authorization': token } }
    );

    if (!pagesResp.ok) {
      console.error(`readDocContentFallback: pages failed for doc ${docId} — status ${pagesResp.status}`);
      return null;
    }

    const rawData = await pagesResp.json();
    // Response may be a raw array or {pages: [...]}
    const pages = Array.isArray(rawData) ? rawData : (rawData.pages || []);

    if (!pages.length) {
      console.error(`readDocContentFallback: doc ${docId} returned no pages. Response keys: ${Object.keys(rawData)}`);
      return null;
    }

    // The pages endpoint may already include content
    let allContent = '';
    let pagesRead = 0;
    for (const page of pages.slice(0, 10)) {
      if (page.content) {
        allContent += `\n\n${page.content}`;
        pagesRead++;
      } else if (page.id) {
        // No inline content — fetch individually
        try {
          const pageResp = await fetch(
            `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${page.id}?description_format=text/md`,
            { headers: { 'Authorization': token } }
          );
          if (pageResp.ok) {
            const pageData = await pageResp.json();
            if (pageData.content) {
              allContent += `\n\n${pageData.content}`;
              pagesRead++;
            }
          }
        } catch (err) {
          console.error(`readDocContentFallback: page ${page.id} error:`, err.message);
        }
      }
    }

    console.log(`readDocContentFallback: read ${pagesRead}/${pages.length} pages for doc ${docId}`);
    return allContent.trim() || null;
  } catch (err) {
    console.error('readDocContentFallback error:', err.message);
    return null;
  }
}

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
