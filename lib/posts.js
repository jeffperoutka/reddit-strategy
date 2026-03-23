const { askClaudeLong, extractJson } = require('./connectors/claude');
const { getPackage } = require('./packages');

async function generatePosts(analyzedThreads, brandProfile, packageTier, overridePkg) {
  const pkg = overridePkg || getPackage(packageTier);
  const totalTarget = pkg?.monthlyTargets?.posts || 0;

  if (!totalTarget) {
    return { posts: [], skipped: true, reason: 'Package does not include thread creation' };
  }

  // Trim subreddit data to essentials
  const subredditData = analyzedThreads.map(t => ({
    subreddit: t.subreddit, title: t.title, category: t.category,
  }));

  // Trim brand profile to essentials (avoid sending entire profile)
  const brandContext = {
    clientName: brandProfile.clientName,
    industry: brandProfile.industry,
    products: brandProfile.coreOfferings?.products || [],
    keyBenefits: brandProfile.coreOfferings?.keyBenefits || [],
    voice: brandProfile.brandVoice?.tone || 'Casual, helpful',
    targetAudience: brandProfile.targetAudience?.primary || '',
    competitors: (brandProfile.competitors || []).map(c => typeof c === 'string' ? c : c.name),
  };

  const BATCH_SIZE = 5;
  const allPosts = [];
  const batchCount = Math.ceil(totalTarget / BATCH_SIZE);

  const systemPrompt = `You are a Reddit post strategist. Generate new Reddit post ideas that provide genuine value to communities while creating organic opportunities for brand engagement in follow-up comments.

Rules:
- Posts must NOT directly mention the brand or product — they set up natural opportunities for brand mentions in later comments
- Each post must match the tone, style, and norms of its target subreddit
- Post titles must feel native to the subreddit
- Post body content should provide real value: ask genuine questions, share useful info, or spark meaningful discussion
- Vary post types across discussion, question, resource, and guide formats
- Include a brandMentionStrategy describing EXACTLY how "${brandProfile.clientName}" will be mentioned in a follow-up comment
- Include a followUpComment with the actual follow-up comment text mentioning "${brandProfile.clientName}" by name

Return valid JSON:
{
  "posts": [
    {
      "subreddit": "r/example",
      "title": "Post title here",
      "body": "Post body content here",
      "postType": "discussion|question|resource|guide",
      "brandMentionStrategy": "How the brand will be mentioned in the follow-up comment",
      "followUpComment": "The actual follow-up comment text that mentions the brand by name",
      "bestTimeToPost": "Day and time recommendation",
      "engagementPotential": "low|medium|high"
    }
  ]
}`;

  // Build batch configs and run in parallel
  const batchConfigs = [];
  let assigned = 0;
  for (let b = 0; b < batchCount && assigned < totalTarget; b++) {
    const batchTarget = Math.min(BATCH_SIZE, totalTarget - assigned);
    batchConfigs.push({ b, batchTarget });
    assigned += batchTarget;
  }

  console.log(`[Posts] Running ${batchConfigs.length} batches in parallel for ${totalTarget} total posts`);

  // Run batches with retry — each batch gets up to 2 attempts
  const batchResults = await Promise.all(batchConfigs.map(async ({ b, batchTarget }) => {
    const varietyNote = b > 0
      ? `\n\nThis is batch ${b + 1}/${batchCount}. Use DIFFERENT subreddits and angles from other batches for variety.`
      : '';

    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await askClaudeLong(
          systemPrompt,
          `Brand: ${JSON.stringify(brandContext)}

Subreddits from analyzed threads: ${JSON.stringify(subredditData)}

CRITICAL: Your JSON "posts" array MUST contain EXACTLY ${batchTarget} items. Not fewer. This is a hard contractual scope requirement.

Generate exactly ${batchTarget} Reddit post ideas.${varietyNote}`,
          { maxTokens: 12000, timeout: 180000 }
        );

        const result = extractJson(response);
        const posts = result.posts || [];
        console.log(`[Posts] Batch ${b + 1}/${batchCount} (attempt ${attempt}): got ${posts.length}/${batchTarget} posts`);

        if (posts.length >= batchTarget || attempt === MAX_ATTEMPTS) {
          return posts;
        }
        // Got fewer than expected — retry
        console.log(`[Posts] Batch ${b + 1}: short by ${batchTarget - posts.length}, retrying...`);
      } catch (error) {
        console.error(`[Posts] Batch ${b + 1}/${batchCount} attempt ${attempt} failed:`, error.message);
        if (attempt === MAX_ATTEMPTS) return [];
      }
    }
    return [];
  }));

  const allResults = batchResults.flat();
  console.log(`[Posts] Total: ${allResults.length}/${totalTarget} posts`);

  // If still short after retries, run fill-up batches until we hit the target (max 3 attempts)
  const MAX_FILLUPS = 3;
  for (let fillAttempt = 1; fillAttempt <= MAX_FILLUPS && allResults.length < totalTarget; fillAttempt++) {
    const deficit = totalTarget - allResults.length;
    console.log(`[Posts] Short by ${deficit} posts — fill-up attempt ${fillAttempt}/${MAX_FILLUPS}`);
    try {
      const response = await askClaudeLong(
        systemPrompt,
        `CRITICAL: Your JSON "posts" array MUST contain EXACTLY ${deficit} items. Not fewer. This is a hard contractual scope requirement.

Brand: ${JSON.stringify(brandContext)}

Subreddits from analyzed threads: ${JSON.stringify(subredditData)}

Generate exactly ${deficit} Reddit post ideas. Use DIFFERENT subreddits and angles from previous posts for variety.`,
        { maxTokens: 12000, timeout: 180000 }
      );
      const result = extractJson(response);
      const fillPosts = result.posts || [];
      console.log(`[Posts] Fill-up ${fillAttempt}: got ${fillPosts.length}/${deficit} posts`);
      allResults.push(...fillPosts);
    } catch (error) {
      console.error(`[Posts] Fill-up ${fillAttempt} failed:`, error.message);
    }
  }

  console.log(`[Posts] Final: ${Math.min(allResults.length, totalTarget)}/${totalTarget} posts`);

  return {
    posts: allResults.slice(0, totalTarget),
    count: Math.min(allResults.length, totalTarget),
    targetCount: totalTarget,
    packageTier,
  };
}

