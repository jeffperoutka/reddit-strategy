const { askClaudeLong } = require('./connectors/claude');
const { getPackage } = require('./packages');

async function generatePosts(analyzedThreads, brandProfile, packageTier) {
  const pkg = getPackage(packageTier);

  if (!pkg.monthlyTargets.threads || pkg.monthlyTargets.threads === 0) {
    return { posts: [], skipped: true, reason: 'Package does not include thread creation' };
  }

  const subredditData = analyzedThreads.map(t => ({
    subreddit: t.subreddit,
    title: t.title,
    score: t.score,
    postType: t.postType,
    flair: t.flair
  }));

  const systemPrompt = `You are a Reddit post strategist. Your job is to generate new Reddit post ideas that provide genuine value to communities while creating organic opportunities for brand engagement in follow-up comments.

Rules:
- Posts must NOT directly mention the brand or product — they set up natural opportunities for brand mentions in later comments
- Each post must match the tone, style, and norms of its target subreddit
- Post titles must feel native to the subreddit (match length, capitalization, emoji usage patterns)
- Post body content should provide real value: ask genuine questions, share useful info, or spark meaningful discussion
- Vary post types across discussion, question, resource, and guide formats
- Include a brandMentionStrategy for each post explaining how the brand can be naturally introduced in follow-up comments

Generate exactly ${pkg.monthlyTargets.threads} post ideas.

Return valid JSON in this exact format:
{
  "posts": [
    {
      "subreddit": "r/example",
      "title": "Post title here",
      "body": "Post body content here",
      "postType": "discussion|question|resource|guide",
      "brandMentionStrategy": "How to naturally mention the brand in follow-up comments",
      "bestTimeToPost": "Day and time recommendation",
      "expectedEngagement": "low|medium|high"
    }
  ]
}`;

  const userPrompt = `Brand Profile:
${JSON.stringify(brandProfile, null, 2)}

Subreddit Data from Analyzed Threads:
${JSON.stringify(subredditData, null, 2)}

Generate ${pkg.monthlyTargets.threads} Reddit post ideas that create organic opportunities for this brand. Each post should target one of the subreddits above (or closely related ones) and provide genuine value to the community.`;

  try {
    const response = await askClaudeLong(systemPrompt, userPrompt);

    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(cleaned);

    return {
      posts: result.posts || [],
      count: (result.posts || []).length,
      targetCount: pkg.monthlyTargets.threads,
      packageTier
    };
  } catch (error) {
    console.error('Error generating posts:', error.message);
    return { posts: [], count: 0, targetCount: pkg.monthlyTargets.threads, error: error.message };
  }
}

function planUpvoteSupport(comments, posts, packageTier) {
  const pkg = getPackage(packageTier);

  if (!pkg.monthlyTargets.upvoteSupport) {
    return {
      enabled: false,
      skipped: true,
      reason: 'Package does not include upvote support'
    };
  }

  const approvedComments = (comments || []).filter(c => c.approved || c.status === 'approved');
  const approvedPosts = (posts || []).filter(p => p.approved || p.status === 'approved');

  const allItems = [
    ...approvedComments.map(c => ({ type: 'comment', id: c.id, subreddit: c.subreddit, priority: c.priority || 'medium' })),
    ...approvedPosts.map(p => ({ type: 'post', id: p.id, subreddit: p.subreddit, priority: p.priority || 'medium' }))
  ];

  if (allItems.length === 0) {
    return {
      enabled: true,
      totalUpvotes: 0,
      distribution: [],
      timing: [],
      reason: 'No approved items to support'
    };
  }

  // Posts get slightly more upvotes than comments to help with visibility
  const baseUpvotesPerComment = 3;
  const baseUpvotesPerPost = 5;

  const priorityMultiplier = { high: 1.5, medium: 1, low: 0.5 };

  const distribution = allItems.map(item => {
    const base = item.type === 'post' ? baseUpvotesPerPost : baseUpvotesPerComment;
    const multiplier = priorityMultiplier[item.priority] || 1;
    const upvotes = Math.round(base * multiplier);

    return {
      type: item.type,
      id: item.id,
      subreddit: item.subreddit,
      upvotes,
      // Stagger timing to look natural
      delayMinutes: Math.floor(Math.random() * 120) + 10,
      spreadOverHours: item.type === 'post' ? 6 : 3
    };
  });

  const totalUpvotes = distribution.reduce((sum, d) => sum + d.upvotes, 0);

  const timing = [
    { rule: 'Space upvotes at least 5-15 minutes apart per item' },
    { rule: 'Start upvoting 10-30 minutes after posting, not immediately' },
    { rule: 'Vary the count slightly each time — never exact same number' },
    { rule: 'Avoid upvoting during off-hours for the target subreddit timezone' },
    { rule: 'Posts should receive upvotes spread over a longer window than comments' }
  ];

  return {
    enabled: true,
    totalUpvotes,
    distribution,
    timing,
    itemCount: allItems.length,
    packageTier
  };
}

module.exports = { generatePosts, planUpvoteSupport };
