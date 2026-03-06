const REPO = 'jeffperoutka/reddit-strategy';

async function readFile(path) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return null;
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch (err) {
    console.error(`GitHub readFile(${path}) error:`, err.message);
    return null;
  }
}

async function writeFile(path, content, message) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return;
  let sha;
  try {
    const getResp = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (getResp.ok) sha = (await getResp.json()).sha;
  } catch (err) { /* new file */ }

  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || `auto: update ${path}`, content: encoded, ...(sha ? { sha } : {}) }),
  });
}

/**
 * Read from Brand Guardian's cache
 */
async function readBrandGuardianCache(cacheKey) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return null;
  try {
    const resp = await fetch(`https://api.github.com/repos/jeffperoutka/brand-guardian/contents/brand-cache/${cacheKey}.json`, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  } catch (err) {
    console.error(`readBrandGuardianCache(${cacheKey}) error:`, err.message);
    return null;
  }
}

module.exports = { readFile, writeFile, readBrandGuardianCache };
