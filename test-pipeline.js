/**
 * Local pipeline test — diagnoses both issues:
 * 1. "Failed to parse thread analysis" (empty tabs)
 * 2. Google Sheets auth failure
 */
const fs = require('fs');

// Load env vars from .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
for (const line of envContent.split('\n')) {
  const eqIdx = line.indexOf('=');
  if (eqIdx < 0 || line.startsWith('#')) continue;
  const key = line.slice(0, eqIdx).trim();
  let val = line.slice(eqIdx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  process.env[key] = val;
}

async function main() {
  const step = process.argv[2] || 'all';

  // ── Test 1: Google Sheets Auth ──
  if (step === 'all' || step === 'sheets') {
    console.log('\n=== TEST 1: Google Sheets Auth ===');
    try {
      const { google } = require('googleapis');
      const { parseServiceAccountKey } = require('./lib/connectors/google-sheets');
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
      const creds = parseServiceAccountKey(raw);

      console.log('client_email:', creds.client_email);
      console.log('project_id:', creds.project_id);
      console.log('Has private_key:', !!creds.private_key);
      console.log('private_key starts with:', creds.private_key?.slice(0, 40));
      console.log('private_key has newlines:', creds.private_key?.includes('\n'));

      const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
      });

      const sheets = google.sheets({ version: 'v4', auth });

      // Try creating a test spreadsheet
      console.log('Creating test spreadsheet...');
      const resp = await sheets.spreadsheets.create({
        resource: { properties: { title: 'Test — Delete Me' } },
      });
      console.log('SUCCESS: Created spreadsheet', resp.data.spreadsheetId);

      // Delete it
      const drive = google.drive({ version: 'v3', auth });
      await drive.files.delete({ fileId: resp.data.spreadsheetId });
      console.log('Cleaned up test spreadsheet');
    } catch (err) {
      console.error('FAILED:', err.message);
      if (err.message.includes('invalid_grant') || err.message.includes('private key')) {
        console.error('>> This is a credential issue. The private_key may have escaped newlines.');
      }
    }
  }

  // ── Test 2: Claude + extractJson ──
  if (step === 'all' || step === 'claude') {
    console.log('\n=== TEST 2: Claude API + extractJson ===');
    try {
      const { askClaude, extractJson } = require('./lib/connectors/claude');

      const result = await askClaude(
        'Return valid JSON only, no markdown fences: {"test": true, "items": ["a", "b"]}',
        'Generate the test JSON.',
        { maxTokens: 200, timeout: 15000 }
      );
      console.log('Raw Claude response:', JSON.stringify(result).slice(0, 300));

      const parsed = extractJson(result);
      console.log('extractJson result:', parsed);
      console.log('SUCCESS: Claude + extractJson works');
    } catch (err) {
      console.error('FAILED:', err.message);
    }
  }

  // ── Test 3: DataForSEO ──
  if (step === 'all' || step === 'dataforseo') {
    console.log('\n=== TEST 3: DataForSEO ===');
    try {
      const { searchRedditThreads } = require('./lib/connectors/dataforseo');
      const results = await searchRedditThreads('best CRM for startups', { depth: 10 });
      console.log(`Found ${results.length} Reddit threads`);
      if (results.length > 0) {
        console.log('First result:', results[0].title, results[0].url);
      }
      console.log('SUCCESS: DataForSEO works');
    } catch (err) {
      console.error('FAILED:', err.message);
    }
  }

  // ── Test 4: Thread Analysis (the failing step) ──
  if (step === 'all' || step === 'analyze') {
    console.log('\n=== TEST 4: Thread Analysis ===');
    try {
      const { analyzeThreads } = require('./lib/engine');

      // Mock data — simulate real threads
      const mockThreads = [
        {
          url: 'https://reddit.com/r/startups/comments/abc123/best_crm',
          title: 'What CRM do you use for your startup?',
          subreddit: 'r/startups',
          description: 'Looking for recommendations on CRMs for small startups',
          position: 3,
          keywords: ['best CRM for startups'],
        },
        {
          url: 'https://reddit.com/r/smallbusiness/comments/def456/crm_review',
          title: 'HubSpot vs Salesforce for small business?',
          subreddit: 'r/smallbusiness',
          description: 'Comparing CRM solutions for a 10-person team',
          position: 5,
          keywords: ['CRM comparison'],
        },
      ];

      const mockBrand = {
        clientName: 'TestBrand',
        industry: 'SaaS',
        coreOfferings: { products: ['CRM Software'], keyBenefits: ['Easy to use', 'Affordable'] },
        targetAudience: { primary: 'Small business owners' },
        brandVoice: { tone: 'Friendly, casual' },
        competitors: [{ name: 'HubSpot' }, { name: 'Salesforce' }],
      };

      console.log('Running analyzeThreads with mock data...');
      const analysis = await analyzeThreads(mockThreads, mockBrand, 'b');

      console.log('analyzedThreads count:', analysis.analyzedThreads?.length || 0);
      console.log('subredditMap keys:', Object.keys(analysis.subredditMap || {}));

      if (analysis.analyzedThreads?.length > 0) {
        console.log('First thread:', JSON.stringify(analysis.analyzedThreads[0]).slice(0, 200));
        console.log('SUCCESS: Thread analysis works');
      } else {
        console.error('FAILED: analyzedThreads is empty');
        console.log('Full response:', JSON.stringify(analysis).slice(0, 500));
      }
    } catch (err) {
      console.error('FAILED:', err.message);
    }
  }

  // ── Test 5: Google Doc reading ──
  if (step === 'all' || step === 'gdoc') {
    console.log('\n=== TEST 5: Google Doc Reading ===');
    try {
      const { google } = require('googleapis');
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';
      const { parseServiceAccountKey } = require('./lib/connectors/google-sheets');
      const creds = parseServiceAccountKey(raw);

      const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/documents.readonly'],
      });
      const docs = google.docs({ version: 'v1', auth });

      // Try reading a test doc from the shared folder
      // Use a known doc ID if available, otherwise skip
      console.log('Google Docs API client created successfully');
      console.log('(Skipping actual doc read — needs a real doc ID)');
      console.log('SUCCESS: Google Docs API ready');
    } catch (err) {
      console.error('FAILED:', err.message);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
