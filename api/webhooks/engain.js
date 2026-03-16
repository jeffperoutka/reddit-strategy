/**
 * Engain Webhook Handler
 *
 * Receives task.completed and order.completed webhooks from Engain.
 *
 * On task.completed:
 * 1. Updates the Google Sheet row with the Reddit URL and "Published" status
 * 2. If the task is a post with a follow-up comment, auto-submits the follow-up
 * 3. Submits upvotes for the published content
 *
 * Configure in Engain dashboard: webhook URL = https://your-domain.vercel.app/api/webhooks/engain
 */
const { waitUntil } = require('@vercel/functions');
const engain = require('../../lib/connectors/engain');
const { getSheetsClient } = require('../../lib/google-spreadsheet');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body;
  const event = payload?.event;

  console.log(`[Webhook] Received event: ${event}, taskId: ${payload?.taskId || payload?.orderId}`);

  // Acknowledge immediately
  res.status(200).json({ ok: true });

  if (event === 'task.completed') {
    waitUntil(handleTaskCompleted(payload).catch(err => {
      console.error('[Webhook] task.completed handler failed:', err.message);
    }));
  } else if (event === 'order.completed') {
    waitUntil(handleOrderCompleted(payload).catch(err => {
      console.error('[Webhook] order.completed handler failed:', err.message);
    }));
  }
};

async function handleTaskCompleted(payload) {
  const {
    taskId, projectId, type, status, content,
    redditUrl, subreddit, postTitle, publishedAt,
  } = payload;

  console.log(`[Webhook] Task completed: ${taskId} (${type}) → ${redditUrl || 'no URL'}`);

  if (status !== 'published') {
    console.log(`[Webhook] Task ${taskId} status is "${status}", not "published". Skipping.`);
    return;
  }

  const sheets = getSheetsClient();
  if (!sheets) {
    console.error('[Webhook] No Sheets client — cannot update spreadsheet');
    return;
  }

  // Find the task in all spreadsheets that have a Task Map tab
  // We search by taskId in the Task Map
  const mapping = await findTaskMapping(sheets, taskId);
  if (!mapping) {
    console.log(`[Webhook] No mapping found for task ${taskId}. May be a manual Engain task.`);
    return;
  }

  const { spreadsheetId, tab, row, followUpComment, taskType } = mapping;

  // ── Update the row with Reddit URL and Published status ──
  const statusCol = tab === 'Comments' ? 'K' : 'J';
  const linkCol = tab === 'Comments' ? 'L' : 'K';
  const dateCol = tab === 'Comments' ? 'M' : 'L';

  const batchData = [
    { range: `'${tab}'!${statusCol}${row}`, values: [['Published']] },
    { range: `'${tab}'!${dateCol}${row}`, values: [[new Date().toISOString().split('T')[0]]] },
  ];

  if (redditUrl) {
    batchData.push({ range: `'${tab}'!${linkCol}${row}`, values: [[redditUrl]] });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: batchData },
  });

  console.log(`[Webhook] Updated ${tab} row ${row}: Published, URL: ${redditUrl}`);

  // ── Update Task Map status ──
  await updateTaskMapStatus(sheets, spreadsheetId, taskId, 'published', redditUrl);

  // ── If this is a post with a follow-up comment, schedule the reply ──
  if (taskType === 'post' && followUpComment && redditUrl) {
    const engainProjectId = projectId || process.env.ENGAIN_PROJECT_ID;
    if (engainProjectId) {
      try {
        // Wait 15-45 minutes before posting the follow-up comment
        const delayMinutes = 15 + Math.floor(Math.random() * 30);
        const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

        const result = await engain.createComment(engainProjectId, redditUrl, followUpComment, scheduledAt);
        console.log(`[Webhook] Follow-up comment scheduled for post ${taskId}: ${result.id} in ${delayMinutes}min`);
      } catch (err) {
        console.error(`[Webhook] Follow-up comment failed for post ${taskId}:`, err.message);
      }
    }
  }

  // ── Submit upvotes for published content ──
  const engainProjectId = projectId || process.env.ENGAIN_PROJECT_ID;
  if (engainProjectId && redditUrl) {
    try {
      // Read upvote plan from the sheet to find matching allocation
      const upvoteCount = await getUpvoteAllocation(sheets, spreadsheetId, tab, row);
      if (upvoteCount > 0) {
        const target = type === 'post' ? 'post' : 'comment';
        // Delay upvotes 30-90 minutes after posting
        const delayMinutes = 30 + Math.floor(Math.random() * 60);
        const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

        await engain.createUpvote(engainProjectId, redditUrl, upvoteCount, target, {
          scheduledAt,
          upvotesPerDay: 3, // Conservative velocity
        });
        console.log(`[Webhook] ${upvoteCount} upvotes scheduled for ${redditUrl} in ${delayMinutes}min`);
      }
    } catch (err) {
      console.error(`[Webhook] Upvote scheduling failed:`, err.message);
    }
  }
}