function planUpvoteSupport(comments, posts, packageTier, overridePkg) {
  const pkg = overridePkg || getPackage(packageTier);

  if (!pkg.monthlyTargets.upvotes) {
    return {
      enabled: false,
      skipped: true,
      reason: 'Package does not include upvote support'
    };
  }

  const allComments = comments || [];
  const allPosts = posts || [];

  // Build items with fields that match what the Google Sheet expects
  const allItems = [
    ...allComments.map((c, i) => ({
      contentType: 'Comment',
      target: c.threadTitle || c.comment?.slice(0, 60) || `Comment ${i + 1}`,
      subreddit: c.subreddit || '',
      priority: c.alignment?.score >= 80 ? 'high' : c.alignment?.score >= 60 ? 'medium' : 'low',
    })),
    ...allPosts.map((p, i) => ({
      contentType: 'Post',
      target: p.title || `Post ${i + 1}`,
      subreddit: p.subreddit || '',
      priority: p.engagementPotential === 'high' ? 'high' : p.engagementPotential === 'low' ? 'low' : 'medium',
    })),
  ];

  if (allItems.length === 0) {
    return {
      enabled: true,
      totalUpvotes: 0,
      distribution: [],
      timing: [],
      reason: 'No items to support'
    };
  }

  const baseUpvotesPerComment = 3;
  const baseUpvotesPerPost = 5;
  const priorityMultiplier = { high: 1.5, medium: 1, low: 0.5 };

  const distribution = allItems.map(item => {
    const base = item.contentType === 'Post' ? baseUpvotesPerPost : baseUpvotesPerComment;
    const multiplier = priorityMultiplier[item.priority] || 1;
    const upvotes = Math.round(base * multiplier);
    const delayMin = Math.floor(Math.random() * 120) + 10;
    const spreadHrs = item.contentType === 'Post' ? 6 : 3;

    return {
      contentType: item.contentType,
      type: item.contentType.toLowerCase(),
      target: item.target,
      subreddit: item.subreddit,
      upvotes,
      timing: `${delayMin}min delay, spread over ${spreadHrs}hrs`,
      priority: item.priority,
      notes: '',
    };
  });

  const totalUpvotes = distribution.reduce((sum, d) => sum + d.upvotes, 0);

  const timing = [
    { rule: 'Space upvotes at least 5-15 minutes apart per item' },
    { rule: 'Start upvoting 10-30 minutes after posting, not immediately' },
    { rule: 'Vary the count slightly each time — never exact same number' },
    { rule: 'Avoid upvoting during off-hours for the target subreddit timezone' },
    { rule: 'Posts should receive upvotes spread over a longer window than comments' },
  ];

  return {
    enabled: true,
    totalUpvotes,
    distribution,
    timing,
    itemCount: allItems.length,
    packageTier,
  };
}

module.exports = { generatePosts, planUpvoteSupport };
