/**
 * Google Sheets Report Builder
 *
 * Creates client-presentable Google Sheets reports with:
 *   1. Executive Summary
 *   2. Threads & Comments (combined)
 *   3. Posts
 *   4. Upvote Plan
 *   5. Reporting Tracker (appends month-over-month)
 *
 * Output goes into the same Google Drive folder as the client info doc.
 * Month 2+ appends new tabs to the existing strategy sheet.
 */

const gs = require('./connectors/google-sheets');
const { google } = require('googleapis');

// Tab color palette (RGB 0-1 scale)
const TAB_COLORS = {
  summary:   { red: 0.42, green: 0.36, blue: 0.9 },   // Purple
  threads:   { red: 0, green: 0.72, blue: 0.58 },      // Teal
  posts:     { red: 0, green: 0.81, blue: 0.79 },       // Cyan
  upvotes:   { red: 0.88, green: 0.44, blue: 0.33 },    // Orange
  tracker:   { red: 0.91, green: 0.26, blue: 0.58 },    // Pink
};

/**
 * Build a Google Sheets report in the same Drive folder as the client info doc.
 *
 * @param {object} strategyData - Full pipeline output
 * @param {object} brandProfile - Brand profile
 * @param {string} packageTier - Package tier key
 * @param {object} formData - { month, prevSpreadsheetUrl, packageName, clientDocUrl }
 * @returns {string} Google Sheets URL with editing access
 */
async function buildGoogleSheetsReport(strategyData, brandProfile, packageTier, formData = {}) {
  const clientName = brandProfile.clientName || 'Client';
  const month = formData.month || '1';
  const monthNum = parseInt(month) || 1;

  // Determine the target Drive folder from the client info doc
  const targetFolderId = await getDocParentFolder(formData.clientDocUrl);

  // Check if a strategy sheet already exists for this client in the folder
  let spreadsheetId = null;
  let isAppend = false;

  if (targetFolderId) {
    spreadsheetId = await findExistingStrategySheet(targetFolderId, clientName);
  }

  // Also check previous spreadsheet URL
  if (!spreadsheetId && formData.prevSpreadsheetUrl) {
    const prevId = gs.extractSpreadsheetId(formData.prevSpreadsheetUrl);
    if (prevId) {
      try {
        const meta = await gs.getSheetMetadata(prevId);
        if (meta.length > 0) spreadsheetId = prevId;
      } catch (err) {
        console.error('Could not access previous spreadsheet:', err.message);
      }
    }
  }

  if (spreadsheetId) {
    isAppend = true;
  } else {
    // Create new spreadsheet
    const title = `Reddit Strategy — ${clientName}`;
    const created = await gs.createSpreadsheet(title);
    spreadsheetId = created.spreadsheetId;

    // Move to the same folder as the client info doc
    if (targetFolderId) {
      await moveFileToFolder(spreadsheetId, targetFolderId);
    }
  }

  if (isAppend) {
    await appendMonthToExisting(spreadsheetId, strategyData, brandProfile, packageTier, formData);
  } else {
    await buildFreshReport(spreadsheetId, strategyData, brandProfile, packageTier, formData);
  }

  // Share with editing access
  const url = await gs.shareWithEditing(spreadsheetId);
  return url;
}

// ─── Drive Helpers ───

function getDriveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    try { creds = JSON.parse(raw.replace(/\\n/g, '\n')); } catch (e2) { return null; }
  }
  if (!creds.client_email || !creds.private_key) return null;

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Get the parent folder ID of a Google Doc.
 */
