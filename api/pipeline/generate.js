/**
 * Pipeline Runner — Phase 2: Content Generation
 *
 * Handles: comments + posts generation (batched, in parallel)
 * Called by Phase 1 (/api/pipeline/run) with research data.
 * Triggers Phase 3 (/api/pipeline/finalize) with generated content.
 *
 * Gets its own 300s maxDuration budget.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { generateComments, generatePosts } = require('../../lib/engine');
const { getPackage } = require('../../lib/packages');

const PIPELINE_SECRET = process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-pipeline-secret'];
  if (secret !== PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(202).json({ status: 'accepted' });

  waitUntil(executePhase2(req, req.body).catch(err => {
    console.error('FATAL: Phase 2 crashed:', err.message, err.stack);
    const { channel, threadTs, userId } = req.body || {};
    if (channel && threadTs) {
      slack.postMessage(channel, `Pipeline crashed (phase 2): ${err.message}`, { threadTs }).catch(() => {});
    } else if (userId) {
      slack.openDM(userId).then(ch =>
        slack.postMessage(ch, `Strategy run crashed: ${err.message}`)
      ).catch(() => {});
    }
  }));
};

async function executePhase2(req, params) {
  const {
    brandProfile, keywords, threads, threadAnalysis, aiCitations,
    packageTier, campaignMonth, prevSpreadsheetUrl, clientDocUrl,
    channel, threadTs, progressTs, userId,
  } = params;

  const runStart = Date.now();
  const elapsed = () => ((Date.now() - runStart) / 1000).toFixed(1);
  const pkg = getPackage(packageTier);

  const updateProgress = async (stepText) => {
    try {
      console.log(`[Phase2 ${elapsed()}s] ${stepText}`);
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
    let comments = [];
    let posts = [];

    // ── Generate comments + posts in parallel ──
    if (threadAnalysis?.analyzedThreads?.length > 0) {
      await updateProgress(`Generating ${pkg?.monthlyTargets?.comments || 0} comments + ${pkg?.monthlyTargets?.posts || 0} posts (batched)...`);

      const commentPromise = generateComments(
        threadAnalysis.analyzedThreads,
        brandProfile,
        packageTier
      ).catch(err => {
        console.error('Comment generation failed:', err.message);
        return { comments: [] };
      });

      const postPromise = (pkg?.monthlyTargets?.posts > 0)
        ? generatePosts(threadAnalysis.analyzedThreads, brandProfile, packageTier)
            .catch(err => {
              console.error('Post generation failed:', err.message);
              return { posts: [] };
            })
        : Promise.resolve({ posts: [] });

      const [commentResult, postResult] = await Promise.all([commentPromise, postPromise]);

      comments = commentResult.comments || [];
      posts = postResult.posts || [];
      console.log(`[Phase2 ${elapsed()}s] Generated ${comments.length} comments + ${posts.length} posts`);
      await updateProgress(`Generated ${comments.length} comments + ${posts.length} posts. Starting alignment & report...`);
    }

    // ── Trigger Phase 3: Finalize (alignment, report, Google Sheets) ──
    console.log(`[Phase2 ${elapsed()}s] Phase 2 complete. Triggering Phase 3...`);

    const host = req.headers.host || req.headers['x-forwarded-host'];
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const phase3Url = `${protocol}://${host}/api/pipeline/finalize`;

    const phase3Resp = await fetch(phase3Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pipeline-secret': PIPELINE_SECRET,
      },
      body: JSON.stringify({
        // Research data from Phase 1
        brandProfile,
        keywords,
        threads,
        threadAnalysis,
        aiCitations,
        // Generated content from Phase 2
        comments,
        posts,
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

    console.log(`[Phase2 ${elapsed()}s] Phase 3 trigger response: ${phase3Resp.status}`);

  } catch (err) {
    console.error(`[Phase2 ${elapsed()}s] Error:`, err.message, err.stack);
    try {
      await threadPost(`Strategy run failed (generation phase): ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}
