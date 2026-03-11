const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { getPackage } = require('../../lib/packages');

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
      waitUntil(setupAndTriggerPipeline(req, payload));
      return;
    }

    return res.status(200).json({ response_action: 'clear' });
  }

  return res.status(200).json({ ok: true });
};

// ─── Setup Slack thread, then trigger pipeline endpoint ───

async function setupAndTriggerPipeline(req, payload) {
  const values = payload.view?.state?.values;
  const userId = payload.user?.id;
  let metadata = {};
  try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch (e) {}

  // Parse form values
  const clientName = (values?.client_block?.client_name_input?.value || '').trim();
  const clientDocUrl = values?.client_doc_block?.client_doc_input?.value || '';
  const packageTier = values?.package_block?.package_select?.selected_option?.value || 'b';
  const customKeywords = values?.keywords_block?.keywords_input?.value || '';
  const campaignMonth = values?.month_block?.month_select?.selected_option?.value || '1';
  const prevSpreadsheetUrl = values?.prev_spreadsheet_block?.prev_spreadsheet_input?.value || '';
  const targetSubreddits = values?.subreddits_block?.subreddits_input?.value || '';
  const notes = values?.notes_block?.notes_input?.value || '';
  const customPosts = values?.custom_posts_block?.custom_posts_input?.value || '';
  const customComments = values?.custom_comments_block?.custom_comments_input?.value || '';
  const customUpvotes = values?.custom_upvotes_block?.custom_upvotes_input?.value || '';

  if (!clientName) {
    console.error('Missing client name');
    return;
  }

  const pkg = getPackage(packageTier);

  // ── Resolve channel ──
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

  // Post progress message
  const progressMsg = await slack.postMessage(channel, 'George is working on this...', { threadTs });
  const progressTs = progressMsg.ts;

  // ── Fire off the pipeline as a separate Vercel function ──
  // This gives the pipeline its own independent 300s maxDuration budget.
  const host = req.headers.host || req.headers['x-forwarded-host'];
  const protocol = host?.includes('localhost') ? 'http' : 'https';
  const pipelineUrl = `${protocol}://${host}/api/pipeline/run`;

  console.log(`Triggering pipeline at ${pipelineUrl}`);

  try {
    const resp = await fetch(pipelineUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pipeline-secret': process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024',
      },
      body: JSON.stringify({
        clientName,
        clientDocUrl,
        packageTier,
        customKeywords,
        campaignMonth,
        prevSpreadsheetUrl,
        targetSubreddits,
        notes,
        customPosts: customPosts ? parseInt(customPosts) : null,
        customComments: customComments ? parseInt(customComments) : null,
        customUpvotes: customUpvotes ? parseInt(customUpvotes) : null,
        channel,
        threadTs,
        progressTs,
        userId,
      }),
    });

    console.log(`Pipeline trigger response: ${resp.status}`);
  } catch (err) {
    console.error('Pipeline trigger failed:', err.message);
    // Notify user
    try {
      await slack.updateMessage(channel, progressTs,
        `Failed to start pipeline: ${err.message}. Please try again.`
      );
    } catch (e) {
      console.error('Failed to notify user:', e.message);
    }
  }
}

// ─── Helpers ───

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
