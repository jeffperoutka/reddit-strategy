const { google } = require('googleapis');
const { parseServiceAccountKey } = require('../lib/connectors/google-sheets');
const { Readable } = require('stream');

module.exports = async (req, res) => {
  // Basic health check
  if (!req.query.diag) {
    return res.status(200).json({ status: 'ok', bot: 'reddit-strategy', timestamp: new Date().toISOString() });
  }

  // Diagnostic: test Google Drive API
  const results = { timestamp: new Date().toISOString(), steps: [] };

  // Step 1: Parse service account key
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
    const creds = parseServiceAccountKey(raw);
    results.steps.push({
      step: 'parse_key',
      ok: true,
      client_email: creds.client_email,
      has_private_key: !!creds.private_key,
      private_key_length: creds.private_key?.length || 0,
    });

    // Step 2: Create Drive client
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });
    results.steps.push({ step: 'create_drive_client', ok: true });

    // Step 3: List files (tests auth)
    const listResp = await drive.files.list({ pageSize: 1, fields: 'files(id,name)' });
    results.steps.push({
      step: 'list_files',
      ok: true,
      file_count: listResp.data.files?.length || 0,
    });

    // Step 4: Create a tiny test spreadsheet via CSV upload with auto-conversion
    try {
      const csvContent = 'Test,Data\nHello,World\n';
      const resp = await drive.files.create({
        requestBody: {
          name: 'DIAG_TEST_DELETE_ME',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        media: {
          mimeType: 'text/csv',
          body: Readable.from(Buffer.from(csvContent)),
        },
        fields: 'id, webViewLink',
      });
      results.steps.push({
        step: 'create_spreadsheet',
        ok: true,
        fileId: resp.data.id,
        webViewLink: resp.data.webViewLink,
      });

      // Clean up: delete the test file
      await drive.files.delete({ fileId: resp.data.id });
      results.steps.push({ step: 'cleanup', ok: true });
    } catch (createErr) {
      results.steps.push({
        step: 'create_spreadsheet',
        ok: false,
        error: createErr.message,
        code: createErr.code,
        errors: createErr.errors,
      });
    }
  } catch (err) {
    results.steps.push({
      step: 'failed_early',
      ok: false,
      error: err.message,
      code: err.code,
      stack: err.stack?.split('\n').slice(0, 3),
    });
  }

  res.status(200).json(results);
};
