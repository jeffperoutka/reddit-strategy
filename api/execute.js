/**
 * Execute Endpoint — Submit approved content to Engain for Reddit posting
 *
 * Reads "Approved" rows from Google Sheet, submits to Engain API,
 * updates status to "Scheduled" in the sheet, and reports back to Slack.
 *
 * Triggered by /reddit-execute Slack command.
 */
const { waitUntil } = require('@vercel/functions');
const slack = require('../lib/connectors/slack');
const engain = require('../lib/connectors/engain');
const { getSheetsClient, extractSpreadsheetId } = require('../lib/google-spreadsheet');

const PIPELINE_SECRET = process.env.PIPELINE_SECRET || 'george-internal-pipeline-2024';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Accept from Slack command (forwarded by commands.js) or direct API call with secret
  const secret = req.headers['x-pipeline-secret'];
  if (secret !== PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(202).json({ status: 'accepted' });
  waitUntil(executeApprovedContent(req, req.body).catch(err => {
    console.error('FATAL: Execute crashed:', err.message, err.stack);
    const { channel, threadTs } = req.body || {};
    if (channel && threadTs) {
      slack.postMessage(channel, `Execution failed: ${err.message}`, { threadTs }).catch(() => {});
    }
  }));
};

async function executeApprovedContent(req, params) {
  const {
    spreadsheetUrl, projectId,
    channel, threadTs, userId,
  } = params;

  const engainProjectId = projectId || process.env.ENGAIN_PROJECT_ID;
  if (!engainProjectId) {
    throw new Error('No Engain project ID. Set ENGAIN_PROJECT_ID env var or pass projectId.');
  }

  const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
  if (!spreadsheetId) {
    throw new Error(`Could not extract spreadsheet ID from: ${spreadsheetUrl}`);
  }

  const threadPost = async (text) => {
    if (channel && threadTs) return slack.postMessage(channel, text, { threadTs });
    if (channel) return slack.postMessage(channel, text);
  };

  try {
    // ── Check Engain balance ──
    const balance = await engain.getBalance();
    console.log(`[Execute] Engain balance: ${balance.creditsRemaining} credits, ${balance.freeComments} free comments`);

    // ── Read approved items from Google Sheet ──
    const sheets = getSheetsClient();
    if (!sheets) throw new Error('Could not create Sheets client');

    await threadPost('Reading approved items from the spreadsheet...');

    const approvedComments = await readApprovedRows(sheets, spreadsheetId, 'Comments', 14);
    const approvedPosts = await readApprovedRows(sheets, spreadsheetId, 'Post Drafts', 13);

    const totalItems = approvedComments.length + approvedPosts.length;
    if (totalItems === 0) {
      await threadPost('No items with status "Approved" found. Mark rows as "Approved" in the Status column, then run this again.');
      return;
    }

    await threadPost(`Found ${approvedComments.length} approved comments + ${approvedPosts.length} approved posts. Submitting to Engain...`);

    // ── Submit comments ──
    const commentResults = [];
    const RATE_DELAY = 2200; // ~27 req/min to stay under 30/min limit

    for (let i = 0; i < approvedComments.length; i++) {
      const row = approvedComments[i];
      const threadUrl = row.values[4]; // Column E: Thread URL
      const commentText = row.values[7]; // Column H: Comment Text

      if (!threadUrl || !commentText) {
        commentResults.push({ row: row.rowNum, status: 'skipped', reason: 'Missing URL or text' });
        continue;
      }

      try {
        // Schedule comments with staggered timing (10-60 min spacing)
        const delayMinutes = 10 + (i * Math.floor(50 / Math.max(approvedComments.length, 1)));
        const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

        const result = await engain.createComment(engainProjectId, threadUrl, commentText, scheduledAt);
        commentResults.push({
          row: row.rowNum,
          status: 'scheduled',
          taskId: result.id,
          scheduledAt,
        });
        console.log(`[Execute] Comment ${i + 1}/${approvedComments.length}: scheduled (${result.id})`);
      } catch (err) {
        console.error(`[Execute] Comment ${i + 1} failed:`, err.message);
        commentResults.push({ row: row.rowNum, status: 'error', reason: err.message });
      }

      if (i < approvedComments.length - 1) {
        await new Promise(r => setTimeout(r, RATE_DELAY));
      }
    }

    // ── Submit posts ──
    const postResults = [];
    for (let i = 0; i < approvedPosts.length; i++) {
      const row = approvedPosts[i];
      const subreddit = row.values[2]; // Column C: Subreddit
      const postTitle = row.values[4]; // Column E: Title
      const postBody = row.values[5]; // Column F: Post Body
      const followUpComment = row.values[6]; // Column G: Follow-Up Comment

      if (!subreddit || !postTitle || !postBody) {
        postResults.push({ row: row.rowNum, status: 'skipped', reason: 'Missing subreddit/title/body' });
        continue;
      }

      // Normalize subreddit to URL format
      const subName = subreddit.replace(/^r\//, '').replace(/^\/r\//, '').trim();
      const subredditUrl = `https://reddit.com/r/${subName}/`;

      try {
        // Schedule posts with staggered timing (30-120 min spacing)
        const delayMinutes = 30 + (i * Math.floor(90 / Math.max(approvedPosts.length, 1)));
        const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

        const result = await engain.createPost(engainProjectId, subredditUrl, postTitle, postBody, scheduledAt);
        postResults.push({
          row: row.rowNum,
          status: 'scheduled',
          taskId: result.id,
          followUpComment,
          scheduledAt,
        });
        console.log(`[Execute] Post ${i + 1}/${approvedPosts.length}: scheduled (${result.id})`);
      } catch (err) {
        console.error(`[Execute] Post ${i + 1} failed:`, err.message);
        postResults.push({ row: row.rowNum, status: 'error', reason: err.message });
      }

      if (i < approvedPosts.length - 1) {
        await new Promise(r => setTimeout(r, RATE_DELAY));
      }
    }

    // ── Update Google Sheet statuses ──
    await updateStatusCells(sheets, spreadsheetId, 'Comments', commentResults, 10); // Col K = Status
    await updateStatusCells(sheets, spreadsheetId, 'Post Drafts', postResults, 9); // Col J = Status

    // ── Store task IDs for webhook tracking ──
    // Save task mappings for the webhook handler to update Reddit URLs later
    await storeTaskMappings(sheets, spreadsheetId, commentResults, postResults);

    // ── Report to Slack ──
    const scheduledComments = commentResults.filter(r => r.status === 'scheduled').length;
    const scheduledPosts = postResults.filter(r => r.status === 'scheduled').length;
    const errors = [...commentResults, ...postResults].filter(r => r.status === 'error');

    const lines = [
      `*Execution Complete*`,
      `Scheduled: ${scheduledComments} comments, ${scheduledPosts} posts`,
    ];

    if (errors.length > 0) {
      lines.push(`Errors: ${errors.length} items failed`);
      for (const e of errors.slice(0, 5)) {
        lines.push(`  • Row ${e.row}: ${e.reason}`);
      }
    }

    lines.push(`\n_Engain will post these on the scheduled times. Reddit URLs will update automatically via webhook._`);

    await threadPost(lines.join('\n'));
    console.log(`[Execute] COMPLETE — ${scheduledComments} comments, ${scheduledPosts} posts scheduled`);

  } catch (err) {
    console.error('[Execute] Error:', err.message, err.stack);
    await threadPost(`Execution failed: ${err.message}`);
  }
}

/**
 * Read rows with status "Approved" from a sheet tab.
 * Returns array of { rowNum, values } where rowNum is 1-indexed.
 */
async function readApprovedRows(sheets, spreadsheetId, tabName, colCount) {
  try {
    const lastCol = String.fromCharCode(64 + colCount); // 14 -> N, 13 -> M
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A:${lastCol}`,
    });

    const rows = res.data.values || [];
    const approved = [];

    for (let i = 1; i < rows.length; i++) { // Skip header
      const row = rows[i] || [];
      // Status column: Comments = col K (index 10), Post Drafts = col J (index 9)
      const statusIdx = tabName === 'Comments' ? 10 : 9;
      const status = (row[statusIdx] || '').trim().toLowerCase();

      if (status === 'approved') {
        approved.push({ rowNum: i + 1, values: row }); // +1 for 1-indexed sheets
      }
    }

    console.log(`[Execute] ${tabName}: ${approved.length} approved rows out of ${rows.length - 1} total`);
    return approved;
  } catch (err) {
    console.error(`[Execute] Could not read ${tabName}:`, err.message);
    return [];
  }
}

/**
 * Update status cells in the Google Sheet.
 */
async function updateStatusCells(sheets, spreadsheetId, tabName, results, statusColIdx) {
  const statusCol = String.fromCharCode(64 + statusColIdx + 1); // 10 -> K, 9 -> J
  const batchData = [];

  for (const r of results) {
    if (r.status === 'scheduled') {
      batchData.push({
        range: `'${tabName}'!${statusCol}${r.row}`,
        values: [['Scheduled']],
      });
    } else if (r.status === 'error') {
      batchData.push({
        range: `'${tabName}'!${statusCol}${r.row}`,
        values: [[`Error: ${r.reason?.slice(0, 50)}`]],
      });
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: batchData },
    });
  }
}

/**
 * Store Engain task ID → sheet row mappings in a hidden "Task Map" tab.
 * The webhook handler uses this to find which row to update when a task completes.
 */
async function storeTaskMappings(sheets, spreadsheetId, commentResults, postResults) {
  const allScheduled = [
    ...commentResults.filter(r => r.status === 'scheduled').map(r => ({
      taskId: r.taskId, tab: 'Comments', row: r.row, type: 'comment',
      followUpComment: '',
    })),
    ...postResults.filter(r => r.status === 'scheduled').map(r => ({
      taskId: r.taskId, tab: 'Post Drafts', row: r.row, type: 'post',
      followUpComment: r.followUpComment || '',
    })),
  ];

  if (allScheduled.length === 0) return;

  // Ensure "Task Map" tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existingTabs = new Set((meta.data.sheets || []).map(s => s.properties.title));

  if (!existingTabs.has('Task Map')) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: 'Task Map', hidden: true },
          },
        }],
      },
    });
    // Add header
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "'Task Map'!A1",
      valueInputOption: 'RAW',
      requestBody: {
        values: [['Task ID', 'Tab', 'Row', 'Type', 'Follow-Up Comment', 'Status', 'Reddit URL']],
      },
    });
  }

  // Get next row
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Task Map'!A:A",
  });
  const nextRow = (existing.data.values?.length || 1) + 1;

  const rows = allScheduled.map(s => [
    s.taskId, s.tab, String(s.row), s.type, s.followUpComment, 'scheduled', '',
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'Task Map'!A${nextRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  console.log(`[Execute] Stored ${rows.length} task mappings in Task Map tab`);
}
