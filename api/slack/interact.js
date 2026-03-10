const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { runStrategyPipeline } = require('../../lib/engine');
const { getPackage } = require('../../lib/packages');
const { getBrandProfile } = require('../../lib/brand-context');
const { buildStrategySpreadsheet } = require('../../lib/spreadsheet');
const { buildGoogleSheetsReport } = require('../../lib/google-spreadsheet');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try {
    const raw = req.body?.payload || req.body;
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // ── Modal Submission ──
  if (payload.type === 'view_submission') {
    const callbackId = payload.view?.callback_id;

    if (callbackId === 'reddit_strategy_submit') {
      res.status(200).json({ response_action: 'clear' });
      waitUntil(handleStrategyRun(payload).catch(err => {
        console.error('FATAL: handleStrategyRun crashed:', err.message, err.stack);
        // Attempt to notify user via DM
        const userId = payload.user?.id;
        if (userId) {
          slack.openDM(userId).then(ch =>
            slack.postMessage(ch, `Strategy run crashed unexpectedly: ${err.message}\nThis may be a timeout issue. Check Vercel logs.`)
          ).catch(() => {});
        }
      }));
      return;
    }

    return res.status(200).json({ response_action: 'clear' });
  }

  return res.status(200).json({ ok: true });
};

// ─── Strategy Run Handler ───

async function handleStrategyRun(payload) {
  const values = payload.view?.state?.values;
  const userId = payload.user?.id;
  let metadata = {};
  try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch (e) {}

  // Parse form values
  const clientName = (values?.client_block?.client_name_input?.value || '').trim();
  const clientDocUrl = values?.client_doc_block?.client_doc_input?.value || '';
  const websiteUrl = values?.client_url_block?.client_url_input?.value || '';
  const packageTier = values?.package_block?.package_select?.selected_option?.value || 'b';
  const customKeywords = values?.keywords_block?.keywords_input?.value || '';
  const targetSubreddits = values?.subreddits_block?.subreddits_input?.value || '';
  const notes = values?.notes_block?.notes_input?.value || '';
  const campaignMonth = values?.month_block?.month_select?.selected_option?.value || '1';
  const prevSpreadsheetUrl = values?.prev_spreadsheet_block?.prev_spreadsheet_input?.value || '';

  if (!clientName) {
    console.error('Missing client name');
    return;
  }

  const pkg = getPackage(packageTier);

  // ── Resolve channel — prefer #reddit-bot, fallback chain ──
  let channel = metadata.channel_id || process.env.SLACK_CHANNEL_ID;
  let parentMsg;

  // ── Send immediate DM acknowledgement ──
  try {
    const ackChannel = await slack.openDM(userId);
    await slack.postMessage(ackChannel, [
      `*George here.* Reddit strategy kicked off for *${titleCase(clientName)}*.`,
      `Package: ${pkg?.name || packageTier} | Month ${campaignMonth}`,
      `I'll post the Google Sheet in <#${channel}> when it's ready (2-3 min).`,
    ].join('\n'));
  } catch (ackErr) {
    console.error('Acknowledgement DM failed:', ackErr.message);
  }

  // ── Post thread header in channel ──
  const headerText = [
    `*Reddit Strategy — ${titleCase(clientName)}*`,
    `Package: ${pkg?.name || packageTier} | Month ${campaignMonth}`,
    prevSpreadsheetUrl ? `Previous report: ${prevSpreadsheetUrl}` : '',
  ].filter(Boolean).join('\n');

  try {
    await slack.joinChannel(channel).catch(() => {});
    parentMsg = await slack.postMessage(channel, headerText);
    if (!parentMsg.ok) throw new Error(parentMsg.error);
  } catch (err) {
    console.error(`Channel post failed (${channel}):`, err.message);
    try {
      channel = await slack.openDM(userId);
      parentMsg = await slack.postMessage(channel, headerText);
      if (!parentMsg.ok) throw new Error(parentMsg.error);
    } catch (dmErr) {
      console.error('DM fallback failed:', dmErr.message);
      try {
        channel = await slack.findPublicChannel();
        await slack.joinChannel(channel).catch(() => {});
        parentMsg = await slack.postMessage(channel, headerText);
        if (!parentMsg.ok) throw new Error(parentMsg.error);
      } catch (pubErr) {
        console.error('Public channel fallback failed:', pubErr.message);
        return;
      }
    }
  }

  const threadTs = parentMsg.ts;
  const threadPost = async (text) => slack.postMessage(channel, text, { threadTs });

  const runStart = Date.now();
  const elapsed = () => ((Date.now() - runStart) / 1000).toFixed(1);

  try {
    // Progress message (updated in-place)
    const progressMsg = await threadPost('George is working on this...');
    const progressTs = progressMsg.ts;

    const updateProgress = async (stepText) => {
      try {
        await slack.updateMessage(channel, progressTs, stepText);
      } catch (err) {
        console.error('Progress update failed:', err.message);
      }
    };

    // Get brand profile
    await updateProgress('Loading brand profile...');
    const brandProfile = await getBrandProfile(clientName, clientDocUrl, websiteUrl, updateProgress);

    if (!brandProfile) {
      const hint = clientDocUrl
        ? 'Could not read the Google Doc. Check the sharing permissions (must be accessible to the service account).'
        : websiteUrl
          ? 'Website research also failed. Check the URL and try again.'
          : 'Provide a Client Info Doc (Google Docs link) or a website URL so George can build a profile.';
      await slack.updateMessage(channel, progressTs,
        `Could not load brand profile for "${titleCase(clientName)}". ${hint}`
      );
      return;
    }

    await updateProgress(`Brand profile loaded. Running strategy pipeline...`);

    // Run the full strategy pipeline
    const strategyData = await runStrategyPipeline(
      brandProfile,
      packageTier,
      customKeywords,
      updateProgress
    );

    console.log(`[Run ${elapsed()}s] Pipeline complete, building Google Sheet...`);
    await updateProgress('Pipeline complete. Building Google Sheet...');

    // ── Build Google Sheets report ──
    const isAppend = prevSpreadsheetUrl && parseInt(campaignMonth) > 1;
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

      // Fallback: generate XLSX and upload
      try {
        const xlsxBuffer = await buildStrategySpreadsheet(strategyData, brandProfile, packageTier, formData);
        const filename = `Reddit_Strategy_${titleCase(clientName).replace(/\s+/g, '_')}_Month${campaignMonth}.xlsx`;
        await slack.uploadFile(xlsxBuffer, filename, channel, {
          threadTs, initialComment: 'Google Sheets failed — here is the XLSX fallback.',
        });
        await slack.updateMessage(channel, progressTs, 'Done (XLSX fallback — Google Sheets auth issue).');
        return;
      } catch (fallbackErr) {
        console.error('XLSX fallback also failed:', fallbackErr.message);
        await slack.updateMessage(channel, progressTs, `Report generation failed: ${sheetErr.message}`);
        return;
      }
    }

    // ── Post final summary with Google Sheet link ──
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

    const appendNote = isAppend
      ? `Month ${campaignMonth} tabs appended to existing sheet.`
      : 'New spreadsheet created with editing access.';

    // Update progress to done
    console.log(`[Run ${elapsed()}s] COMPLETE — all done`);
    await slack.updateMessage(channel, progressTs, 'Done.');

    // Post the deliverable
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
    console.error('handleStrategyRun error:', err.message, err.stack);
    try {
      await threadPost(`Strategy run failed: ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

// ─── Helpers ───

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
