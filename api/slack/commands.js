const { waitUntil } = require('@vercel/functions');
const slack = require('../../lib/connectors/slack');
const { readBrandGuardianCache } = require('../../lib/connectors/github');
const { getPackageOptions } = require('../../lib/packages');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { command, trigger_id, text, channel_id } = req.body;

  if (command === '/reddit-strategy') {
    res.status(200).send('');
    waitUntil(openStrategyModal(trigger_id, text, channel_id));
    return;
  }

  res.status(200).send('Unknown command');
};

async function openStrategyModal(triggerId, prefillText, channelId) {
  try {
    const blocks = [];

    // ── Client selection — searchable external select ──
    blocks.push({
      type: 'input',
      block_id: 'client_block',
      label: { type: 'plain_text', text: 'Client' },
      element: {
        type: 'external_select',
        action_id: 'client_select',
        placeholder: { type: 'plain_text', text: 'Search for a client...' },
        min_query_length: 0,
      },
    });

    // ── Client Website URL (optional — for new clients) ──
    blocks.push({
      type: 'input',
      block_id: 'client_url_block',
      label: { type: 'plain_text', text: 'Client Website URL' },
      optional: true,
      element: {
        type: 'url_text_input',
        action_id: 'client_url_input',
        placeholder: { type: 'plain_text', text: 'https://www.example.com (required if new client)' },
      },
    });

    // ── Package Selection ──
    const { PACKAGES } = require('../../lib/packages');
    const packageOptions = [
      {
        text: { type: 'plain_text', text: `Package A — 15 posts, 50 comments, 150 upvotes` },
        value: 'a',
      },
      {
        text: { type: 'plain_text', text: `Package B — 30 posts, 65 comments, 150 upvotes` },
        value: 'b',
      },
      {
        text: { type: 'plain_text', text: `Custom Scope` },
        value: 'custom',
      },
    ];

    blocks.push({
      type: 'input',
      block_id: 'package_block',
      label: { type: 'plain_text', text: 'Package Scope' },
      element: {
        type: 'static_select',
        action_id: 'package_select',
        placeholder: { type: 'plain_text', text: 'Select scope...' },
        options: packageOptions,
      },
    });

    // ── Month Number ──
    blocks.push({
      type: 'input',
      block_id: 'month_block',
      label: { type: 'plain_text', text: 'Campaign Month' },
      optional: true,
      element: {
        type: 'static_select',
        action_id: 'month_select',
        placeholder: { type: 'plain_text', text: 'Select month (default: Month 1)' },
        options: [
          { text: { type: 'plain_text', text: 'Month 1 (New client)' }, value: '1' },
          { text: { type: 'plain_text', text: 'Month 2' }, value: '2' },
          { text: { type: 'plain_text', text: 'Month 3' }, value: '3' },
          { text: { type: 'plain_text', text: 'Month 4' }, value: '4' },
          { text: { type: 'plain_text', text: 'Month 5' }, value: '5' },
          { text: { type: 'plain_text', text: 'Month 6+' }, value: '6' },
        ],
      },
    });

    // ── Previous Month Spreadsheet URL (for Month 2+) ──
    blocks.push({
      type: 'input',
      block_id: 'prev_spreadsheet_block',
      label: { type: 'plain_text', text: 'Previous Month Google Sheet' },
      optional: true,
      hint: { type: 'plain_text', text: 'Paste last month\'s Google Sheet URL. George will append new month tabs to the same file.' },
      element: {
        type: 'url_text_input',
        action_id: 'prev_spreadsheet_input',
        placeholder: { type: 'plain_text', text: 'https://docs.google.com/spreadsheets/d/...' },
      },
    });

    // ── Custom Keywords (optional) ──
    blocks.push({
      type: 'input',
      block_id: 'keywords_block',
      label: { type: 'plain_text', text: 'Custom Keywords (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'keywords_input',
        placeholder: { type: 'plain_text', text: 'Comma-separated: best CRM, CRM for startups, Salesforce alternative' },
      },
    });

    // ── Target Subreddits (optional) ──
    blocks.push({
      type: 'input',
      block_id: 'subreddits_block',
      label: { type: 'plain_text', text: 'Target Subreddits (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'subreddits_input',
        placeholder: { type: 'plain_text', text: 'Comma-separated: r/smallbusiness, r/startups, r/SaaS' },
      },
    });

    // ── Notes ──
    blocks.push({
      type: 'input',
      block_id: 'notes_block',
      label: { type: 'plain_text', text: 'Notes (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'notes_input',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Any specific goals, campaigns, or context for this strategy...' },
      },
    });

    const modal = {
      type: 'modal',
      callback_id: 'reddit_strategy_submit',
      private_metadata: JSON.stringify({ channel_id: channelId || '' }),
      title: { type: 'plain_text', text: 'George — Reddit Strategy' },
      submit: { type: 'plain_text', text: 'Run Strategy' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks,
    };

    await slack.openModal(triggerId, modal);
  } catch (err) {
    console.error('openStrategyModal error:', err.message);
  }
}
