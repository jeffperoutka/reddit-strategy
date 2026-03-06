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
  // Find a public channel the bot can post to
  const result = await slackFetch('conversations.list', {
    types: 'public_channel',
    exclude_archived: true,
    limit: 100,
  });
  if (!result.ok) throw new Error(`conversations.list failed: ${result.error}`);
  // Prefer #general, then any channel the bot is already a member of
  const general = result.channels?.find(c => c.name === 'general');
  if (general) return general.id;
  const member = result.channels?.find(c => c.is_member);
  if (member) return member.id;
  // Fall back to first available
  if (result.channels?.[0]) return result.channels[0].id;
  throw new Error('No public channels found');
}

module.exports = { joinChannel, postMessage, updateMessage, openModal, postEphemeral, openDM, findPublicChannel };
