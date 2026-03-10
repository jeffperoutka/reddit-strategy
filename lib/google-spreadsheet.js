/**
 * Google Sheets Report Builder
 *
 * Uses domain-wide delegation to impersonate a real user (GOOGLE_IMPERSONATE_EMAIL),
 * so files are created under that user's Drive quota — not the service account's
 * (which has 0 bytes).
 *
 * Setup required (one-time):
 * 1. Google Workspace Admin → Security → API Controls → Domain-wide Delegation
 * 2. Add the service account's client_id
 * 3. Authorize scope: https://www.googleapis.com/auth/drive
 * 4. Set GOOGLE_IMPERSONATE_EMAIL env var in Vercel (e.g., jeff@aeolabs.ai)
 *
 * Output goes into the same Google Drive folder as the client info doc.
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { buildStrategySpreadsheet } = require('./spreadsheet');
const { parseServiceAccountKey } = require('./connectors/google-sheets');

// ─── Drive Client (with impersonation) ───

function getDriveClient() {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
    const creds = parseServiceAccountKey(raw);
    if (!creds.client_email || !creds.private_key) return null;

    const impersonateEmail = process.env.GOOGLE_IMPERSONATE_EMAIL;

    // Use JWT auth with subject (impersonation) if configured
    // This creates files as the impersonated user, using their Drive quota
    if (impersonateEmail) {
      console.log(`[GoogleSheets] Using impersonation: ${impersonateEmail}`);
      const jwtAuth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/drive'],
        subject: impersonateEmail,
      });
      return google.drive({ version: 'v3', auth: jwtAuth });
    }

    // Fallback: direct service account auth (will fail on file creation due to 0 quota)
    console.log('[GoogleSheets] No GOOGLE_IMPERSONATE_EMAIL set — using direct service account');
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
 * Build a Google Sheets report and upload to Google Drive.
 *
 * @param {object} strategyData - Full pipeline output
 * @param {object} brandProfile - Brand profile
 * @param {string} packageTier - Package tier key
 * @param {object} formData - { month, prevSpreadsheetUrl, packageName, clientDocUrl }
 * @returns {{ xlsxBuffer: Buffer, driveUrl: string|null }} XLSX buffer + optional Drive URL
 */
async function buildGoogleSheetsReport(strategyData, brandProfile, packageTier, formData = {}) {
  const clientName = brandProfile.clientName || 'Client';

  // Step 1: Build the XLSX in memory
  console.log('[GoogleSheets] Building XLSX...');
  const xlsxBuffer = await buildStrategySpreadsheet(strategyData, brandProfile, packageTier, formData);
  console.log(`[GoogleSheets] XLSX built: ${(xlsxBuffer.length / 1024).toFixed(1)}KB`);

  // Step 2: Get Drive client
  const drive = getDriveClient();
  if (!drive) {
    console.log('[GoogleSheets] No Drive client — returning XLSX only');
    return { xlsxBuffer, driveUrl: null };
  }

  // Step 3: Determine target folder from client info doc
  const targetFolderId = await getDocParentFolder(drive, formData.clientDocUrl);
  console.log(`[GoogleSheets] Target folder: ${targetFolderId || 'user root'}`);

  // Step 4: Upload XLSX to Drive with auto-conversion to Google Sheets
  const title = `Reddit Strategy — ${clientName}`;
  console.log(`[GoogleSheets] Uploading as Google Sheet: "${title}"`);

  const fileMetadata = {
    name: title,
    mimeType: 'application/vnd.google-apps.spreadsheet', // Convert to native Google Sheets
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

  // Step 5: Share with anyone (editing access)
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
