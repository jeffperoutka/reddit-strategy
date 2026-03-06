const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const github = require('../../lib/connectors/github');
const { runStrategyPipeline } = require('../../lib/engine');
const { getPackage, getPackageOptions } = require('../../lib/packages');
const { getBrandProfile } = require('../../lib/brand-context');
const { buildStrategySpreadsheet } = require('../../lib/spreadsheet');

// ── In-memory store for pending strategies ──
const pendingStrategies = new Map();

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

    if (callbackId === 'edit_comment_submit') {
      res.status(200).json({ response_action: 'clear' });
      waitUntil(handleEditComment(payload));
      return;
    }

    return res.status(200).json({ response_action: 'clear' });
  }

  // ── Button Clicks ──
  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    if (!action) return res.status(200).json({ ok: true });

    res.status(200).json({ ok: true });

    const actionId = action.action_id;

    if (actionId.startsWith('approve_comment_')) {
      waitUntil(handleApproveComment(payload, action));
    } else if (actionId.startsWith('edit_comment_')) {
      waitUntil(handleEditCommentButton(payload, action));
    } else if (actionId.startsWith('reject_comment_')) {
      waitUntil(handleRejectComment(payload, action));
    } else if (actionId === 'approve_all_comments') {
      waitUntil(handleApproveAll(payload));
    } else if (actionId === 'send_to_vendor') {
      waitUntil(handleSendToVendor(payload));
    }
    return;
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
          // Strip "Client Info Doc" suffix to get clean client name
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
      text: { type: 'plain_text', text: `➕ New client: ${titleCase(query)}` },
      value: `__new__:${query}`,
    });
  }

  if (options.length === 0) {
    options.push({
      text: { type: 'plain_text', text: '📝 Type a client name...' },
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

  // ── Send immediate acknowledgement to the user ──
  try {
    const ackChannel = await slack.openDM(userId);
    await slack.postMessage(ackChannel, [
      `🤖 *Hey! Sally here.* Your Reddit strategy run just kicked off!`,
      ``,
      `*Client:* ${titleCase(clientName)}`,
      `*Package:* ${pkg?.name || packageTier}`,
      `*Month:* ${campaignMonth}`,
      customKeywords ? `*Keywords:* ${customKeywords}` : '',
      ``,
      `I'll post the full results in <#${channel}> when I'm done. Hang tight — this usually takes 2-3 minutes. ⏳`,
    ].filter(Boolean).join('\n'));
  } catch (ackErr) {
    console.error('Acknowledgement DM failed:', ackErr.message, '— continuing anyway');
  }

  const recapLines = [
    `🎯 *Reddit Strategy Run*`,
    ``,
    `*Client:* ${titleCase(clientName)}`,
    `*Package:* ${pkg?.name || packageTier}`,
    `*Month:* ${campaignMonth}`,
    customKeywords ? `*Keywords:* ${customKeywords}` : '',
    targetSubreddits ? `*Target Subreddits:* ${targetSubreddits}` : '',
    notes ? `*Notes:* ${notes.slice(0, 200)}` : '',
    prevSpreadsheetUrl ? `*Previous Month Report:* ${prevSpreadsheetUrl}` : '',
  ].filter(Boolean).join('\n');

  try {
    await slack.joinChannel(channel).catch(() => {});
    parentMsg = await slack.postMessage(channel, recapLines);
    if (!parentMsg.ok) throw new Error(parentMsg.error);
  } catch (err) {
    console.error(`Channel post failed (${channel}):`, err.message, '— trying fallbacks');
    // Fallback 1: try DM
    try {
      channel = await slack.openDM(userId);
      parentMsg = await slack.postMessage(channel, recapLines);
      if (!parentMsg.ok) throw new Error(parentMsg.error);
    } catch (dmErr) {
      console.error('DM fallback failed:', dmErr.message, '— trying public channel');
      // Fallback 2: find and post to a public channel
      try {
        channel = await slack.findPublicChannel();
        await slack.joinChannel(channel).catch(() => {});
        parentMsg = await slack.postMessage(channel, recapLines);
        if (!parentMsg.ok) throw new Error(parentMsg.error);
      } catch (pubErr) {
        console.error('Public channel fallback failed:', pubErr.message);
        return;
      }
    }
  }

  const threadTs = parentMsg.ts;
  const threadPost = async (text, opts = {}) => slack.postMessage(channel, text, { threadTs, ...opts });

  try {
    // Progress message
    const progressMsg = await threadPost('⏳ Sally is starting your Reddit strategy...');
    const progressTs = progressMsg.ts;

    const updateProgress = async (stepText) => {
      try {
        await slack.updateMessage(channel, progressTs, `⏳ ${stepText}`);
      } catch (err) {
        console.error('Progress update failed:', err.message);
      }
    };

    // Get brand profile
    await updateProgress('Loading brand profile...');
    const brandProfile = await getBrandProfile(clientName, websiteUrl, updateProgress);

    if (!brandProfile) {
      await slack.updateMessage(channel, progressTs,
        `❌ Could not find brand profile for "${titleCase(clientName)}". Please run \`/brand-check\` first to build the brand profile, or provide a website URL.`
      );
      return;
    }

    await updateProgress(`Brand profile loaded for ${brandProfile.clientName}. Starting pipeline...`);

    // Run the full strategy pipeline
    const strategyData = await runStrategyPipeline(
      brandProfile,
      packageTier,
      customKeywords,
      updateProgress
    );

    // Update progress to complete
    await slack.updateMessage(channel, progressTs, '✅ Strategy pipeline complete. Preparing results...');

    // Store strategy data for approval flow
    pendingStrategies.set(threadTs, {
      clientName: titleCase(clientName),
      packageTier,
      strategyData,
      brandProfile,
      channel,
      campaignMonth,
      prevSpreadsheetUrl,
      approvedComments: new Set(),
      rejectedComments: new Set(),
    });

    // Post strategy report
    await postStrategyReport(channel, threadTs, strategyData, titleCase(clientName), packageTier);

    // Post comment review cards
    if (strategyData.commentsWithAlignment?.length > 0) {
      await postCommentReviewCards(channel, threadTs, strategyData.commentsWithAlignment);
    }

    // ── Build and upload the XLSX spreadsheet ──
    try {
      await threadPost('📊 Building your client-ready spreadsheet...');

      const formData = {
        month: campaignMonth,
        prevSpreadsheetUrl,
        packageName: pkg?.name || packageTier,
      };

      const xlsxBuffer = await buildStrategySpreadsheet(
        strategyData,
        brandProfile,
        packageTier,
        formData
      );

      const filename = `Reddit_Strategy_${titleCase(clientName).replace(/\s+/g, '_')}_Month${campaignMonth}_${new Date().toISOString().split('T')[0]}.xlsx`;

      await slack.uploadFile(
        xlsxBuffer,
        filename,
        channel,
        {
          threadTs,
          initialComment: `📎 *${titleCase(clientName)} — Reddit Strategy Report (${pkg?.name || packageTier}, Month ${campaignMonth})*\nClient-ready spreadsheet with all threads, comments, subreddit strategy, and reporting tracker.`,
        }
      );
    } catch (xlsxErr) {
      console.error('Spreadsheet generation failed:', xlsxErr.message, xlsxErr.stack);
      await threadPost(`⚠️ Spreadsheet generation failed: ${xlsxErr.message}. The Slack report above is still complete.`);
    }

  } catch (err) {
    console.error('handleStrategyRun error:', err.message, err.stack);
    try {
      await threadPost(`❌ Strategy run failed: ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

// ─── Post Strategy Report ───

async function postStrategyReport(channel, threadTs, data, clientName, packageTier) {
  const report = data.report || {};
  const pkg = getPackage(packageTier);

  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: `📊 Reddit Strategy Report: ${clientName}` } });

  // Executive Summary
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Package:* ${pkg?.name || packageTier}\n\n${report.executiveSummary || 'No summary available.'}` },
  });

  blocks.push({ type: 'divider' });

  // Top Opportunities
  if (report.topOpportunities?.length > 0) {
    let oppText = '*🎯 Top Thread Opportunities:*\n';
    for (const opp of report.topOpportunities.slice(0, 5)) {
      oppText += `\n• *<${opp.url}|${opp.title?.slice(0, 60)}>* (${opp.subreddit})\n  Score: ${opp.score} — ${opp.opportunity?.slice(0, 120)}`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: oppText } });
  }

  blocks.push({ type: 'divider' });

  // Subreddit Strategy
  if (report.subredditStrategy?.length > 0) {
    let subText = '*🗺️ Subreddit Strategy:*\n';
    for (const sub of report.subredditStrategy.slice(0, 5)) {
      const emoji = sub.priority === 'high' ? '🔴' : sub.priority === 'medium' ? '🟡' : '🟢';
      subText += `\n${emoji} *${sub.subreddit}* (${sub.archetype || 'General'})\n  ${sub.approach?.slice(0, 120)}`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: subText } });
  }

  blocks.push({ type: 'divider' });

  // Recommended Actions
  if (report.recommendedActions?.length > 0) {
    let actText = '*📋 Recommended Actions:*\n';
    for (const act of report.recommendedActions.slice(0, 5)) {
      const emoji = act.priority === 'high' ? '🔴' : act.priority === 'medium' ? '🟡' : '🟢';
      actText += `\n${emoji} ${act.action} _(${act.timeline || 'this sprint'})_`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: actText } });
  }

  // Risk Assessment
  if (report.riskAssessment) {
    blocks.push({ type: 'divider' });
    const riskEmoji = report.riskAssessment.overallRisk === 'high' ? '🔴' : report.riskAssessment.overallRisk === 'medium' ? '🟡' : '🟢';
    let riskText = `*${riskEmoji} Risk Level: ${(report.riskAssessment.overallRisk || 'unknown').toUpperCase()}*`;
    if (report.riskAssessment.risks?.length > 0) {
      riskText += '\n' + report.riskAssessment.risks.slice(0, 3).map(r => `• ${r.risk}: _${r.mitigation}_`).join('\n');
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: riskText } });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_${data.threads?.length || 0} threads discovered • ${data.commentsWithAlignment?.length || 0} comments drafted • ${data.keywords?.length || 0} keywords researched • Generated by Sally the Reddit Bot_` }],
  });

  // Cap blocks
  if (blocks.length > 49) blocks.length = 49;

  const fallback = `📊 Reddit Strategy for ${clientName}: ${report.executiveSummary?.slice(0, 200) || 'Complete'}`;
  await slack.postMessage(channel, fallback, { threadTs, blocks });
}

// ─── Post Comment Review Cards ───

async function postCommentReviewCards(channel, threadTs, comments) {
  // Header
  await slack.postMessage(channel, '📝 *Comment Drafts for Review*\nApprove, edit, or reject each comment below.', { threadTs });

  for (let i = 0; i < comments.length && i < 20; i++) {
    const c = comments[i];
    const alignment = c.alignment || {};
    const alignEmoji = alignment.aligned ? '✅' : '⚠️';
    const spamEmoji = alignment.spamRisk === 'high' ? '🔴' : alignment.spamRisk === 'medium' ? '🟡' : '🟢';

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Comment ${i + 1}* — ${c.subreddit || 'Unknown'}\n*Thread:* <${c.threadUrl}|${c.threadTitle?.slice(0, 50)}>\n*Angle:* ${c.angle || 'General'}\n${alignEmoji} Alignment: ${alignment.score || '?'}% • ${spamEmoji} Spam Risk: ${alignment.spamRisk || 'unknown'}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\`\`\`${c.comment?.slice(0, 2500)}\`\`\`` },
      },
    ];

    // Add alignment issues if any
    if (alignment.issues?.length > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `⚠️ _Issues: ${alignment.issues.join(', ')}_` }],
      });
    }

    // Action buttons
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve' },
          style: 'primary',
          action_id: `approve_comment_${i}`,
          value: String(i),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Edit' },
          action_id: `edit_comment_${i}`,
          value: String(i),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Reject' },
          style: 'danger',
          action_id: `reject_comment_${i}`,
          value: String(i),
        },
      ],
    });

    await slack.postMessage(channel, `Comment ${i + 1}: ${c.comment?.slice(0, 100)}...`, { threadTs, blocks });
  }

  // Bulk actions at the end
  const bulkBlocks = [
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve All' },
          style: 'primary',
          action_id: 'approve_all_comments',
          value: 'all',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📤 Send to Vendor' },
          action_id: 'send_to_vendor',
          value: 'vendor',
        },
      ],
    },
  ];

  await slack.postMessage(channel, 'Bulk actions:', { threadTs, blocks: bulkBlocks });
}

