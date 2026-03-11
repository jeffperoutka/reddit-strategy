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
 * Auth strategy:
 * - Drive (file creation): Impersonated JWT with drive-only scope (domain-wide delegation)
 * - Sheets (Month 2+ append): Direct service account with spreadsheets scope (sheets shared as "anyone can edit")
 *
 * Setup required (one-time):
 * 1. Google Workspace Admin → Security → API Controls → Domain-wide Delegation
 * 2. Add the service account's client_id
 * 3. Authorize scope: https://www.googleapis.com/auth/drive (drive only)
 * 4. Set GOOGLE_IMPERSONATE_EMAIL env var in Vercel (e.g., jeff@aeolabs.ai)
 *
 * Output goes into the same Google Drive folder as the client info doc.
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { buildStrategySpreadsheet } = require('./spreadsheet');
const { parseServiceAccountKey } = require('./connectors/google-sheets');

// ─── Auth helpers ───
// Drive: impersonated JWT with drive-only scope (for creating files under user's quota)
// Sheets: direct service account with spreadsheets scope (for appending — sheets are shared with "anyone as editor")

function _parseCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
  const creds = parseServiceAccountKey(raw);
  if (!creds.client_email || !creds.private_key) return null;
  return creds;
}

/** Drive client with impersonation — for creating/uploading files (drive scope only) */
function getDriveClient() {
  const creds = _parseCreds();
  if (!creds) return null;

  const impersonateEmail = process.env.GOOGLE_IMPERSONATE_EMAIL;

  if (impersonateEmail) {
    console.log(`[GoogleSheets] Drive auth: impersonating ${impersonateEmail}`);
    const jwtAuth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
      subject: impersonateEmail,
    });
    return google.drive({ version: 'v3', auth: jwtAuth });
  }

  console.log('[GoogleSheets] Drive auth: direct service account (no impersonation)');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

