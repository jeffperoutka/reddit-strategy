/**
 * Pipeline Runner — Phase 2: Generation & Report
 *
 * Handles: comments + posts → alignment → report → Google Sheets → Slack delivery
 * Called by Phase 1 (/api/pipeline/run) with intermediate research data.
 *
 * Gets its own 300s maxDuration budget.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { generateComments, checkBrandAlignment, buildStrategyReport, generatePosts, planUpvoteSupport } = require('../../lib/engine');
const { getPackage } = require('../../lib/packages');
const { buildStrategySpreadsheet } = require('../../lib/spreadsheet');
const { buildGoogleSheetsReport } = require('../../lib/google-spreadsheet');

const PIPELINE_SECRET = process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-pipeline-secret'];
  if (secret !== PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(202).json({ status: 'accepted' });

  waitUntil(executePhase2(req.body).catch(err => {
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

async function executePhase2(params) {
  const {
    brandProfile, keywords, threads, threadAnalysis, aiCitations,
    packageTier, campaignMonth, prevSpreadsheetUrl, clientDocUrl,
    channel, threadTs, progressTs, userId,
  } = params;

  const runStart = Date.now();
  const elapsed = () => ((Date.now() - runStart) / 1000).toFixed(1);
  const pkg = getPackage(packageTier);
  const clientName = brandProfile?.clientName || 'Client';

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
    let data = { keywords, threads, threadAnalysis, aiCitations };

    // ── Step 1: Generate comments + posts in parallel ──
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

      data.comments = commentResult.comments || [];
      data.posts = postResult.posts || [];
      console.log(`[Phase2 ${elapsed()}s] Generated ${data.comments.length} comments + ${data.posts.length} posts`);
      await updateProgress(`Generated ${data.comments.length} comments + ${data.posts.length} posts`);

      // ── Step 2: Brand alignment check ──
      if (data.comments.length > 0) {
        await updateProgress('Running brand alignment check...');
        data.commentsWithAlignment = await checkBrandAlignment(data.comments, brandProfile);
        const aligned = data.commentsWithAlignment.filter(c => c.alignment?.aligned).length;
        await updateProgress(`Brand alignment: ${aligned}/${data.commentsWithAlignment.length} comments aligned`);
      } else {
        data.commentsWithAlignment = [];
      }
    } else {
      data.comments = [];
      data.commentsWithAlignment = [];
      data.posts = [];
    }

    // ── Step 3: Upvote planning (sync, no API call) ──
    if (pkg?.monthlyTargets?.upvotes > 0) {
      try {
        data.upvotePlan = planUpvoteSupport(
          data.commentsWithAlignment || [],
          data.posts || [],
          packageTier
        );
      } catch (err) {
        console.error('Upvote planning failed:', err.message);
        data.upvotePlan = null;
      }
    }

    data.brandAlignmentReport = null;
    data.bestPracticesReport = null;

    // ── Step 4: Build strategy report ──
    await updateProgress('Building strategy report...');
    data.report = await buildStrategyReport(data, brandProfile, packageTier);
    console.log(`[Phase2 ${elapsed()}s] Report built`);

    // ── Step 5: Build Google Sheets ──
    await updateProgress('Pipeline complete. Building Google Sheet...');

    const formData = {
      month: campaignMonth,
      prevSpreadsheetUrl,
      packageName: pkg?.name || packageTier,
      clientDocUrl,
    };

    let sheetsUrl;
    try {
      sheetsUrl = await buildGoogleSheetsReport(
        data,
        brandProfile,
        packageTier,
        formData
      );
    } catch (sheetErr) {
      console.error('Google Sheets generation failed:', sheetErr.message, sheetErr.stack);

      // Fallback: XLSX upload
      try {
        const xlsxBuffer = await buildStrategySpreadsheet(data, brandProfile, packageTier, formData);
        const filename = `Reddit_Strategy_${titleCase(clientName).replace(/\s+/g, '_')}_Month${campaignMonth}.xlsx`;
        await slack.uploadFile(xlsxBuffer, filename, channel, {
          threadTs, initialComment: 'Google Sheets failed — here is the XLSX fallback.',
        });
        await updateProgress('Done (XLSX fallback — Google Sheets auth issue).');
        return;
      } catch (fallbackErr) {
        console.error('XLSX fallback also failed:', fallbackErr.message);
        await updateProgress(`Report generation failed: ${sheetErr.message}`);
        return;
      }
    }

    // ── Step 6: Post final summary ──
    const commentCount = data.commentsWithAlignment?.length || 0;
    const postCount = data.posts?.length || 0;
    const threadCount = data.threads?.length || 0;
    const upvoteCount = data.upvotePlan?.totalUpvotes || 0;

    const deliverables = [
      `${threadCount} threads`,
      `${commentCount} comments`,
      postCount > 0 ? `${postCount} posts` : null,
      upvoteCount > 0 ? `${upvoteCount} upvotes` : null,
    ].filter(Boolean).join(', ');

    const isAppend = prevSpreadsheetUrl && parseInt(campaignMonth) > 1;
    const appendNote = isAppend
      ? `Month ${campaignMonth} tabs appended to existing sheet.`
      : 'New spreadsheet created with editing access.';

    console.log(`[Phase2 ${elapsed()}s] COMPLETE — all done`);
    await updateProgress('Done.');

    await threadPost([
      `*${titleCase(clientName)} — Reddit Strategy (${pkg?.name || packageTier}, Month ${campaignMonth})*`,
      ``,
      `${deliverables}`,
      `${appendNote}`,
      ``,
      `${sheetsUrl}`,
      ``,
      `_Review and make changes directly in the sheet. Highlight anything to discuss._`,
    ].join('\n'));

  } catch (err) {
    console.error(`[Phase2 ${elapsed()}s] Error:`, err.message, err.stack);
    try {
      await threadPost(`Strategy run failed (generation phase): ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
