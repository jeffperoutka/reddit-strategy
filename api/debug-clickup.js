// TEMPORARY - Remove after discovering client docs
module.exports = async function handler(req, res) {
  const token = process.env.CLICKUP_API_TOKEN;
  const wsId = process.env.CLICKUP_WORKSPACE_ID;

  if (!token || !wsId) {
    return res.status(500).json({ error: 'Missing CLICKUP_API_TOKEN or CLICKUP_WORKSPACE_ID', hasToken: !!token, hasWsId: !!wsId });
  }

  const action = req.query.action || 'spaces';

  async function safeFetch(url, opts) {
    const resp = await fetch(url, opts);
    const text = await resp.text();
    try {
      return { status: resp.status, data: JSON.parse(text) };
    } catch {
      return { status: resp.status, raw: text.slice(0, 2000) };
    }
  }

  try {
    if (action === 'spaces') {
      const result = await safeFetch(`https://api.clickup.com/api/v2/team/${wsId}/space?archived=false`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'spaces', ...result });
    }

    if (action === 'folders') {
      const spaceId = req.query.space_id;
      if (!spaceId) return res.status(400).json({ error: 'space_id required' });
      const result = await safeFetch(`https://api.clickup.com/api/v2/space/${spaceId}/folder?archived=false`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'folders', spaceId, ...result });
    }

    if (action === 'lists') {
      const folderId = req.query.folder_id;
      if (!folderId) return res.status(400).json({ error: 'folder_id required' });
      const result = await safeFetch(`https://api.clickup.com/api/v2/folder/${folderId}/list?archived=false`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'lists', folderId, ...result });
    }

    if (action === 'search_docs') {
      const query = req.query.q || 'Client Info';
      const result = await safeFetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/search`, {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, types: ['doc'], limit: 50 }),
      });
      return res.status(200).json({ action: 'search_docs', query, ...result });
    }

    if (action === 'doc_pages') {
      const docId = req.query.doc_id;
      if (!docId) return res.status(400).json({ error: 'doc_id required' });
      const result = await safeFetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/docs/${docId}/pages`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'doc_pages', docId, ...result });
    }

    if (action === 'read_page') {
      const docId = req.query.doc_id;
      const pageId = req.query.page_id;
      if (!docId || !pageId) return res.status(400).json({ error: 'doc_id and page_id required' });
      const result = await safeFetch(
        `https://api.clickup.com/api/v3/workspaces/${wsId}/docs/${docId}/pages/${pageId}?content_format=text/md`,
        { headers: { 'Authorization': token } }
      );
      return res.status(200).json({ action: 'read_page', docId, pageId, ...result });
    }

    if (action === 'list_docs') {
      // List all docs in workspace via v3 API
      const result = await safeFetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/docs`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'list_docs', ...result });
    }

    if (action === 'list_docs_v2') {
      // Try ClickUp v2 search
      const query = req.query.q || 'Info Doc';
      const result = await safeFetch(`https://api.clickup.com/api/v2/team/${wsId}/task?page=0&subtasks=true&include_closed=true&custom_fields=[]`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'list_docs_v2', ...result });
    }

    if (action === 'folder_docs') {
      // Try listing docs within a specific folder
      const folderId = req.query.folder_id || '901812024928';
      // Try multiple approaches
      const results = {};

      // Approach 1: v3 folder docs
      results.v3_folder = await safeFetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/docs?folder_id=${folderId}`, {
        headers: { 'Authorization': token },
      });

      // Approach 2: v2 views for the folder
      results.v2_views = await safeFetch(`https://api.clickup.com/api/v2/folder/${folderId}/view`, {
        headers: { 'Authorization': token },
      });

      return res.status(200).json({ action: 'folder_docs', folderId, results });
    }

    if (action === 'search_v2') {
      // Try v2 search
      const query = req.query.q || 'Info Doc';
      const result = await safeFetch(`https://api.clickup.com/api/v2/team/${wsId}/task?page=0&include_closed=true`, {
        headers: { 'Authorization': token },
      });
      return res.status(200).json({ action: 'search_v2', ...result });
    }

    if (action === 'ws_info') {
      // Return workspace info and token prefix for debugging
      return res.status(200).json({
        action: 'ws_info',
        wsId,
        tokenPrefix: token.slice(0, 8) + '...',
        tokenLength: token.length
      });
    }

    return res.status(400).json({ error: 'Unknown action', available: ['spaces', 'folders', 'lists', 'search_docs', 'list_docs', 'folder_docs', 'doc_pages', 'read_page', 'ws_info'] });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
};
