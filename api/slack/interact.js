const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const github = require('../../lib/connectors/github');
const { runStrategyPipeline } = require('../../lib/engine');
const { getPackage, getPackageOptions } = require('../../lib/packages');
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

  // ── External Select: client search ──
  if (payload.type === 'block_suggestion') {
    const query = (payload.value || '').trim().toLowerCase();
    return res.status(200).json(await buildClientSuggestions(query));
  }

  // ── Modal Submission ──
  if (payload.type === 'view_submission') {
    const callbackId = payload.view?.callback_id;

    if (callbackId === 'reddit_strategy_submit') {
      res.status(200).json({ response_action: 'clear' });
      waitUntil(handleStrategyRun(payload));
      return;
    }

    return res.status(200).json({ response_action: 'clear' });
  }

  return res.status(200).json({ ok: true });
};

// ─── Client Search Suggestions ───

// Client Info Docs folder ID in ClickUp "Client Delivery" space
const CLIENT_INFO_DOCS_FOLDER_ID = '901812024928';

async function buildClientSuggestions(query) {
  const options = [];
  const seen = new Set();

  // Primary source: ClickUp Client Info Docs folder via v3 docs API
  try {
    const cuToken = process.env.CLICKUP_API_TOKEN;
    const wsId = process.env.CLICKUP_WORKSPACE_ID;
    if (cuToken && wsId) {
      const cuResp = await fetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/docs`, {
        headers: { 'Authorization': cuToken },
      });
      if (cuResp.ok) {
        const data = await cuResp.json();
        const clientDocs = (data.docs || []).filter(doc =>
          doc.parent?.id === CLIENT_INFO_DOCS_FOLDER_ID &&
          !doc.deleted &&
          doc.name &&
          !doc.name.toLowerCase().includes('template') &&
          !doc.name.toLowerCase().includes('definitions') &&
          doc.name !== 'AD6SC3RT6'
        );

        for (const doc of clientDocs) {
          const name = doc.name
            .replace(/\s*(client\s+)?info(\s+doc)?(\s+template)?$/i, '')
            .trim();
          if (!name) continue;

          const val = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
          const nameLower = name.toLowerCase();

          if (seen.has(nameLower)) continue;
          if (query && !nameLower.includes(query)) continue;

          seen.add(nameLower);
          options.push({
            text: { type: 'plain_text', text: name },
            value: val,
          });
        }
      }
    }
  } catch (err) {
    console.error('ClickUp docs error:', err.message);
  }

  // Secondary source: Brand Guardian cache (supplements ClickUp)
  const pat = process.env.GITHUB_PAT;
  if (pat) {
    try {
      const resp = await fetch('https://api.github.com/repos/jeffperoutka/brand-guardian/contents/brand-cache', {
        headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
      });
      if (resp.ok) {
        const files = await resp.json();
        for (const f of files) {
          if (!f.name.endsWith('.json')) continue;
          const brand = f.name.replace('.json', '').replace(/-/g, ' ');
          const brandLower = brand.toLowerCase();
          if (seen.has(brandLower)) continue;
          if (query && !brandLower.includes(query)) continue;

          seen.add(brandLower);
          options.push({
            text: { type: 'plain_text', text: titleCase(brand) },
            value: brand.toLowerCase().replace(/\s/g, '-'),
          });
        }
      }
    } catch (err) {
      console.error('Brand cache search error:', err.message);
    }
  }

  // Allow adding new clients
  if (query && !options.some(o => o.value === query.replace(/\s/g, '-'))) {
    options.push({
      text: { type: 'plain_text', text: `+ New client: ${titleCase(query)}` },
      value: `__new__:${query}`,
    });
  }

  if (options.length === 0) {
    options.push({
      text: { type: 'plain_text', text: 'Type a client name...' },
      value: '__empty__',
    });
  }

  return { options: options.slice(0, 100) };
}

// ─── Strategy Run Handler ───

async function handleStrategyRun(payload) {
  const values = payload.view?.state?.values;
  const userId = payload.user?.id;
  let metadata = {};
  try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch (e) {}

  // Parse form values
  const selectedOption = values?.client_block?.client_select?.selected_option;
  let clientName = '';
  if (selectedOption) {
    const val = selectedOption.value;
    if (val.startsWith('__new__:')) {
      clientName = val.slice(8).replace(/-/g, ' ');
    } else if (val === '__empty__') {
      clientName = '';
    } else {
      clientName = val.replace(/-/g, ' ');
    }
  }

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
    const brandProfile = await getBrandProfile(clientName, websiteUrl, updateProgress);

    if (!brandProfile) {
      const hint = websiteUrl
        ? 'Website research also failed. Check the URL and try again.'
        : 'Provide a website URL in the form so George can build a profile from the site.';
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

    await updateProgress('Pipeline complete. Building Google Sheet...');

    // ── Build Google Sheets report ──
    const isAppend = prevSpreadsheetUrl && parseInt(campaignMonth) > 1;
    const formData = {
      month: campaignMonth,
      prevSpreadsheetUrl,
      packageName: pkg?.name || packageTier,
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
