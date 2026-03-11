/**
 * Google Sheets Report Builder
 *
 * Uses domain-wide delegation to impersonate a real user (GOOGLE_IMPERSONATE_EMAIL),
 * so files are created under that user's Drive quota — not the service account's
 * (which has 0 bytes).
 *
 * Month 2+ Appending:
 * When prevSpreadsheetUrl is provided and month > 1, new month-prefixed tabs
 * are appended to the existing spreadsheet instead of creating a new file.
 *
 * Setup required (one-time):
 * 1. Google Workspace Admin → Security → API Controls → Domain-wide Delegation
 * 2. Add the service account's client_id
 * 3. Authorize scopes: drive + spreadsheets
 * 4. Set GOOGLE_IMPERSONATE_EMAIL env var in Vercel (e.g., jeff@aeolabs.ai)
 *
 * Output goes into the same Google Drive folder as the client info doc.
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { buildStrategySpreadsheet } = require('./spreadsheet');
const { parseServiceAccountKey } = require('./connectors/google-sheets');

// ─── Auth helpers ───

function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
  const creds = parseServiceAccountKey(raw);
  if (!creds.client_email || !creds.private_key) return null;

  const impersonateEmail = process.env.GOOGLE_IMPERSONATE_EMAIL;

  if (impersonateEmail) {
    console.log(`[GoogleSheets] Using impersonation: ${impersonateEmail}`);
    return new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
      subject: impersonateEmail,
    });
  }

  console.log('[GoogleSheets] No GOOGLE_IMPERSONATE_EMAIL set — using direct service account');
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
}

function getDriveClient(auth) {
  return google.drive({ version: 'v3', auth });
}

function getSheetsClient(auth) {
  return google.sheets({ version: 'v4', auth });
}

/**
 * Build a Google Sheets report and upload to Google Drive.
 * For Month 2+, appends new tabs to the existing spreadsheet.
 *
 * @param {object} strategyData - Full pipeline output
 * @param {object} brandProfile - Brand profile
 * @param {string} packageTier - Package tier key
 * @param {object} formData - { month, prevSpreadsheetUrl, packageName, clientDocUrl }
 * @returns {{ xlsxBuffer: Buffer, driveUrl: string|null }} XLSX buffer + optional Drive URL
 */