// ─── Button Handlers ───

async function handleApproveComment(payload, action) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts;
  const idx = parseInt(action.value);

  const strategy = findStrategyByThread(threadTs);
  if (strategy) strategy.approvedComments.add(idx);

  // Strip action buttons and add approval badge
  const blocks = stripActionBlocks(payload.message?.blocks || []);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ *Approved* by <@${payload.user?.id}> at ${new Date().toLocaleTimeString()}` }] });

  try {
    await slack.updateMessage(channel, messageTs, `Comment ${idx + 1} approved`, blocks);
  } catch (err) {
    console.error('Approve update failed:', err.message);
  }
}

async function handleEditCommentButton(payload, action) {
  const triggerId = payload.trigger_id;
  const threadTs = payload.message?.thread_ts;
  const messageTs = payload.message?.ts;
  const idx = parseInt(action.value);

  const strategy = findStrategyByThread(threadTs);
  const comment = strategy?.strategyData?.commentsWithAlignment?.[idx];

  const modal = {
    type: 'modal',
    callback_id: 'edit_comment_submit',
    private_metadata: JSON.stringify({ threadTs, messageTs, index: idx, channel: payload.channel?.id }),
    title: { type: 'plain_text', text: 'Edit Comment' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Thread:* ${comment?.threadTitle || 'Unknown'}\n*Subreddit:* ${comment?.subreddit || 'Unknown'}` },
      },
      {
        type: 'input',
        block_id: 'comment_block',
        label: { type: 'plain_text', text: 'Comment Text' },
        element: {
          type: 'plain_text_input',
          action_id: 'comment_input',
          multiline: true,
          initial_value: comment?.comment || '',
        },
      },
    ],
  };

  await slack.openModal(triggerId, modal);
}

