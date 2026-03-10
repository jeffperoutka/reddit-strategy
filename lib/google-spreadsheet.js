/**
 * Google Sheets Report Builder
 *
 * Uploads an XLSX to the client's Google Drive folder as a native XLSX file.
 * Google Drive opens XLSX files in Google Sheets automatically for viewing/editing.
 *
 * We do NOT convert to native Google Sheets format because the service account
 * has 0 bytes of Drive storage quota — conversion requires storage quota,
 * but uploading binary files to a shared folder does not.
 *
 * Output goes into the same Google Drive folder as the client info doc.
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { buildStrategySpreadsheet } = require('./spreadsheet');
const { parseServiceAccountKey } = require('./connectors/google-sheets');

// ─── Drive Client ───

function getDriveClient() {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
    const creds = parseServiceAccountKey(raw);
    if (!creds.client_email || !creds.private_key) return null;

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return google.drive({ version: 'v3', auth });
  } catch (err) {
    console.error('getDriveClient error:', err.message);
    return null;
  }
}

/**
 * Build an XLSX report and upload to Google Drive.
 *
 * @param {object} strategyData - Full pipeline output
 * @param {object} brandProfile - Brand profile
 * @param {string} packageTier - Package tier key
 * @param {object} formData - { month, prevSpreadsheetUrl, packageName, clientDocUrl }
 * @returns {string} Google Drive URL with editing access
 */
async function buildGoogleSheetsReport(strategyData, brandProfile, packageTier, formData = {}) {
  const clientName = brandProfile.clientName || 'Client';
  const month = formData.month || '1';

  // Step 1: Build the XLSX in memory
  console.log('[GoogleSheets] Building XLSX...');
  const xlsxBuffer = await buildStrategySpreadsheet(strategyData, brandProfile, packageTier, formData);
  console.log(`[GoogleSheets] XLSX built: ${(xlsxBuffer.length / 1024).toFixed(1)}KB`);

  // Step 2: Get Drive client
  const drive = getDriveClient();
  if (!drive) {
    throw new Error('Google Drive client not available — check GOOGLE_SERVICE_ACCOUNT_KEY');
  }

  // Step 3: Determine target folder from client info doc
  const targetFolderId = await getDocParentFolder(drive, formData.clientDocUrl);
  console.log(`[GoogleSheets] Target folder: ${targetFolderId || 'service account root'}`);

  // Step 4: Upload XLSX to Drive as native XLSX (no conversion — avoids storage quota)
  // Google Drive will open .xlsx files in Google Sheets automatically
  const title = `Reddit Strategy — ${clientName}.xlsx`;
  console.log(`[GoogleSheets] Uploading XLSX to Drive: "${title}"`);

  const fileMetadata = {
    name: title,
    // NO mimeType = keeps as XLSX (no conversion, no quota needed)
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
  console.log(`[GoogleSheets] Uploaded: ${fileId}`);

  // Step 5: Share with anyone (editing access)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'writer', type: 'anyone' },
  });
  console.log(`[GoogleSheets] Shared with editing access`);

  // Ensure we have a usable link (webViewLink may be null for non-native files)
  if (!webViewLink) {
    webViewLink = `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
  }

  return webViewLink;
}

// ─── Helpers ───

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