async function buildGoogleSheetsReport(strategyData, brandProfile, packageTier, formData = {}) {
  const clientName = brandProfile.clientName || 'Client';
  const month = parseInt(formData.month) || 1;

  // Step 1: Build the XLSX in memory (always — serves as fallback + Slack attachment)
  console.log('[GoogleSheets] Building XLSX...');
  const xlsxBuffer = await buildStrategySpreadsheet(strategyData, brandProfile, packageTier, formData);
  console.log(`[GoogleSheets] XLSX built: ${(xlsxBuffer.length / 1024).toFixed(1)}KB`);

  // Step 2: Get auth + clients
  const auth = getAuthClient();
  if (!auth) {
    console.log('[GoogleSheets] No auth client — returning XLSX only');
    return { xlsxBuffer, driveUrl: null };
  }

  const drive = getDriveClient(auth);

  // Step 3: Month 2+ with existing spreadsheet → append tabs
  const prevSpreadsheetId = extractSpreadsheetId(formData.prevSpreadsheetUrl);
  if (month > 1 && prevSpreadsheetId) {
    console.log(`[GoogleSheets] Month ${month} — appending tabs to existing sheet ${prevSpreadsheetId}`);
    try {
      const sheets = getSheetsClient(auth);
      await appendMonthTabs(sheets, prevSpreadsheetId, strategyData, brandProfile, packageTier, formData);
      const webViewLink = `https://docs.google.com/spreadsheets/d/${prevSpreadsheetId}/edit`;
      console.log(`[GoogleSheets] Tabs appended to existing sheet`);
      return { xlsxBuffer, driveUrl: webViewLink };
    } catch (err) {
      console.error(`[GoogleSheets] Failed to append to existing sheet: ${err.message}`);
      console.log('[GoogleSheets] Falling back to creating new sheet...');
      // Fall through to create new file
    }
  }

  // Step 4: Create new Google Sheet (Month 1 or fallback)
  const targetFolderId = await getDocParentFolder(drive, formData.clientDocUrl);
  console.log(`[GoogleSheets] Target folder: ${targetFolderId || 'user root'}`);

  const title = `Reddit Strategy — ${clientName}`;
  console.log(`[GoogleSheets] Uploading as Google Sheet: "${title}"`);

  const fileMetadata = {
    name: title,
    mimeType: 'application/vnd.google-apps.spreadsheet',
  };

  if (targetFolderId) {
    fileMetadata.parents = [targetFolderId];
  }

  const resp = await drive.files.create({
    requestBody: fileMetadata,
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: Readable.from(xlsxBuffer),
    },
    fields: 'id, webViewLink',
  });

  const fileId = resp.data.id;
  let webViewLink = resp.data.webViewLink;
  console.log(`[GoogleSheets] Created: ${fileId}`);

  // Share with anyone (editing access)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'writer', type: 'anyone' },
  });
  console.log(`[GoogleSheets] Shared with editing access`);

  if (!webViewLink) {
    webViewLink = `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
  }

  return { xlsxBuffer, driveUrl: webViewLink };
}

// ─── Month 2+ Row Appending ───

/**
 * Append month data to existing tabs in the spreadsheet.
 * Adds a black separator row with "Month N" then appends all new data rows.
 * Falls back to creating new tabs if existing ones aren't found.
 */
async function appendMonthTabs(sheets, spreadsheetId, strategyData, brandProfile, packageTier, formData) {
  const month = parseInt(formData.month) || 1;
  const monthLabel = `Month ${month}`;
  const comments = strategyData.commentsWithAlignment || [];
  const posts = strategyData.posts || [];
  const analyzedThreads = strategyData.threadAnalysis?.analyzedThreads || [];
  const report = strategyData.report || {};
  const upvotePlan = strategyData.upvotePlan;

  // Get existing sheet metadata
  const existingMeta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetMap = {};
  for (const s of existingMeta.data.sheets || []) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }
  const existingNames = new Set(Object.keys(sheetMap));

  // Tab names to look for (same as Month 1 creates)
  const tabNames = {
    threads: 'Threads & Comments',
    posts: 'Post Drafts',
    upvotes: 'Upvote Plan',
  };

  const batchData = [];
  const formatRequests = [];

  // Helper: get the number of existing rows in a tab
  async function getRowCount(tabName) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A:A`,
      });
      return res.data.values?.length || 1;
    } catch {
      return 1;
    }
  }

  // Helper: build a separator row (empty values but we'll format it black)
  function separatorRow(colCount, label) {
    const row = new Array(colCount).fill('');
    row[0] = label;
    return row;
  }

  // ── Threads & Comments ──
  if (existingNames.has(tabNames.threads)) {
    const existingRows = await getRowCount(tabNames.threads);
    const separatorRowIdx = existingRows; // 0-indexed for formatting
    const tcColCount = 15; // Updated column count with Month, Comment/Post Link, Posting Date

    // Separator row + data rows
    const tcRows = [];
    tcRows.push(separatorRow(tcColCount, `── ${monthLabel} ──`));

    // Threads
    analyzedThreads.forEach((t, i) => {
      tcRows.push([
        i + 1, monthLabel, 'THREAD', t.subreddit || '', t.title || '', t.url || '',
        (t.category || '').replace('_', ' ').toUpperCase(), t.overallScore || 0,
        t.opportunity || '', '', '', '', '', '', t.suggestedAngle || '',
      ]);
    });

    // Comments
    comments.forEach((c, i) => {
      const a = c.alignment || {};
      tcRows.push([
        analyzedThreads.length + i + 1, monthLabel, 'COMMENT', c.subreddit || '', c.threadTitle || '',
        c.threadUrl || '', c.angle || '', a.score || 0, c.comment || '',
        c.brandMentionType || '', a.spamRisk || '', 'Pending Review', '', '', (a.issues || []).join('; '),
      ]);
    });

    batchData.push({ range: `'${tabNames.threads}'!A${existingRows + 1}`, values: tcRows });

    // Format separator row: black background, white bold text
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: sheetMap[tabNames.threads],
          startRowIndex: separatorRowIdx,
          endRowIndex: separatorRowIdx + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0, green: 0, blue: 0 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  }

  // ── Post Drafts ──
  if (existingNames.has(tabNames.posts)) {
    const existingRows = await getRowCount(tabNames.posts);
    const separatorRowIdx = existingRows;
    const postColCount = 13; // Updated column count with Month, Post Link, Posting Date

    const postRows = [];
    postRows.push(separatorRow(postColCount, `── ${monthLabel} ──`));

    posts.forEach((p, i) => {
      postRows.push([
        i + 1, monthLabel, p.subreddit || '', p.postType || '', p.title || '', p.body || '',
        p.followUpComment || '', p.brandMentionStrategy || '', p.engagementPotential || '',
        'Pending Review', '', '', '',
      ]);
    });

    if (posts.length === 0) {
      postRows.push(['', '', '', '', 'No posts included in this scope', '', '', '', '', '', '', '', '']);
    }

    batchData.push({ range: `'${tabNames.posts}'!A${existingRows + 1}`, values: postRows });

    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: sheetMap[tabNames.posts],
          startRowIndex: separatorRowIdx,
          endRowIndex: separatorRowIdx + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0, green: 0, blue: 0 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  }

  // ── Upvote Plan ──
  if (existingNames.has(tabNames.upvotes)) {
    const existingRows = await getRowCount(tabNames.upvotes);
    const separatorRowIdx = existingRows;
    const upColCount = 8;

    const upRows = [];
    upRows.push(separatorRow(upColCount, `── ${monthLabel} ──`));

    if (upvotePlan?.distribution?.length > 0) {
      upvotePlan.distribution.forEach((item, i) => {
        upRows.push([
          i + 1, item.contentType || item.type || '', item.target || '', item.subreddit || '',
          item.upvotes || 0, item.timing || '', (item.priority || '').toUpperCase(), item.notes || '',
        ]);
      });
      upRows.push(['', '', 'TOTAL', '', upvotePlan.totalUpvotes || 0, '', '', '']);
    } else {
      upRows.push(['', '', 'Upvote support not included', '', '', '', '', '']);
    }

    batchData.push({ range: `'${tabNames.upvotes}'!A${existingRows + 1}`, values: upRows });

    formatRequests.push({
      repeatCell: {
        range: {
          sheetId: sheetMap[tabNames.upvotes],
          startRowIndex: separatorRowIdx,
          endRowIndex: separatorRowIdx + 1,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0, green: 0, blue: 0 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  }

  // ── Update Reporting Tracker (if it exists) ──
  try {
    const trackerName = 'Reporting Tracker';
    if (existingNames.has(trackerName)) {
      const trackerData = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${trackerName}'!A:A`,
      });
      const nextRow = (trackerData.data.values?.length || 1) + 1;
      batchData.push({
        range: `'${trackerName}'!A${nextRow}`,
        values: [[
          monthLabel,
          String(strategyData.keywords?.length || 0),
          String(strategyData.threads?.length || 0),
          String(comments.length),
          '0',
          String(posts.length),
          '0',
          String(upvotePlan?.totalUpvotes || 0),
          (report.riskAssessment?.overallRisk || 'unknown').toUpperCase(),
          'Update after execution',
        ]],
      });
    }
  } catch (trackerErr) {
    console.log('[GoogleSheets] Could not update Reporting Tracker:', trackerErr.message);
  }

  // Write all data in one batch call
  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: batchData,
      },
    });
  }

  // Apply formatting (black separator rows)
  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: formatRequests },
    });
  }

  console.log(`[GoogleSheets] Appended Month ${month} data to existing tabs`);
}

// ─── Helpers ───

/**
 * Extract spreadsheet ID from a Google Sheets URL.
 */
function extractSpreadsheetId(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Get the parent folder ID of a Google Doc.
 */
async function getDocParentFolder(drive, docUrl) {
  if (!docUrl) return null;
  const match = (docUrl || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const docId = match[1];

  try {
    const resp = await drive.files.get({ fileId: docId, fields: 'parents' });
    return resp.data.parents?.[0] || null;
  } catch (err) {
    console.error('getDocParentFolder error:', err.message);
    return null;
  }
}

module.exports = { buildGoogleSheetsReport };