/** Sheets client — direct service account (no impersonation needed for shared sheets) */
function getSheetsClient() {
  const creds = _parseCreds();
  if (!creds) return null;

  console.log('[GoogleSheets] Sheets auth: direct service account');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
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

  // Step 2: Month 2+ with existing spreadsheet → append via Sheets API (direct SA auth)
  const prevSpreadsheetId = extractSpreadsheetId(formData.prevSpreadsheetUrl);
  let appendError = null;
  console.log(`[GoogleSheets] Month=${month}, prevUrl="${formData.prevSpreadsheetUrl || 'none'}", prevId="${prevSpreadsheetId || 'none'}"`);
  if (month > 1 && prevSpreadsheetId) {
    console.log(`[GoogleSheets] Month ${month} — appending to existing sheet ${prevSpreadsheetId}`);

    try {
      const sheets = getSheetsClient();
      if (!sheets) throw new Error('Could not create Sheets client');
      await appendMonthTabs(sheets, prevSpreadsheetId, strategyData, brandProfile, packageTier, formData);
      const webViewLink = `https://docs.google.com/spreadsheets/d/${prevSpreadsheetId}/edit`;
      console.log(`[GoogleSheets] SUCCESS — rows appended to existing sheet`);
      return { xlsxBuffer, driveUrl: webViewLink, appended: true };
    } catch (err) {
      const errDetail = err.response?.data?.error?.message || err.message;
      const errCode = err.code || err.response?.status || 'unknown';
      appendError = `Append failed (code=${errCode}): ${errDetail}`;
      console.error(`[GoogleSheets] ${appendError}`);
      console.error(`[GoogleSheets] Full error:`, JSON.stringify({
        code: errCode,
        message: err.message,
        errors: err.errors || err.response?.data?.error?.errors,
      }));
    }

    console.log('[GoogleSheets] Append failed. Falling back to new sheet...');
  } else if (month > 1) {
    appendError = !formData.prevSpreadsheetUrl
      ? 'No Previous Month Google Sheet URL was provided in the form'
      : `Could not extract spreadsheet ID from URL: "${formData.prevSpreadsheetUrl}"`;
    console.log(`[GoogleSheets] Month ${month}: ${appendError}`);
    // Fall through to create new file
  }

  // Step 3: Create new Google Sheet (Month 1 or fallback) — uses Drive API with impersonation
  const drive = getDriveClient();
  if (!drive) {
    console.log('[GoogleSheets] No Drive client — returning XLSX only');
    return { xlsxBuffer, driveUrl: null, appendError };
  }
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

  return { xlsxBuffer, driveUrl: webViewLink, appendError };
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
  const report = strategyData.report || {};
  const upvotePlan = strategyData.upvotePlan;

  // AEO Labs brand separator colors
  const separatorBg = { red: 0.58, green: 0.969, blue: 0.129 };  // Neon Green #94F721
  const separatorText = { red: 0, green: 0, blue: 0 };            // Black text on green

  // Get existing sheet metadata
  const existingMeta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetMap = {};
  for (const s of existingMeta.data.sheets || []) {
    sheetMap[s.properties.title] = s.properties.sheetId;
  }
  const existingNames = new Set(Object.keys(sheetMap));
  console.log(`[GoogleSheets] Existing tabs: ${[...existingNames].join(', ')}`);

  // ── Step 0: Clean up old "Threads & Comments" tab ──
  // Remove thread rows and rename to "Comments"
  let commentsTabName;
  if (existingNames.has('Threads & Comments') && !existingNames.has('Comments')) {
    const oldName = 'Threads & Comments';
    const oldSheetId = sheetMap[oldName];
    console.log(`[GoogleSheets] Found old "${oldName}" tab — removing thread rows and renaming to "Comments"`);

    // Read all data to identify thread rows
    const allData = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${oldName}'!A:N`,
    });
    const rows = allData.data.values || [];

    // Find thread rows to delete: rows where col A says "THREAD" or is a number but col B is empty
    // Thread rows typically have column A as a number and a type indicator like "THREAD"
    // Look for rows where the first cell contains "THREAD" (case-insensitive) or the row type indicates a thread
    const threadRowIndices = [];
    for (let i = 1; i < rows.length; i++) { // skip header row
      const row = rows[i];
      const firstCol = String(row[0] || '').trim();
      const typeCol = String(row[1] || '').trim().toUpperCase();
      // Old format had THREAD rows with type "THREAD" in column B
      if (typeCol === 'THREAD' || firstCol === 'THREAD') {
        threadRowIndices.push(i);
      }
    }

    if (threadRowIndices.length > 0) {
      // Delete thread rows in reverse order (bottom-up) so indices don't shift
      const deleteRequests = [];
      // Group consecutive indices for efficiency
      const groups = [];
      let start = threadRowIndices[0];
      let end = start;
      for (let i = 1; i < threadRowIndices.length; i++) {
        if (threadRowIndices[i] === end + 1) {
          end = threadRowIndices[i];
        } else {
          groups.push([start, end]);
          start = threadRowIndices[i];
          end = start;
        }
      }
      groups.push([start, end]);

      // Delete in reverse order
      for (let g = groups.length - 1; g >= 0; g--) {
        deleteRequests.push({
          deleteDimension: {
            range: {
              sheetId: oldSheetId,
              dimension: 'ROWS',
              startIndex: groups[g][0],
              endIndex: groups[g][1] + 1,
            },
          },
        });
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: deleteRequests },
      });
      console.log(`[GoogleSheets] Deleted ${threadRowIndices.length} thread rows from "${oldName}"`);
    }

    // Rename tab to "Comments"
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: oldSheetId, title: 'Comments' },
            fields: 'title',
          },
        }],
      },
    });
    sheetMap['Comments'] = oldSheetId;
    delete sheetMap[oldName];
    existingNames.delete(oldName);
    existingNames.add('Comments');
    commentsTabName = 'Comments';
    console.log(`[GoogleSheets] Renamed "${oldName}" → "Comments"`);
  } else {
    commentsTabName = existingNames.has('Comments') ? 'Comments' :
      existingNames.has('Threads & Comments') ? 'Threads & Comments' : 'Comments';
  }

  const tabNames = {
    comments: commentsTabName,
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

  // Helper: build a separator row
  function separatorRow(colCount, label) {
    const row = new Array(colCount).fill('');
    row[0] = label;
    return row;
  }

  // Helper: brand separator format request (neon green bg, black bold text)
  function separatorFormat(sheetId, rowIdx, colCount) {
    return {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIdx,
          endRowIndex: rowIdx + 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: separatorBg,
            textFormat: { bold: true, foregroundColor: separatorText, fontSize: 11 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    };
  }

  // ── Comments ──
  if (existingNames.has(tabNames.comments)) {
    const existingRows = await getRowCount(tabNames.comments);
    const separatorRowIdx = existingRows; // 0-indexed for formatting
    const tcColCount = 14;

    const tcRows = [];
    tcRows.push(separatorRow(tcColCount, `── ${monthLabel} ──`));

    comments.forEach((c, i) => {
      const a = c.alignment || {};
      tcRows.push([
        i + 1, monthLabel, c.subreddit || '', c.threadTitle || '',
        c.threadUrl || '', c.angle || '', a.score || 0, c.comment || '',
        c.brandMentionType || '', a.spamRisk || '', 'Pending Review', '', '', (a.issues || []).join('; '),
      ]);
    });

    batchData.push({ range: `'${tabNames.comments}'!A${existingRows + 1}`, values: tcRows });
    formatRequests.push(separatorFormat(sheetMap[tabNames.comments], separatorRowIdx, tcColCount));
    console.log(`[GoogleSheets] Will append ${comments.length} comments after row ${existingRows} with separator`);
  } else {
    console.log(`[GoogleSheets] Comments tab not found. Available: ${[...existingNames].join(', ')}`);
  }

  // ── Post Drafts ──
  if (existingNames.has(tabNames.posts)) {
    const existingRows = await getRowCount(tabNames.posts);
    const separatorRowIdx = existingRows;
    const postColCount = 13;

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
    formatRequests.push(separatorFormat(sheetMap[tabNames.posts], separatorRowIdx, postColCount));
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
    formatRequests.push(separatorFormat(sheetMap[tabNames.upvotes], separatorRowIdx, upColCount));
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

  // Apply formatting (brand separator rows)
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
  // Handle various Google Sheets URL formats
  // Standard: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
  // With gid: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=0
  // Short: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Fallback: maybe just the ID was pasted
  if (/^[a-zA-Z0-9_-]{20,}$/.test(url.trim())) return url.trim();
  return null;
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
