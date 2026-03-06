const { waitUntil } = require('@vercel/functions');
const Anthropic = require('@anthropic-ai/sdk');
const slack = require('../../lib/connectors/slack');
const { getRulesForPrompt, addRule } = require('../../lib/connectors/rules');

const botThreads = new Set();
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;

  // URL verification challenge
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Event callback
  if (body.type === 'event_callback') {
    const event = body.event;
    if (!event) return res.status(200).json({ ok: true });

    // Skip bot messages and retries
    if (event.bot_id || event.subtype === 'bot_message') return res.status(200).json({ ok: true });
    if (req.headers['x-slack-retry-num']) return res.status(200).json({ ok: true });

    const { channel, text, ts, thread_ts: threadTs, user } = event;

    // Handle thread replies (training feedback)
    if (threadTs && threadTs !== ts) {
      res.status(200).json({ ok: true });
      waitUntil(handleThreadReply({ channel, text, ts, threadTs, user }));
      return;
    }

    // Handle direct mentions
    if (text && BOT_USER_ID && text.includes(`<@${BOT_USER_ID}>`)) {
      res.status(200).json({ ok: true });
      waitUntil(handleMention({ channel, text, ts, user }));
      return;
    }
  }

  return res.status(200).json({ ok: true });
};

async function handleThreadReply(ctx) {
  const { channel, text, ts, threadTs, user } = ctx;

  // Check if the thread was started by our bot
  if (!botThreads.has(threadTs)) {
    try {
      const resp = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=1`, {
        headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
      });
      const data = await resp.json();
      if (data.ok && data.messages?.[0]?.bot_id) {
        botThreads.add(threadTs);
      } else {
        return;
      }
    } catch (err) {
      return;
    }
  }

  // Parse feedback into a training rule
  try {
    const anthropic = new Anthropic();
    const currentRules = await getRulesForPrompt();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are Reddit Strategy Bot. A team member replied in a thread with feedback. Parse it into a reusable rule.

This is thread feedback — extract what they want changed about how the bot generates Reddit strategies, picks threads, or writes comments.

Message: "${text}"
Existing rules: ${currentRules || '(none)'}

Respond JSON only:
{
  "isTrainingRule": true/false,
  "rule": "The reusable rule",
  "category": "comment_style | thread_selection | brand_alignment | subreddit_strategy | other",
  "acknowledgment": "Brief acknowledgment message",
  "isDuplicate": true/false
}`
      }]
    });

    const parsed = JSON.parse(response.content[0].text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim());

    if (parsed.isTrainingRule && !parsed.isDuplicate) {
      await addRule({
        rule: parsed.rule,
        category: parsed.category,
        addedBy: user,
        addedAt: new Date().toISOString(),
      });
      await slack.postMessage(channel, `✅ ${parsed.acknowledgment}\n_Rule saved. Applied to all future runs._`, { threadTs: ts });
    } else if (parsed.isDuplicate) {
      await slack.postMessage(channel, `ℹ️ This rule already exists. No changes made.`, { threadTs: ts });
    }
  } catch (err) {
    console.error('handleThreadReply error:', err.message);
  }
}

async function handleMention(ctx) {
  const { channel, text, ts, user } = ctx;

  const lowerText = text.toLowerCase();

  if (lowerText.includes('list rules')) {
    const currentRules = await getRulesForPrompt();
    const reply = currentRules || 'No training rules yet. Reply to any strategy thread to teach me!';
    await slack.postMessage(channel, reply, { threadTs: ts });
  } else if (lowerText.includes('help')) {
    await slack.postMessage(channel, `*Sally the Reddit Bot — Commands:*
• \`/reddit-strategy\` — Kick off a new Reddit strategy run
• \`@Sally list rules\` — Show learned rules
• Reply in any strategy thread to give feedback and train me!`, { threadTs: ts });
  }
}
