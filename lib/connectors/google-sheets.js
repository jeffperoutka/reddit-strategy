/**
 * Google Sheets Connector
 *
 * Creates, writes, formats, and shares Google Sheets for client reports.
 * Uses service account authentication via googleapis.
 */

const { google } = require('googleapis');

function getAuthClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient() });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuthClient() });
}

// ── Create a new spreadsheet ──
async function createSpreadsheet(title) {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.create({
    resource: {
      properties: { title },
      sheets: [], // We'll add sheets via batchUpdate
    },
  });
  return resp.data;
}

// ── Extract spreadsheet ID from a Google Sheets URL ──
function extractSpreadsheetId(url) {
  const match = (url || '').match(/spreadsheets(?:\/u\/\d+)?\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ── Get sheet metadata (tab names, IDs) ──
async function getSheetMetadata(spreadsheetId) {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
  });
  return resp.data.sheets.map(s => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
    rowCount: s.properties.gridProperties?.rowCount,
    colCount: s.properties.gridProperties?.columnCount,
  }));
}

// ── Read data from a sheet tab ──
async function readRange(spreadsheetId, range) {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return resp.data.values || [];
}

// ── Write data to a range ──
async function writeRange(spreadsheetId, range, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
}

// ── Append rows to a sheet ──
async function appendRows(spreadsheetId, sheetRange, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetRange,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });
}

// ── Batch update (multiple ranges at once) ──
async function batchWrite(spreadsheetId, updates) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    resource: {
      data: updates,
      valueInputOption: 'USER_ENTERED',
    },
  });
}

// ── Add a new tab to an existing spreadsheet ──
async function addSheet(spreadsheetId, title, tabColor) {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{
        addSheet: {
          properties: {
            title,
            tabColor: tabColor || undefined,
          },
        },
      }],
    },
  });
  return resp.data.replies[0].addSheet.properties.sheetId;
}

// ── Batch formatting requests ──
async function batchFormat(spreadsheetId, requests) {
  if (!requests.length) return;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests },
  });
}

// ── Build header formatting request ──
function headerFormatRequest(sheetId, colCount) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.1, green: 0.1, blue: 0.18 }, // Dark navy
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 11 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
    },
  };
}

// ── Freeze header row ──
function freezeRowRequest(sheetId) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  };
}

// ── Auto-resize columns ──
function autoResizeRequest(sheetId, colCount) {
  return {
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: colCount },
    },
  };
}

// ── Color a cell range ──
function colorCellsRequest(sheetId, startRow, endRow, startCol, endCol, rgbColor) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
      cell: {
        userEnteredFormat: {
          backgroundColor: rgbColor,
        },
      },
      fields: 'userEnteredFormat.backgroundColor',
    },
  };
}

// ── Share with editing access (anyone with link) ──
async function shareWithEditing(spreadsheetId) {
  const drive = getDriveClient();
  await drive.permissions.create({
    fileId: spreadsheetId,
    resource: { role: 'writer', type: 'anyone' },
  });
  const file = await drive.files.get({
    fileId: spreadsheetId,
    fields: 'webViewLink',
  });
  return file.data.webViewLink;
}

// ── Delete the default "Sheet1" tab ──
async function deleteSheet(spreadsheetId, sheetId) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{ deleteSheet: { sheetId } }],
    },
  });
}

// ── Score color helpers (returns RGB object) ──
function scoreColor(score) {
  if (score >= 70) return { red: 0.83, green: 0.93, blue: 0.85 }; // Green
  if (score >= 40) return { red: 1, green: 0.95, blue: 0.8 };     // Yellow
  return { red: 0.97, green: 0.84, blue: 0.85 };                   // Red
}

function riskColor(risk) {
  if (risk === 'high') return { red: 0.97, green: 0.84, blue: 0.85 };
  if (risk === 'medium') return { red: 1, green: 0.95, blue: 0.8 };
  return { red: 0.83, green: 0.93, blue: 0.85 };
}

module.exports = {
  createSpreadsheet,
  extractSpreadsheetId,
  getSheetMetadata,
  readRange,
  writeRange,
  appendRows,
  batchWrite,
  addSheet,
  batchFormat,
  headerFormatRequest,
  freezeRowRequest,
  autoResizeRequest,
  colorCellsRequest,
  shareWithEditing,
  deleteSheet,
  scoreColor,
  riskColor,
};