async function getDocParentFolder(docUrl) {
  if (!docUrl) return null;
  const match = (docUrl || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const docId = match[1];

  try {
    const drive = getDriveClient();
    if (!drive) return null;
    const resp = await drive.files.get({ fileId: docId, fields: 'parents' });
    return resp.data.parents?.[0] || null;
  } catch (err) {
    console.error('getDocParentFolder error:', err.message);
    return null;
  }
}

/**
 * Find an existing "Reddit Strategy — ClientName" sheet in a folder.
 */
async function findExistingStrategySheet(folderId, clientName) {
  try {
    const drive = getDriveClient();
    if (!drive) return null;
    const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and name contains 'Reddit Strategy' and name contains '${clientName.replace(/'/g, "\\'")}'  and trashed=false`;
    const resp = await drive.files.list({ q: query, fields: 'files(id,name)', pageSize: 5 });
    if (resp.data.files?.length > 0) {
      console.log(`Found existing strategy sheet: ${resp.data.files[0].name} (${resp.data.files[0].id})`);
      return resp.data.files[0].id;
    }
    return null;
  } catch (err) {
    console.error('findExistingStrategySheet error:', err.message);
    return null;
  }
}

/**
 * Move a file into a specific Drive folder.
 */
async function moveFileToFolder(fileId, folderId) {
  try {
    const drive = getDriveClient();
    if (!drive) return;
    // Get current parents
    const file = await drive.files.get({ fileId, fields: 'parents' });
    const currentParents = (file.data.parents || []).join(',');
    // Move to target folder
    await drive.files.update({
      fileId,
      addParents: folderId,
      removeParents: currentParents,
      fields: 'id, parents',
    });
  } catch (err) {
    console.error('moveFileToFolder error:', err.message);
  }
}

// ─── Build a brand new report (Month 1 or no existing sheet) ───