async function handleOrderCompleted(payload) {
  const { orderId, status, quantity, redditUrl } = payload;
  console.log(`[Webhook] Order completed: ${orderId} — ${quantity} upvotes on ${redditUrl} (${status})`);
  // Orders are fire-and-forget — just log for audit
}

/**
 * Find a task mapping across all spreadsheets.
 * We search by looking up the task ID in stored Task Map tabs.
 *
 * For now, we use the ENGAIN_ACTIVE_SPREADSHEET_ID env var to know which sheet to check.
 * This gets set by the execute endpoint.
 */
async function findTaskMapping(sheets, taskId) {
  // Try the active spreadsheet first
  const spreadsheetId = process.env.ENGAIN_ACTIVE_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.log('[Webhook] No ENGAIN_ACTIVE_SPREADSHEET_ID set');
    return null;
  }

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Task Map'!A:G",
    });

    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === taskId) {
        return {
          spreadsheetId,
          tab: rows[i][1],
          row: parseInt(rows[i][2]),
          taskType: rows[i][3],
          followUpComment: rows[i][4] || '',
        };
      }
    }
  } catch (err) {
    console.error(`[Webhook] Could not read Task Map:`, err.message);
  }

  return null;
}

async function updateTaskMapStatus(sheets, spreadsheetId, taskId, status, redditUrl) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Task Map'!A:G",
    });

    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === taskId) {
        const batchData = [
          { range: `'Task Map'!F${i + 1}`, values: [[status]] },
        ];
        if (redditUrl) {
          batchData.push({ range: `'Task Map'!G${i + 1}`, values: [[redditUrl]] });
        }
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: batchData },
        });
        return;
      }
    }
  } catch (err) {
    console.error('[Webhook] Could not update Task Map:', err.message);
  }
}

/**
 * Get the upvote allocation for a specific content item from the Upvote Plan tab.
 * Matches by target text (thread title for comments, post title for posts).
 */
async function getUpvoteAllocation(sheets, spreadsheetId, tab, row) {
  try {
    // Read the target name from the content row
    const targetCol = tab === 'Comments' ? 'D' : 'E'; // Thread Title or Post Title
    const targetRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'!${targetCol}${row}`,
    });
    const targetName = (targetRes.data.values?.[0]?.[0] || '').trim();
    if (!targetName) return 0;

    // Search Upvote Plan for matching target
    const upvoteRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Upvote Plan'!A:H",
    });
    const upvoteRows = upvoteRes.data.values || [];

    for (let i = 1; i < upvoteRows.length; i++) {
      const upTarget = (upvoteRows[i][2] || '').trim(); // Column C = Target
      const upvotes = parseInt(upvoteRows[i][4]) || 0;  // Column E = Upvotes Allocated
      if (upTarget && targetName.includes(upTarget.slice(0, 30))) {
        return upvotes;
      }
    }
  } catch (err) {
    console.error('[Webhook] Could not read upvote allocation:', err.message);
  }
  return 3; // Default fallback: 3 upvotes
}