async function handleEditComment(payload) {
  const values = payload.view?.state?.values;
  const meta = JSON.parse(payload.view?.private_metadata || '{}');
  const newComment = values?.comment_block?.comment_input?.value;

  const strategy = findStrategyByThread(meta.threadTs);
  if (strategy && strategy.strategyData.commentsWithAlignment[meta.index]) {
    strategy.strategyData.commentsWithAlignment[meta.index].comment = newComment;
  }

  // Update the message to show edited comment
  try {
    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Comment ${meta.index + 1}* — _edited_` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\`\`\`${newComment?.slice(0, 2500)}\`\`\`` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            style: 'primary',
            action_id: `approve_comment_${meta.index}`,
            value: String(meta.index),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Edit' },
            action_id: `edit_comment_${meta.index}`,
            value: String(meta.index),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject' },
            style: 'danger',
            action_id: `reject_comment_${meta.index}`,
            value: String(meta.index),
          },
        ],
      },
    ];

    await slack.updateMessage(meta.channel, meta.messageTs, `Comment ${meta.index + 1} (edited)`, blocks);
  } catch (err) {
    console.error('Edit comment update failed:', err.message);
  }
}

async function handleRejectComment(payload, action) {
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts;
  const idx = parseInt(action.value);

  const strategy = findStrategyByThread(threadTs);
  if (strategy) strategy.rejectedComments.add(idx);

  const blocks = stripActionBlocks(payload.message?.blocks || []);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `❌ *Rejected* by <@${payload.user?.id}>` }] });

  try {
    await slack.updateMessage(channel, messageTs, `Comment ${idx + 1} rejected`, blocks);
  } catch (err) {
    console.error('Reject update failed:', err.message);
  }
}

