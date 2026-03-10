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
      client_id: creds.client_id || 'not in key file',
      has_private_key: !!creds.private_key,
      private_key_length: creds.private_key?.length || 0,
      has_impersonate: !!process.env.GOOGLE_IMPERSONATE_EMAIL,
      impersonate_email: process.env.GOOGLE_IMPERSONATE_EMAIL || 'not set',
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

    // Step 5: List ALL files owned by service account (across all locations)
    try {
      const allFiles = await drive.files.list({
        pageSize: 200,
        q: "'me' in owners",
        fields: 'files(id,name,mimeType,size,createdTime,trashed)',
        orderBy: 'createdTime desc',
        spaces: 'drive',
        includeItemsFromAllDrives: false,
      });
      results.steps.push({
        step: 'list_owned_files',
        ok: true,
        count: (allFiles.data.files || []).length,
        files: (allFiles.data.files || []).map(f => ({
          id: f.id, name: f.name, size: f.size, created: f.createdTime, trashed: f.trashed,
        })),
      });
    } catch (listErr) {
      results.steps.push({ step: 'list_owned_files', ok: false, error: listErr.message });
    }

    // Step 5b: Check storage quota
    try {
      const about = await drive.about.get({ fields: 'storageQuota' });
      results.steps.push({
        step: 'storage_quota',
        ok: true,
        quota: about.data.storageQuota,
      });
    } catch (quotaErr) {
      results.steps.push({ step: 'storage_quota', ok: false, error: quotaErr.message });
    }

    // Step 6: If ?cleanup=1, delete all owned files AND empty trash
    if (req.query.cleanup === '1') {
      try {
        const allFiles = await drive.files.list({
          pageSize: 200,
          q: "'me' in owners",
          fields: 'files(id,name)',
        });
        let deleted = 0;
        for (const f of (allFiles.data.files || [])) {
          try { await drive.files.delete({ fileId: f.id }); deleted++; } catch (e) {}
        }
        // Empty trash to actually free storage
        try { await drive.files.emptyTrash(); } catch (e) {}
        results.steps.push({ step: 'cleanup_all', ok: true, deleted, trashEmptied: true });
      } catch (cleanErr) {
        results.steps.push({ step: 'cleanup_all', ok: false, error: cleanErr.message });
      }
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
