const SLACK_API = 'https://slack.com/api';

async function slackFetch(method, body) {
  const token = process.env.SLACK_BOT_TOKEN;
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) console.error(`Slack ${method} error:`, data.error);
  return data;
}

async function joinChannel(channel) {
  return slackFetch('conversations.join', { channel });
}

async function postMessage(channel, text, options = {}) {
  return slackFetch('chat.postMessage', {
    channel, text,
    thread_ts: options.threadTs,
    blocks: options.blocks,
    mrkdwn: true,
  });
}

async function updateMessage(channel, ts, text, blocks) {
  const result = await slackFetch('chat.update', { channel, ts, text, blocks });
  if (!result.ok) throw new Error(`updateMessage failed: ${result.error}`);
  return result;
}

async function openModal(triggerId, view) {
  return slackFetch('views.open', { trigger_id: triggerId, view });
}

async function postEphemeral(channel, user, text) {
  return slackFetch('chat.postEphemeral', { channel, user, text });
}

async function openDM(userId) {
  const result = await slackFetch('conversations.open', { users: userId });
  if (result.ok && result.channel?.id) return result.channel.id;
  throw new Error(`conversations.open failed: ${result.error}`);
}

async function findPublicChannel() {
  const result = await slackFetch('conversations.list', {
    types: 'public_channel',
    exclude_archived: true,
    limit: 100,
  });
  if (!result.ok) throw new Error(`conversations.list failed: ${result.error}`);
  const general = result.channels?.find(c => c.name === 'general');
  if (general) return general.id;
  const member = result.channels?.find(c => c.is_member);
  if (member) return member.id;
  if (result.channels?.[0]) return result.channels[0].id;
  throw new Error('No public channels found');
}

/**
 * Upload a file buffer to Slack using the v2 upload flow:
 * 1. files.getUploadURLExternal → get presigned URL
 * 2. PUT the file to the presigned URL
 * 3. files.completeUploadExternal → share in channel/thread
 *
 * @param {Buffer} fileBuffer - The file content as a Buffer
 * @param {string} filename - The filename (e.g. "report.xlsx")
 * @param {string} channel - Channel ID to share in
 * @param {object} options - { threadTs, initialComment }
 */
async function uploadFile(fileBuffer, filename, channel, options = {}) {
  const token = process.env.SLACK_BOT_TOKEN;

  // Step 1: Get upload URL
  const urlResp = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename,
      length: String(fileBuffer.length),
    }),
  });
  const urlData = await urlResp.json();
  if (!urlData.ok) {
    console.error('files.getUploadURLExternal error:', urlData.error);
    throw new Error(`files.getUploadURLExternal failed: ${urlData.error}`);
  }

  // Step 2: Upload file to the presigned URL
  const uploadResp = await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fileBuffer,
  });
  if (!uploadResp.ok) {
    throw new Error(`File upload failed: ${uploadResp.status} ${uploadResp.statusText}`);
  }

  // Step 3: Complete the upload and share in channel
  const completeBody = {
    files: [{ id: urlData.file_id, title: filename }],
  };

  // Build channel_id with optional thread_ts
  if (channel) {
    completeBody.channel_id = channel;
    if (options.threadTs) {
      completeBody.thread_ts = options.threadTs;
    }
  }

  if (options.initialComment) {
    completeBody.initial_comment = options.initialComment;
  }

  const completeResp = await slackFetch('files.completeUploadExternal', completeBody);
  if (!completeResp.ok) {
    console.error('files.completeUploadExternal error:', completeResp.error);
    throw new Error(`files.completeUploadExternal failed: ${completeResp.error}`);
  }

  return completeResp;
}

module.exports = {
  joinChannel,
  postMessage,
  updateMessage,
  openModal,
  postEphemeral,
  openDM,
  findPublicChannel,
  uploadFile,
};