async function handleApproveAll(payload) {
  const channel = payload.channel?.id;
  const threadTs = payload.message?.thread_ts;

  const strategy = findStrategyByThread(threadTs);
  if (!strategy) {
    await slack.postMessage(channel, '⚠️ Strategy data expired. Please re-run the strategy.', { threadTs });
    return;
  }

  const total = strategy.strategyData.commentsWithAlignment?.length || 0;
  for (let i = 0; i < total; i++) {
    strategy.approvedComments.add(i);
  }

  await slack.postMessage(channel, `✅ All ${total} comments approved by <@${payload.user?.id}>. Ready for vendor handoff.`, { threadTs });
}

async function handleSendToVendor(payload) {
  const channel = payload.channel?.id;
  const threadTs = payload.message?.thread_ts;

  const strategy = findStrategyByThread(threadTs);
  if (!strategy) {
    await slack.postMessage(channel, '⚠️ Strategy data expired. Please re-run.', { threadTs });
    return;
  }

  const approved = strategy.strategyData.commentsWithAlignment?.filter((_, i) =>
    strategy.approvedComments.has(i) && !strategy.rejectedComments.has(i)
  ) || [];

  if (approved.length === 0) {
    await slack.postMessage(channel, '⚠️ No approved comments to send. Approve comments first.', { threadTs });
    return;
  }

  // Format for vendor
  let vendorBrief = `*📤 Vendor Brief: ${strategy.clientName}*\n*Package:* ${getPackage(strategy.packageTier)?.name || strategy.packageTier}\n*Date:* ${new Date().toISOString().split('T')[0]}\n\n`;

  for (let i = 0; i < approved.length; i++) {
    const c = approved[i];
    vendorBrief += `───────────────────\n`;
    vendorBrief += `*Comment ${i + 1}*\n`;
    vendorBrief += `*Thread:* ${c.threadUrl}\n`;
    vendorBrief += `*Subreddit:* ${c.subreddit}\n`;
    vendorBrief += `*Comment:*\n${c.comment}\n\n`;
  }

  vendorBrief += `───────────────────\n*Total: ${approved.length} comments ready for posting*`;

  await slack.postMessage(channel, vendorBrief, { threadTs });
  await slack.postMessage(channel, `✅ Vendor brief generated with ${approved.length} approved comments. Forward this thread to your vendor for execution.`, { threadTs });
}

// ─── Helpers ───

function findStrategyByThread(threadTs) {
  return pendingStrategies.get(threadTs);
}

function stripActionBlocks(blocks) {
  return (blocks || []).filter(b => b.type !== 'actions');
}

function titleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
