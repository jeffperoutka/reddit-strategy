/**
 * Pipeline Runner — Phase 4: QA Review & Revision
 *
 * Triggered by Phase 3 (finalize) after the Google Sheet is delivered.
 * Reviews all generated content, flags issues, regenerates bad items,
 * then updates the Google Sheet with revised content.
 *
 * Gets its own 300s maxDuration budget.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { runQA } = require('../../lib/qa');
const { getSheetsClient, extractSpreadsheetId } = require('../../lib/google-spreadsheet');

const PIPELINE_SECRET = process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-pipeline-secret'];
  if (secret !== PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(202).json({ status: 'accepted' });

  waitUntil(executePhase4(req.body).catch(err => {
    console.error('FATAL: Phase 4 (QA) crashed:', err.message, err.stack);
    const { channel, threadTs, userId } = req.body || {};
    if (channel && threadTs) {
      slack.postMessage(channel, `QA review crashed: ${err.message}`, { threadTs }).catch(() => {});
    }
  }));
};

async function executePhase4(params) {
  const {
    strategyData, brandProfile, packageTier,
    driveUrl, spreadsheetId,
    channel, threadTs, progressTs, userId,
  } = params;

  const runStart = Date.now();
  const elapsed = () => ((Date.now() - runStart) / 1000).toFixed(1);

  const updateProgress = async (stepText) => {
    console.log(`[Phase4 ${elapsed()}s] ${stepText}`);
    try {
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
    await updateProgress('Running QA review on all content...');

    // ── Run QA ──
    const qaResult = await runQA(strategyData, brandProfile, packageTier);

    const { revisedComments, revisedPosts, qaReport, flaggedCount, revisedCount } = qaResult;

    // ── Update Google Sheet with revised content if items were fixed ──
    if (revisedCount > 0 && spreadsheetId) {
      await updateProgress(`QA revised ${revisedCount} items. Updating spreadsheet...`);
      try {
        await updateSheetWithRevisions(spreadsheetId, revisedComments, revisedPosts);
        console.log(`[Phase4 ${elapsed()}s] Sheet updated with ${revisedCount} revisions`);
      } catch (err) {
        console.error(`[Phase4 ${elapsed()}s] Sheet update failed:`, err.message);
        await threadPost(`QA revised ${revisedCount} items but could not update the sheet: ${err.message}`);
      }
    }

    // ── Post QA summary to Slack ──
    await updateProgress('QA complete.');

    const summaryLines = [`*QA Review Complete*`];

    if (qaReport.passed) {
      summaryLines.push(`All ${qaReport.totalReviewed} items passed QA.`);
    } else {
      summaryLines.push(`Reviewed: ${qaReport.totalReviewed} items`);
      if (flaggedCount > 0) {
        summaryLines.push(`Flagged: ${qaReport.commentsFlagged} comments, ${qaReport.postsFlagged} posts`);
        summaryLines.push(`Revised: ${revisedCount} items auto-fixed and updated in the sheet`);
      }
      if (qaReport.scopeIssues.length > 0) {
        summaryLines.push(`\n*Scope Issues:*`);
        for (const issue of qaReport.scopeIssues) {
          summaryLines.push(`• ${issue}`);
        }
      }
    }

    summaryLines.push(`\n_Review the sheet and set Status to "Approved" for items ready to post. Then run \`/reddit-execute\` to publish._`);

    if (driveUrl) {
      summaryLines.push(`\nSheet: ${driveUrl}`);
    }

    await threadPost(summaryLines.join('\n'));
    console.log(`[Phase4 ${elapsed()}s] COMPLETE`);

  } catch (err) {
    console.error(`[Phase4 ${elapsed()}s] Error:`, err.message, err.stack);
    await threadPost(`QA review failed: ${err.message}`);
  }
}

/**
 * Update the Google Sheet with revised content.
 * Overwrites the comment/post text for revised items.
 */
async function updateSheetWithRevisions(spreadsheetId, revisedComments, revisedPosts) {
  const { getSheetsClient: getSheets } = require('../../lib/google-spreadsheet');
  const sheets = getSheets();
  if (!sheets) throw new Error('Could not create Sheets client');

  // Get existing sheet metadata to find tab names
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetNames = new Set((meta.data.sheets || []).map(s => s.properties.title));

  const batchData = [];

  // ── Update Comments (column H = comment text, row = index + 2 for header) ──
  const commentsTab = sheetNames.has('Comments') ? 'Comments' : null;
  if (commentsTab) {
    for (let i = 0; i < revisedComments.length; i++) {
      const c = revisedComments[i];
      if (c._qaRevised) {
        const row = i + 2; // +1 for header, +1 for 1-indexed
        // Update comment text (col H), angle (col F), brand mention (col I)
        batchData.push({
          range: `'${commentsTab}'!F${row}`,
          values: [[c.angle || '']],
        });
        batchData.push({
          range: `'${commentsTab}'!H${row}`,
          values: [[c.comment || '']],
        });
        batchData.push({
          range: `'${commentsTab}'!I${row}`,
          values: [[c.brandMentionType || '']],
        });
      }
    }
  }

  // ── Update Posts (col E = title, F = body, G = follow-up, H = strategy) ──
  const postsTab = sheetNames.has('Post Drafts') ? 'Post Drafts' : null;
  if (postsTab) {
    for (let i = 0; i < revisedPosts.length; i++) {
      const p = revisedPosts[i];
      if (p._qaRevised) {
        const row = i + 2;
        batchData.push({
          range: `'${postsTab}'!E${row}`,
          values: [[p.title || '']],
        });
        batchData.push({
          range: `'${postsTab}'!F${row}`,
          values: [[p.body || '']],
        });
        batchData.push({
          range: `'${postsTab}'!G${row}`,
          values: [[p.followUpComment || '']],
        });
        batchData.push({
          range: `'${postsTab}'!H${row}`,
          values: [[p.brandMentionStrategy || '']],
        });
      }
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: batchData,
      },
    });
    console.log(`[QA] Updated ${batchData.length} cells in Google Sheet`);
  }
}
