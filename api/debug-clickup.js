// TEMPORARY - Remove after discovering client docs
module.exports = async function handler(req, res) {
  const token = process.env.CLICKUP_API_TOKEN;
  const wsId = process.env.CLICKUP_WORKSPACE_ID;

  if (!token || !wsId) {
    return res.status(500).json({ error: 'Missing CLICKUP_API_TOKEN or CLICKUP_WORKSPACE_ID' });
  }

  const action = req.query.action || 'spaces';

  try {
    if (action === 'spaces') {
      // List all spaces in the workspace
      const resp = await fetch(`https://api.clickup.com/api/v2/team/${wsId}/space?archived=false`, {
        headers: { 'Authorization': token },
      });
      const data = await resp.json();
      return res.status(200).json({ action: 'spaces', data });
    }

    if (action === 'folders') {
      // List folders in a space
      const spaceId = req.query.space_id;
      if (!spaceId) return res.status(400).json({ error: 'space_id required' });
      const resp = await fetch(`https://api.clickup.com/api/v2/space/${spaceId}/folder?archived=false`, {
        headers: { 'Authorization': token },
      });
      const data = await resp.json();
      return res.status(200).json({ action: 'folders', spaceId, data });
    }

    if (action === 'lists') {
      // List lists in a folder
      const folderId = req.query.folder_id;
      if (!folderId) return res.status(400).json({ error: 'folder_id required' });
      const resp = await fetch(`https://api.clickup.com/api/v2/folder/${folderId}/list?archived=false`, {
        headers: { 'Authorization': token },
      });
      const data = await resp.json();
      return res.status(200).json({ action: 'lists', folderId, data });
    }

    if (action === 'search_docs') {
      // Search for docs containing "info" or "client"
      const query = req.query.q || 'Client Info';
      const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/search`, {
        method: 'POST',
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, types: ['doc'], limit: 50 }),
      });
      const data = await resp.json();
      return res.status(200).json({ action: 'search_docs', query, data });
    }

    if (action === 'doc_pages') {
      // Read pages of a specific doc
      const docId = req.query.doc_id;
      if (!docId) return res.status(400).json({ error: 'doc_id required' });
      const resp = await fetch(`https://api.clickup.com/api/v3/workspaces/${wsId}/docs/${docId}/pages`, {
        headers: { 'Authorization': token },
      });
      const data = await resp.json();
      return res.status(200).json({ action: 'doc_pages', docId, data });
    }

    if (action === 'read_page') {
      // Read content of a specific page
      const docId = req.query.doc_id;
      const pageId = req.query.page_id;
      if (!docId || !pageId) return res.status(400).json({ error: 'doc_id and page_id required' });
      const resp = await fetch(
        `https://api.clickup.com/api/v3/workspaces/${wsId}/docs/${docId}/pages/${pageId}?content_format=text/md`,
        { headers: { 'Authorization': token } }
      );
      const data = await resp.json();
      return res.status(200).json({ action: 'read_page', docId, pageId, data });
    }

    if (action === 'views') {
      // List views in the workspace
      const resp = await fetch(`https://api.clickup.com/api/v2/team/${wsId}/view`, {
        headers: { 'Authorization': token },
      });
      const data = await resp.json();
      return res.status(200).json({ action: 'views', data });
    }

    return res.status(400).json({ error: 'Unknown action', available: ['spaces', 'folders', 'lists', 'search_docs', 'doc_pages', 'read_page', 'views'] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