async function buildFreshReport(spreadsheetId, strategyData, brandProfile, packageTier, formData) {
  const clientName = brandProfile.clientName || 'Client';
  const month = formData.month || '1';
  const monthLabel = `Month ${month}`;
  const report = strategyData.report || {};
  const comments = strategyData.commentsWithAlignment || [];
  const posts = strategyData.posts || [];
  const analyzedThreads = strategyData.threadAnalysis?.analyzedThreads || [];
  const upvotePlan = strategyData.upvotePlan;

  // Get the default Sheet1 to delete later
  const initialMeta = await gs.getSheetMetadata(spreadsheetId);
  const defaultSheetId = initialMeta[0]?.sheetId;

  // Create tabs (condensed: 5 tabs)
  const summaryId = await gs.addSheet(spreadsheetId, 'Executive Summary', TAB_COLORS.summary);
  const threadsCommentsId = await gs.addSheet(spreadsheetId, 'Threads & Comments', TAB_COLORS.threads);
  const postId = await gs.addSheet(spreadsheetId, 'Posts', TAB_COLORS.posts);
  const upvoteId = await gs.addSheet(spreadsheetId, 'Upvote Plan', TAB_COLORS.upvotes);
  const trackerId = await gs.addSheet(spreadsheetId, 'Reporting Tracker', TAB_COLORS.tracker);

  // Delete default Sheet1
  if (defaultSheetId !== undefined) {
    await gs.deleteSheet(spreadsheetId, defaultSheetId);
  }

  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // ── Sheet 1: Executive Summary ──
  const summaryData = buildSummaryData(clientName, monthLabel, dateStr, formData, strategyData, report, comments, posts);

  // ── Sheet 2: Threads & Comments (combined) ──
  const tcHeaders = ['#', 'Type', 'Subreddit', 'Thread Title', 'Thread URL', 'Category/Angle',
    'Score', 'Comment/Opportunity Text', 'Brand Mention', 'Spam Risk', 'Status', 'Notes'];
  const tcData = [tcHeaders];

  // Add threads first
  analyzedThreads.forEach((t, i) => {
    tcData.push([
      i + 1, 'THREAD', t.subreddit || '', t.title || '', t.url || '',
      (t.category || '').replace('_', ' ').toUpperCase(),
      t.overallScore || 0, t.opportunity || '', '', '', '', t.suggestedAngle || '',
    ]);
  });

  // Add comments
  comments.forEach((c, i) => {
    const a = c.alignment || {};
    tcData.push([
      analyzedThreads.length + i + 1, 'COMMENT', c.subreddit || '', c.threadTitle || '', c.threadUrl || '',
      c.angle || '', a.score || 0, c.comment || '',
      c.brandMentionType || '', a.spamRisk || '', 'Pending Review', (a.issues || []).join('; '),
    ]);
  });

  // ── Sheet 3: Posts ──
  const postHeaders = ['#', 'Subreddit', 'Post Type', 'Title', 'Post Body',
    'Follow-Up Comment', 'Brand Mention Strategy', 'Engagement Potential', 'Status', 'Notes'];
  const postData = [postHeaders];
  if (posts.length > 0) {
    posts.forEach((p, i) => {
      postData.push([
        i + 1, p.subreddit || '', p.postType || '', p.title || '', p.body || '',
        p.followUpComment || '', p.brandMentionStrategy || '', p.engagementPotential || '',
        'Pending Review', '',
      ]);
    });
  } else {
    postData.push(['', '', '', 'No posts included in this package tier', '', '', '', '', '', '']);
  }

  // ── Sheet 4: Upvote Plan ──
  const upvoteHeaders = ['#', 'Content Type', 'Target', 'Subreddit', 'Upvotes Allocated', 'Timing', 'Priority', 'Notes'];
  const upvoteData = [upvoteHeaders];
  if (upvotePlan?.distribution?.length > 0) {
    upvotePlan.distribution.forEach((item, i) => {
      upvoteData.push([
        i + 1, item.contentType || item.type || '', item.target || '', item.subreddit || '',
        item.upvotes || 0, item.timing || '', (item.priority || '').toUpperCase(), item.notes || '',
      ]);
    });
    upvoteData.push(['', '', 'TOTAL', '', upvotePlan.totalUpvotes || 0, '', '', '']);
  } else {
    upvoteData.push(['', '', 'Upvote support not included in this package tier', '', '', '', '', '']);
  }

  // ── Sheet 5: Reporting Tracker ──
  const trackerHeaders = ['Month', 'Keywords', 'Threads Found', 'Comments Drafted', 'Comments Posted',
    'Posts Drafted', 'Posts Published', 'Upvotes Used', 'Risk Level', 'Notes'];
  const trackerData = [trackerHeaders];
  trackerData.push([
    monthLabel, String(strategyData.keywords?.length || 0), String(strategyData.threads?.length || 0),
    String(comments.length), '0',
    String(posts.length), '0', String(upvotePlan?.totalUpvotes || 0),
    (report.riskAssessment?.overallRisk || 'unknown').toUpperCase(),
    'Update after execution',
  ]);

  // ── Write all data in batch ──
  await gs.batchWrite(spreadsheetId, [
    { range: "'Executive Summary'!A1", values: summaryData },
    { range: "'Threads & Comments'!A1", values: tcData },
    { range: "'Posts'!A1", values: postData },
    { range: "'Upvote Plan'!A1", values: upvoteData },
    { range: "'Reporting Tracker'!A1", values: trackerData },
  ]);

  // ── Apply formatting ──
  const formatRequests = [
    gs.headerFormatRequest(threadsCommentsId, tcHeaders.length),
    gs.headerFormatRequest(postId, postHeaders.length),
    gs.headerFormatRequest(upvoteId, upvoteHeaders.length),
    gs.headerFormatRequest(trackerId, trackerHeaders.length),
    gs.freezeRowRequest(threadsCommentsId),
    gs.freezeRowRequest(postId),
    gs.freezeRowRequest(upvoteId),
    gs.freezeRowRequest(trackerId),
    gs.autoResizeRequest(threadsCommentsId, tcHeaders.length),
    gs.autoResizeRequest(postId, postHeaders.length),
    gs.autoResizeRequest(upvoteId, upvoteHeaders.length),
    gs.autoResizeRequest(trackerId, trackerHeaders.length),
    // Executive Summary formatting
    {
      repeatCell: {
        range: { sheetId: summaryId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 18, foregroundColor: { red: 0.1, green: 0.1, blue: 0.18 } } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    {
      repeatCell: {
        range: { sheetId: summaryId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { italic: true, fontSize: 10, foregroundColor: { red: 0.53, green: 0.53, blue: 0.53 } } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    {
      repeatCell: {
        range: { sheetId: summaryId, startRowIndex: 4, endRowIndex: summaryData.length, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 11 } } },
        fields: 'userEnteredFormat.textFormat',
      },
    },
    { updateDimensionProperties: { properties: { pixelSize: 250 }, range: { sheetId: summaryId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { properties: { pixelSize: 600 }, range: { sheetId: summaryId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, fields: 'pixelSize' } },
  ];

  // Score coloring for threads/comments
  tcData.forEach((row, i) => {
    if (i === 0) return; // skip header
    const score = row[6];
    if (typeof score === 'number' && score > 0) {
      formatRequests.push(gs.colorCellsRequest(threadsCommentsId, i, i + 1, 6, 7, gs.scoreColor(score)));
    }
  });

  await gs.batchFormat(spreadsheetId, formatRequests);
}

// ─── Append to existing spreadsheet (Month 2+) ───

async function appendMonthToExisting(spreadsheetId, strategyData, brandProfile, packageTier, formData) {
  const month = formData.month || '2';
  const monthLabel = `Month ${month}`;
  const report = strategyData.report || {};
  const comments = strategyData.commentsWithAlignment || [];
  const posts = strategyData.posts || [];
  const analyzedThreads = strategyData.threadAnalysis?.analyzedThreads || [];
  const upvotePlan = strategyData.upvotePlan;

  const meta = await gs.getSheetMetadata(spreadsheetId);
  const tabNames = meta.map(m => m.title);

  const mPrefix = `M${month}`;

  // Add month-specific tabs
  const tcTabName = `${mPrefix} Threads & Comments`;
  const tcId = await gs.addSheet(spreadsheetId, tcTabName, TAB_COLORS.threads);

  const tcHeaders = ['#', 'Type', 'Subreddit', 'Thread Title', 'Thread URL', 'Category/Angle',
    'Score', 'Comment/Opportunity Text', 'Brand Mention', 'Spam Risk', 'Status', 'Notes'];
  const tcData = [tcHeaders];

  analyzedThreads.forEach((t, i) => {
    tcData.push([
      i + 1, 'THREAD', t.subreddit || '', t.title || '', t.url || '',
      (t.category || '').replace('_', ' ').toUpperCase(),
      t.overallScore || 0, t.opportunity || '', '', '', '', t.suggestedAngle || '',
    ]);
  });

  comments.forEach((c, i) => {
    const a = c.alignment || {};
    tcData.push([
      analyzedThreads.length + i + 1, 'COMMENT', c.subreddit || '', c.threadTitle || '', c.threadUrl || '',
      c.angle || '', a.score || 0, c.comment || '',
      c.brandMentionType || '', a.spamRisk || '', 'Pending Review', (a.issues || []).join('; '),
    ]);
  });

  const postTabName = `${mPrefix} Posts`;
  const postId = await gs.addSheet(spreadsheetId, postTabName, TAB_COLORS.posts);

  const postHeaders = ['#', 'Subreddit', 'Post Type', 'Title', 'Post Body',
    'Follow-Up Comment', 'Brand Mention Strategy', 'Engagement Potential', 'Status', 'Notes'];
  const postData = [postHeaders];
  if (posts.length > 0) {
    posts.forEach((p, i) => {
      postData.push([
        i + 1, p.subreddit || '', p.postType || '', p.title || '', p.body || '',
        p.followUpComment || '', p.brandMentionStrategy || '', p.engagementPotential || '',
        'Pending Review', '',
      ]);
    });
  }

  let upvoteId;
  if (upvotePlan?.distribution?.length > 0) {
    const upvoteTabName = `${mPrefix} Upvotes`;
    upvoteId = await gs.addSheet(spreadsheetId, upvoteTabName, TAB_COLORS.upvotes);

    const upvoteHeaders = ['#', 'Content Type', 'Target', 'Subreddit', 'Upvotes Allocated', 'Timing', 'Priority', 'Notes'];
    const upvoteData = [upvoteHeaders];
    upvotePlan.distribution.forEach((item, i) => {
      upvoteData.push([
        i + 1, item.contentType || item.type || '', item.target || '', item.subreddit || '',
        item.upvotes || 0, item.timing || '', (item.priority || '').toUpperCase(), item.notes || '',
      ]);
    });
    upvoteData.push(['', '', 'TOTAL', '', upvotePlan.totalUpvotes || 0, '', '', '']);
    await gs.writeRange(spreadsheetId, `'${upvoteTabName}'!A1`, upvoteData);
  }

  // Write new month data
  await gs.batchWrite(spreadsheetId, [
    { range: `'${tcTabName}'!A1`, values: tcData },
    { range: `'${postTabName}'!A1`, values: postData },
  ]);

  // Append to Reporting Tracker
  if (tabNames.includes('Reporting Tracker')) {
    await gs.appendRows(spreadsheetId, "'Reporting Tracker'!A:A", [[
      monthLabel, String(strategyData.keywords?.length || 0), String(strategyData.threads?.length || 0),
      String(comments.length), '0',
      String(posts.length), '0', String(upvotePlan?.totalUpvotes || 0),
      (report.riskAssessment?.overallRisk || 'unknown').toUpperCase(),
      `${monthLabel} data — update after execution`,
    ]]);
  }

  // Update Executive Summary with latest month info
  if (tabNames.includes('Executive Summary')) {
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const summaryData = buildSummaryData(
      brandProfile.clientName || 'Client', `Month ${month}`, dateStr, formData,
      strategyData, report, comments, posts
    );
    await gs.writeRange(spreadsheetId, "'Executive Summary'!A1", summaryData);
  }

  // Format new tabs
  const formatRequests = [
    gs.headerFormatRequest(tcId, 12),
    gs.headerFormatRequest(postId, 10),
    gs.freezeRowRequest(tcId),
    gs.freezeRowRequest(postId),
    gs.autoResizeRequest(tcId, 12),
    gs.autoResizeRequest(postId, 10),
  ];

  if (upvoteId) {
    formatRequests.push(gs.headerFormatRequest(upvoteId, 8));
    formatRequests.push(gs.freezeRowRequest(upvoteId));
    formatRequests.push(gs.autoResizeRequest(upvoteId, 8));
  }

  await gs.batchFormat(spreadsheetId, formatRequests);
}

// ─── Shared Helpers ───

function buildSummaryData(clientName, monthLabel, dateStr, formData, strategyData, report, comments, posts) {
  const summaryData = [
    ['', ''],
    [`Reddit Strategy Report — ${clientName}`, ''],
    [`${monthLabel} | Generated by George Reddit Bot | ${dateStr}`, ''],
    ['', ''],
    ['Package', formData.packageName || ''],
    ['Keywords Researched', (strategyData.keywords || []).join(', ')],
    ['Threads Discovered', String(strategyData.threads?.length || 0)],
    ['Comments Drafted', String(comments.length)],
    ['Posts Drafted', String(posts.length)],
    ['Campaign Month', monthLabel],
    ['', ''],
    ['Executive Summary', report.executiveSummary || 'N/A'],
    ['', ''],
    ['Risk Level', (report.riskAssessment?.overallRisk || 'unknown').toUpperCase()],
    ['', ''],
    ['Recommended Actions', 'Priority / Timeline'],
  ];

  for (const act of (report.recommendedActions || []).slice(0, 8)) {
    summaryData.push([act.action, `${(act.priority || '').toUpperCase()} — ${act.timeline || 'TBD'}`]);
  }

  return summaryData;
}

module.exports = { buildGoogleSheetsReport };
