const REPO = 'jeffperoutka/reddit-strategy';
const FILE_PATH = 'rules.json';
let rulesCache = null;
let lastFetched = 0;
const CACHE_TTL = 60000;

async function loadRules() {
  if (rulesCache && Date.now() - lastFetched < CACHE_TTL) return rulesCache;
  const pat = process.env.GITHUB_PAT;
  if (!pat) { rulesCache = []; lastFetched = Date.now(); return rulesCache; }
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (resp.ok) {
      const data = await resp.json();
      rulesCache = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      lastFetched = Date.now();
    } else { rulesCache = []; lastFetched = Date.now(); }
  } catch (err) { rulesCache = rulesCache || []; lastFetched = Date.now(); }
  return rulesCache;
}

async function saveRules(rules) {
  rulesCache = rules; lastFetched = Date.now();
  const pat = process.env.GITHUB_PAT;
  if (!pat) return;
  let sha;
  const getResp = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json' },
  });
  if (getResp.ok) sha = (await getResp.json()).sha;
  const content = Buffer.from(JSON.stringify(rules, null, 2)).toString('base64');
  await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `rules: ${rules.length} rules (auto)`, content, ...(sha ? { sha } : {}) }),
  });
}

async function getRulesForPrompt() {
  const rules = await loadRules();
  if (rules.length === 0) return '';
  let text = '\n\nTRAINING RULES (from team feedback — follow strictly):\n';
  rules.forEach((r, i) => { text += `${i + 1}. ${r.rule}\n`; });
  return text;
}

async function addRule(rule) {
  const rules = await loadRules();
  rules.push(rule);
  await saveRules(rules);
  return rules;
}

module.exports = { loadRules, saveRules, getRulesForPrompt, addRule };
