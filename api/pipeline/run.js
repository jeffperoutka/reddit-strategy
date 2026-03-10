/**
 * Pipeline Runner — Phase 1: Research & Analysis
 *
 * Handles: brand profile → keywords → DataForSEO → thread analysis
 * Then triggers Phase 2 (/api/pipeline/generate) with intermediate data.
 *
 * Each phase gets its own Vercel function with 300s maxDuration = 600s total.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { extractKeywords, discoverThreads, checkAICitations, analyzeThreads } = require('../../lib/engine');
const { getPackage } = require('../../lib/packages');
const { getBrandProfile } = require('../../lib/brand-context');

const PIPELINE_SECRET = process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-pipeline-secret'];
  if (secret !== PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(202).json({ status: 'accepted' });

  waitUntil(executePhase1(req, req.body).catch(err => {
    console.error('FATAL: Phase 1 crashed:', err.message, err.stack);
    const { channel, threadTs, userId } = req.body || {};
    if (channel && threadTs) {
      slack.postMessage(channel, `Pipeline crashed (phase 1): ${err.message}`, { threadTs }).catch(() => {});
    } else if (userId) {
      slack.openDM(userId).then(ch =>
        slack.postMessage(ch, `Strategy run crashed: ${err.message}`)
      ).catch(() => {});
    }
  }));
};

async function executePhase1(req, params) {
  const {
    clientName, clientDocUrl, packageTier,
    customKeywords, campaignMonth, prevSpreadsheetUrl,
    channel, threadTs, progressTs, userId,
  } = params;

  const runStart = Date.now();
  const elapsed = () => ((Date.now() - runStart) / 1000).toFixed(1);
  const pkg = getPackage(packageTier);

  const updateProgress = async (stepText) => {
    try {
      console.log(`[Phase1 ${elapsed()}s] ${stepText}`);
      if (channel && progressTs) {
        await slack.updateMessage(channel, progressTs, stepText);
      }
    } catch (err) {
      console.error('Progress update failed:', err.message);
    }
  };

  const threadPost = async (text) => {
    if (channel && threadTs) {
      return slack.postMessage(channel, text, { threadTs });
    }
  };

  try {
    // ── Phase 1: Research & Analysis ──

    // Step 1: Brand profile
    await updateProgress('Loading brand profile...');
    const brandProfile = await getBrandProfile(clientName, clientDocUrl, null, updateProgress);

    if (!brandProfile) {
      const hint = 'Could not read the Google Doc. Check sharing permissions (must be shared with the service account).';
      await updateProgress(`Could not load brand profile for "${titleCase(clientName)}". ${hint}`);
      return;
    }
    await updateProgress('Brand profile loaded.');

    // Step 2: Keywords
    await updateProgress('Extracting target keywords...');
    const keywords = await extractKeywords(brandProfile, packageTier, customKeywords);
    await updateProgress(`Found ${keywords.length} keywords: ${keywords.join(', ')}`);

    // Step 3: Discover threads
    await updateProgress(`Searching Google for Reddit threads across ${keywords.length} keywords...`);
    const threads = await discoverThreads(keywords, packageTier);
    await updateProgress(`Discovered ${threads.length} Reddit threads`);

    // Step 4: AI citations (Package B & C only)
    let aiCitations = [];
    if (pkg?.features?.aiCitationCheck) {
      await updateProgress('Checking AI citation data...');
      aiCitations = await checkAICitations(keywords);
    }

    // Step 5: Analyze threads
    let threadAnalysis = { analyzedThreads: [], subredditMap: {}, topThemes: [], competitorPresence: '' };
    if (threads.length > 0) {
      await updateProgress(`Analyzing ${threads.length} threads for opportunities...`);
      threadAnalysis = await analyzeThreads(threads, brandProfile, packageTier);
      const highValue = (threadAnalysis.analyzedThreads || []).filter(t => t.category === 'high_value').length;
      await updateProgress(`Analysis complete: ${highValue} high-value threads. Handing off to generation phase...`);
    } else {
      await updateProgress('No Reddit threads found for these keywords.');
    }

    console.log(`[Phase1 ${elapsed()}s] Phase 1 complete. Triggering Phase 2...`);

    // ── Trigger Phase 2: Generation + Report ──
    const host = req.headers.host || req.headers['x-forwarded-host'];
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const phase2Url = `${protocol}://${host}/api/pipeline/generate`;

    const phase2Resp = await fetch(phase2Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pipeline-secret': PIPELINE_SECRET,
      },
      body: JSON.stringify({
        // Intermediate data from Phase 1
        brandProfile,
        keywords,
        threads,
        threadAnalysis,
        aiCitations,
        // Pass-through params
        packageTier,
        campaignMonth,
        prevSpreadsheetUrl,
        clientDocUrl,
        channel,
        threadTs,
        progressTs,
        userId,
      }),
    });

    console.log(`[Phase1 ${elapsed()}s] Phase 2 trigger response: ${phase2Resp.status}`);

  } catch (err) {
    console.error(`[Phase1 ${elapsed()}s] Error:`, err.message, err.stack);
    try {
      await threadPost(`Strategy run failed (research phase): ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
