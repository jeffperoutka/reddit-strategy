/**
 * Pipeline Runner — Phase 3: Finalize & Deliver
 *
 * Handles: brand alignment → upvote plan → report → Google Sheets → Slack delivery
 * Called by Phase 2 (/api/pipeline/generate) with generated content.
 *
 * Gets its own 300s maxDuration budget.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { checkBrandAlignment, buildStrategyReport, planUpvoteSupport } = require('../../lib/engine');
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

  waitUntil(executePhase3(req.body).catch(err => {
    console.error('FATAL: Phase 3 crashed:', err.message, err.stack);
    const { channel, threadTs, userId } = req.body || {};
    if (channel && threadTs) {
      slack.postMessage(channel, `Pipeline crashed (phase 3): ${err.message}`, { threadTs }).catch(() => {});
    } else if (userId) {
      slack.openDM(userId).then(ch =>
        slack.postMessage(ch, `Strategy run crashed: ${err.message}`)
      ).catch(() => {});
    }
  }));
};

async function executePhase3(params) {
  const {
    brandProfile, keywords, threads, threadAnalysis, aiCitations,
    comments, posts,
    packageTier, campaignMonth, prevSpreadsheetUrl, clientDocUrl,
    customPosts, customComments, customUpvotes,
    channel, threadTs, progressTs, userId,
  } = params;

  const runStart = Date.now();
  const elapsed = () => ((Date.now() - runStart) / 1000).toFixed(1);
  const pkg = getPackage(packageTier);

  // Apply custom scope overrides
  if (packageTier === 'custom' && pkg) {
    if (customPosts != null) pkg.monthlyTargets.posts = customPosts;
    if (customComments != null) pkg.monthlyTargets.comments = customComments;
    if (customUpvotes != null) pkg.monthlyTargets.upvotes = customUpvotes;
  }
  const clientName = brandProfile?.clientName || 'Client';

  const updateProgress = async (stepText) => {
    try {
      console.log(`[Phase3 ${elapsed()}s] ${stepText}`);
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
    let data = { keywords, threads, threadAnalysis, aiCitations, comments, posts };

    // ── Step 1: Brand alignment check ──
    if (comments.length > 0) {
      await updateProgress(`Checking brand alignment on ${comments.length} comments...`);
      data.commentsWithAlignment = await checkBrandAlignment(comments, brandProfile);
      const aligned = data.commentsWithAlignment.filter(c => c.alignment?.aligned).length;
      await updateProgress(`Brand alignment: ${aligned}/${data.commentsWithAlignment.length} comments aligned`);
    } else {
      data.commentsWithAlignment = [];
    }

    // ── Step 2: Upvote planning (sync, no API call) ──
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

    // ── Step 3: Build strategy report ──
    await updateProgress('Building strategy report...');
    data.report = await buildStrategyReport(data, brandProfile, packageTier);
    console.log(`[Phase3 ${elapsed()}s] Report built`);

    // ── Step 4: Build spreadsheet & upload ──
    const monthInt = parseInt(campaignMonth) || 1;
    if (monthInt > 1 && prevSpreadsheetUrl) {
      await updateProgress(`Month ${campaignMonth}: Appending to existing spreadsheet...`);
    } else {
      await updateProgress('Building spreadsheet...');
    }

    const formData = {
      month: campaignMonth,
      prevSpreadsheetUrl,
      packageName: pkg?.name || packageTier,
      clientDocUrl,
    };

    let driveUrl = null;
    let xlsxBuffer = null;
    let appendedToExisting = false;

    // Try Google Drive upload (requires GOOGLE_IMPERSONATE_EMAIL for domain-wide delegation)
    try {
      const result = await buildGoogleSheetsReport(data, brandProfile, packageTier, formData);
      xlsxBuffer = result.xlsxBuffer;
      driveUrl = result.driveUrl;

      if (result.appended) {
        appendedToExisting = true;
        console.log(`[Phase3 ${elapsed()}s] Successfully appended Month ${campaignMonth} to existing sheet`);
        await threadPost(`Month ${campaignMonth} data appended to existing spreadsheet.`);
      } else if (result.appendError) {
        // Post the EXACT reason to Slack so we can debug
        console.error(`[Phase3 ${elapsed()}s] Append issue: ${result.appendError}`);
        await threadPost(`Could not append Month ${campaignMonth} to existing sheet.\nReason: ${result.appendError}\n\n${driveUrl ? 'Created new spreadsheet instead.' : 'XLSX attached below.'}`);
      } else if (driveUrl) {
        console.log(`[Phase3 ${elapsed()}s] Google Sheet created: ${driveUrl}`);
      }
    } catch (driveErr) {
      console.error(`[Phase3 ${elapsed()}s] Drive upload failed: ${driveErr.message}`);
      await threadPost(`Google Sheets failed: ${driveErr.message}`);
      try {
        xlsxBuffer = await buildStrategySpreadsheet(data, brandProfile, packageTier, formData);
      } catch (xlsxErr) {
        console.error('XLSX build failed:', xlsxErr.message);
        await threadPost(`Spreadsheet generation failed: ${xlsxErr.message}`);
        return;
      }
    }

    // Always upload XLSX to Slack as reliable delivery
    const filename = `Reddit_Strategy_${titleCase(clientName).replace(/\s+/g, '_')}_Month${campaignMonth}.xlsx`;
    try {
      await slack.uploadFile(xlsxBuffer, filename, channel, { threadTs });
    } catch (uploadErr) {
      console.error('Slack file upload failed:', uploadErr.message);
    }

    // ── Step 5: Post final summary ──
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

    console.log(`[Phase3 ${elapsed()}s] COMPLETE — all done`);
    await updateProgress('Done.');

    const summaryLines = [
      `*${titleCase(clientName)} — Reddit Strategy (${pkg?.name || packageTier}, Month ${campaignMonth})*`,
      ``,
      `${deliverables}`,
    ];

    if (driveUrl) {
      summaryLines.push(``, `Google Sheet: ${driveUrl}`, ``);
      summaryLines.push(`_Review and make changes directly in the sheet. Highlight anything to discuss._`);
    } else {
      summaryLines.push(``, `_XLSX attached above. Open in Google Sheets or Excel to review._`);
    }

    await threadPost(summaryLines.join('\n'));

  } catch (err) {
    console.error(`[Phase3 ${elapsed()}s] Error:`, err.message, err.stack);
    try {
      await threadPost(`Strategy run failed (finalization phase): ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
