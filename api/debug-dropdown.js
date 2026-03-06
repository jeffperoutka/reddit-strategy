// Temporary debug endpoint — test client dropdown logic
module.exports = async function handler(req, res) {
  const start = Date.now();
  const log = [];

  try {
    const cuToken = process.env.CLICKUP_API_TOKEN;
    const wsId = process.env.CLICKUP_WORKSPACE_ID;
    log.push(`cuToken: ${cuToken ? `present (${cuToken.length} chars)` : 'MISSING'}`);
    log.push(`wsId: ${wsId || 'MISSING'}`);

    if (!cuToken || !wsId) {
      return res.status(200).json({ error: 'Missing env vars', log });
    }

    // Test ClickUp docs API
    const cuStart = Date.now();
    const cuResp = await fetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/docs`, {
      headers: { 'Authorization': cuToken },
    });
    const cuTime = Date.now() - cuStart;
    log.push(`ClickUp API: ${cuResp.status} in ${cuTime}ms`);

    if (!cuResp.ok) {
      const body = await cuResp.text();
      log.push(`ClickUp error body: ${body.slice(0, 500)}`);
      return res.status(200).json({ error: 'ClickUp API failed', log });
    }

    const data = await cuResp.json();
    log.push(`Total docs returned: ${(data.docs || []).length}`);

    const CLIENT_INFO_DOCS_FOLDER_ID = '901812024928';
    const clientDocs = (data.docs || []).filter(doc =>
      doc.parent?.id === CLIENT_INFO_DOCS_FOLDER_ID &&
      !doc.deleted &&
      doc.name &&
      !doc.name.toLowerCase().includes('template') &&
      !doc.name.toLowerCase().includes('definitions') &&
      doc.name !== 'AD6SC3RT6'
    );
    log.push(`Client docs (filtered): ${clientDocs.length}`);

    const options = [];
    for (const doc of clientDocs) {
      const name = doc.name
        .replace(/\s*(client\s+)?info(\s+doc)?(\s+template)?$/i, '')
        .trim();
      if (!name) continue;
      const val = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      options.push({ text: { type: 'plain_text', text: name }, value: val });
    }

    log.push(`Options built: ${options.length}`);
    log.push(`Total time: ${Date.now() - start}ms`);

    // Also test GitHub brand cache
    const pat = process.env.GITHUB_PAT;
    if (pat) {
      const ghStart = Date.now();
      const ghResp = await fetch('https://api.github.com/repos/jeffperoutka/brand-guardian/contents/brand-cache', {
        headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
      });
      const ghTime = Date.now() - ghStart;
      log.push(`GitHub API: ${ghResp.status} in ${ghTime}ms`);
    }

    res.status(200).json({
      totalTime: `${Date.now() - start}ms`,
      options,
      log,
    });
  } catch (err) {
    log.push(`ERROR: ${err.message}`);
    res.status(200).json({ error: err.message, log });
  }
};
