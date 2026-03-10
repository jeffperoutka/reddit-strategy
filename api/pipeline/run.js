/**
 * Pipeline Runner — Dedicated endpoint for long-running strategy pipeline.
 *
 * This endpoint gets its own Vercel function invocation with a full 300s
 * maxDuration budget, separate from the Slack interact handler.
 *
 * Called by /api/slack/interact via HTTP fire-and-forget.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { runStrategyPipeline } = require('../../lib/engine');
const { getPackage } = require('../../lib/packages');
const { getBrandProfile } = require('../../lib/brand-context');
const { buildStrategySpreadsheet } = require('../../lib/spreadsheet');
const { buildGoogleSheetsReport } = require('../../lib/google-spreadsheet');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Validate internal secret
  const secret = req.headers['x-pipeline-secret'];
  if (secret !== (process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately — the pipeline runs in waitUntil with full 300s budget
  res.status(202).json({ status: 'accepted' });

  waitUntil(executePipeline(req.body).catch(err => {
    console.error('FATAL: Pipeline crashed:', err.message, err.stack);
    // Try to notify via Slack
    const { channel, threadTs, userId } = req.body || {};
    if (channel && threadTs) {
      slack.postMessage(channel, `Pipeline crashed: ${err.message}`, { threadTs }).catch(() => {});
    } else if (userId) {
      slack.openDM(userId).then(ch =>
        slack.postMessage(ch, `Strategy run crashed: ${err.message}`)
      ).catch(() => {});
    }
  }));
};

async function executePipeline(params) {
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
      console.log(`[Pipeline ${elapsed()}s] ${stepText}`);
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
    // Get brand profile
    await updateProgress('Loading brand profile...');
    const brandProfile = await getBrandProfile(clientName, clientDocUrl, null, updateProgress);

    if (!brandProfile) {
      const hint = 'Could not read the Google Doc. Check sharing permissions (must be shared with the service account).';
      await updateProgress(`Could not load brand profile for "${titleCase(clientName)}". ${hint}`);
      return;
    }

    await updateProgress('Brand profile loaded. Running strategy pipeline...');

    // Run the full strategy pipeline
    const strategyData = await runStrategyPipeline(
      brandProfile,
      packageTier,
      customKeywords,
      updateProgress
    );

    console.log(`[Pipeline ${elapsed()}s] Pipeline complete, building Google Sheet...`);
    await updateProgress('Pipeline complete. Building Google Sheet...');

    // Build Google Sheets report
    const formData = {
      month: campaignMonth,
      prevSpreadsheetUrl,
      packageName: pkg?.name || packageTier,
      clientDocUrl,
    };

    let sheetsUrl;
    try {
      sheetsUrl = await buildGoogleSheetsReport(
        strategyData,
        brandProfile,
        packageTier,
        formData
      );
    } catch (sheetErr) {
      console.error('Google Sheets generation failed:', sheetErr.message, sheetErr.stack);

      // Fallback: XLSX upload
      try {
        const xlsxBuffer = await buildStrategySpreadsheet(strategyData, brandProfile, packageTier, formData);
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

    // Post final summary
    const commentCount = strategyData.commentsWithAlignment?.length || 0;
    const postCount = strategyData.posts?.length || 0;
    const threadCount = strategyData.threads?.length || 0;
    const upvoteCount = strategyData.upvotePlan?.totalUpvotes || 0;

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

    console.log(`[Pipeline ${elapsed()}s] COMPLETE — all done`);
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
    console.error(`[Pipeline ${elapsed()}s] Pipeline error:`, err.message, err.stack);
    try {
      await threadPost(`Strategy run failed: ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
