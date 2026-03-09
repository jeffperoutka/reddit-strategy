/**
 * Reddit Strategy Engine v1
 *
 * Pipeline:
 * 1. Extract target keywords from brand profile
 * 2. DataForSEO: Search Google for Reddit threads per keyword
 * 3. (Optional) AI citation check per keyword
 * 4. Claude: Analyze top threads — scoring, narratives, opportunities
 * 5. Claude: Generate brand-aligned comment drafts
 * 6. Claude: Run brand alignment check on each comment
 * 7. Claude: Build complete strategy report
 */

const { askClaude, askClaudeLong, extractJson } = require('./connectors/claude');
const { getRulesForPrompt } = require('./connectors/rules');
const { batchSearchReddit, searchAICitations } = require('./connectors/dataforseo');
const { getPackage } = require('./packages');
const { generatePosts, planUpvoteSupport } = require('./posts');
const { runBrandAlignmentReview, prepareBrandAlignmentInput, writeBrandAlignmentOutput } = require('./brand-alignment');
const { reviewRedditBestPractices } = require('./reddit-best-practices');

// ─── STEP 1: Extract Keywords ───

async function extractKeywords(brandProfile, packageTier, customKeywords) {
  const pkg = getPackage(packageTier);
  const maxKeywords = pkg?.keywords || 5;

  // If user provided custom keywords, use those
  if (customKeywords && customKeywords.trim()) {
    return customKeywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, maxKeywords);
  }

  const result = await askClaude(
    `You extract target search keywords for Reddit strategy campaigns. Given a brand profile, identify the ${maxKeywords} most valuable keywords that real people would search on Google when looking for recommendations, reviews, or discussions in this brand's niche.

Focus on:
- "Best [product category]" keywords
- "Which [product] should I get" keywords
- "[Brand] review" and "[Brand] vs [competitor]" keywords
- Problem/solution keywords where the brand could be recommended
- Industry discussion keywords that attract the target audience

OUTPUT — JSON array of strings only, no markdown fences:
["keyword1", "keyword2", "keyword3"]`,

    `BRAND: ${brandProfile.clientName}
Industry: ${brandProfile.industry || 'Unknown'}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ') || 'Unknown'}
Target Audience: ${brandProfile.targetAudience?.primary || 'Unknown'}
Competitors: ${(brandProfile.competitors || []).map(c => typeof c === 'string' ? c : c.name).join(', ') || 'Unknown'}
Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}`,

    { maxTokens: 500, timeout: 30000 }
  );

  try {
    return extractJson(result);
  } catch (err) {
    console.error('Failed to parse keywords:', err.message, 'Raw:', result?.slice(0, 300));
    return [brandProfile.clientName, brandProfile.industry].filter(Boolean);
  }
}

// ─── STEP 2: Discover Threads (DataForSEO) ───

async function discoverThreads(keywords, packageTier) {
  const pkg = getPackage(packageTier);
  const results = await batchSearchReddit(keywords, {
    depth: pkg?.threadsPerKeyword ? pkg.threadsPerKeyword * 3 : 30,
  });

  return results.slice(0, pkg?.totalThreads || 15);
}

// ─── STEP 3: AI Citation Check ───

async function checkAICitations(keywords) {
  const citations = [];
  for (const keyword of keywords.slice(0, 5)) {
    const result = await searchAICitations(keyword);
    if (result.redditInOrganic.length > 0) {
      citations.push({
        keyword,
        redditThreads: result.redditInOrganic,
        hasAIOverview: result.aiOverview.length > 0,
      });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return citations;
}

// ─── STEP 4: Analyze Threads ───

async function analyzeThreads(threads, brandProfile, packageTier) {
  const trainingRules = await getRulesForPrompt();
  const pkg = getPackage(packageTier);

  // Cap threads for analysis
  const threadsToAnalyze = threads.slice(0, pkg?.totalThreads || 15);

  const threadList = threadsToAnalyze.map((t, i) =>
    `[${i}] URL: ${t.url}\nTitle: ${t.title}\nSubreddit: ${t.subreddit}\nDescription: ${t.description?.slice(0, 200) || 'N/A'}\nGoogle Position: ${t.position || 'N/A'}\nMatched Keywords: ${(t.keywords || []).join(', ')}`
  ).join('\n\n');

  const result = await askClaudeLong(
    `You are a Reddit Strategy Analyst at AEO Labs, an AI SEO agency. Analyze discovered Reddit threads for brand engagement opportunities.

BRAND CONTEXT:
Client: ${brandProfile.clientName}
Industry: ${brandProfile.industry || 'Unknown'}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Target Audience: ${brandProfile.targetAudience?.primary || 'Unknown'}
Brand Voice: ${brandProfile.brandVoice?.tone || 'Unknown'}
Competitors: ${(brandProfile.competitors || []).map(c => typeof c === 'string' ? c : c.name).join(', ') || 'None'}
${trainingRules}

SCORING DIMENSIONS (score each 0-100):
1. Google Ranking Value — How high does this thread rank? Top 5 = high value.
2. AI Citation Potential — Is this thread likely cited by AI engines? Discussion-heavy threads with clear recommendations score higher.
3. Engagement Level — Active discussion with real engagement vs dead thread.
4. Sentiment Alignment — Does the thread's sentiment match our positioning opportunity?
5. Opportunity Quality — How natural would a brand mention be here? Forced = 0, Perfect fit = 100.

THREAD CATEGORIES:
- "high_value": Scores 70+ overall, immediate engagement opportunity
- "medium_value": Scores 40-69, good for building presence
- "monitor": Below 40, track but don't engage yet

OUTPUT — valid JSON only, no markdown fences:
{
  "analyzedThreads": [
    {
      "index": 0,
      "url": "thread url",
      "title": "thread title",
      "subreddit": "r/subreddit",
      "category": "high_value | medium_value | monitor",
      "overallScore": 75,
      "scores": {
        "googleRanking": 80,
        "aiCitation": 70,
        "engagement": 65,
        "sentiment": 80,
        "opportunity": 75
      },
      "narrative": "What this thread is about and the dominant sentiment",
      "opportunity": "Specific opportunity for the brand in this thread",
      "suggestedAngle": "The angle/approach for a comment",
      "risks": "Any risks of engaging here",
      "matchedKeywords": ["keyword1"]
    }
  ],
  "subredditMap": {
    "r/subreddit": {
      "threadCount": 3,
      "avgScore": 72,
      "archetype": "Brand Community | Passion Community | Highly Cited | Internet Culture",
      "engagementStrategy": "How to approach this subreddit"
    }
  },
  "topThemes": ["theme1", "theme2"],
  "competitorPresence": "Summary of any competitor mentions spotted"
}`,

    `Analyze these ${threadsToAnalyze.length} Reddit threads:\n\n${threadList}`,

    { maxTokens: 6000, timeout: 120000 }
  );

  try {
    return extractJson(result);
  } catch (err) {
    console.error('Failed to parse thread analysis:', err.message, 'Raw:', result?.slice(0, 500));
    return { analyzedThreads: [], subredditMap: {}, topThemes: [], competitorPresence: '' };
  }
}

// ─── STEP 5: Generate Comment Drafts ───

async function generateComments(analyzedThreads, brandProfile, packageTier) {
  const trainingRules = await getRulesForPrompt();
  const pkg = getPackage(packageTier);
  const commentCount = pkg?.commentsToGenerate || 8;

  // Only generate comments for high_value and medium_value threads
  const targetThreads = analyzedThreads
    .filter(t => t.category === 'high_value' || t.category === 'medium_value')
    .slice(0, commentCount);

  if (targetThreads.length === 0) {
    return { comments: [], summary: 'No suitable threads found for comment generation.' };
  }

  const threadList = targetThreads.map((t, i) =>
    `[${i}] Thread: ${t.title}\nSubreddit: ${t.subreddit}\nURL: ${t.url}\nCategory: ${t.category} (Score: ${t.overallScore})\nOpportunity: ${t.opportunity}\nSuggested Angle: ${t.suggestedAngle}`
  ).join('\n\n');

  const result = await askClaudeLong(
    `You are a Reddit Comment Strategist at AEO Labs. Write authentic Reddit comments that naturally integrate brand mentions.

BRAND CONTEXT:
Client: ${brandProfile.clientName}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}
Voice: ${brandProfile.brandVoice?.tone || 'Casual, helpful'}
Do NOT Say: ${(brandProfile.brandVoice?.doNotSay || []).join(', ') || 'None'}
Preferred Terms: ${(brandProfile.brandVoice?.preferredTerms || []).join(', ') || 'None'}
${trainingRules}

MANDATORY RULE — BRAND NAME MUST APPEAR:
Every single comment MUST mention "${brandProfile.clientName}" by name at least once. This is non-negotiable.
If we are paying to place a comment and the brand name does not appear, it is wasted money.
The mention must feel natural — like a real person recommending something they actually used — but it MUST be there.

CRITICAL RULES — THE 90/10 FRAMEWORK:
1. 90% genuine value, 10% brand mention. The comment must HELP the reader first, but the brand name "${brandProfile.clientName}" MUST appear.
2. Sound like a REAL PERSON, not a marketer. Use casual Reddit language. No brand-speak.
3. Write from a third-person perspective — "I tried [brand]" or "I switched to [brand]". Never "we" or insider language.
4. Share a genuine experience or recommendation — never a sales pitch. Include honest pros AND cons.
5. Match the subreddit's tone. r/technology is different from r/personalfinance.
6. The brand mention should feel like a helpful aside within a genuinely useful comment, not the centerpiece.
7. Include specific details that a real user would know (features, quirks, honest pros/cons).
8. If appropriate, mention a minor negative about the brand (builds credibility). E.g. "the app could use some work" or "took a few days to get used to."
9. Reference the thread's context directly — respond to what people are actually discussing. Your comment must make sense as a reply to THIS specific thread.
10. Keep it concise. Real Reddit comments aren't essays. 2-4 sentences is ideal, max 6.
11. Never use marketing jargon, superlatives ("best ever", "game-changer", "revolutionary"), or unnatural enthusiasm.
12. The comment should read like someone who genuinely uses the product sharing their experience — not someone being paid to mention it.

OUTPUT — valid JSON only, no markdown fences:
{
  "comments": [
    {
      "threadIndex": 0,
      "threadTitle": "thread title",
      "threadUrl": "url",
      "subreddit": "r/subreddit",
      "comment": "The actual Reddit comment text",
      "angle": "What angle this comment takes",
      "brandMentionType": "direct | indirect | contextual",
      "confidenceScore": 85,
      "notes": "Why this comment works and any risks"
    }
  ],
  "summary": "Brief summary of the comment strategy"
}`,

    `Generate authentic Reddit comments for these ${targetThreads.length} threads:\n\n${threadList}`,

    { maxTokens: 6000, timeout: 120000 }
  );

  try {
    return extractJson(result);
  } catch (err) {
    console.error('Failed to parse comments:', err.message, 'Raw:', result?.slice(0, 500));
    return { comments: [], summary: 'Comment generation failed.' };
  }
}

// ─── STEP 6: Brand Alignment Check ───

async function checkBrandAlignment(comments, brandProfile) {
  const results = [];

  for (const comment of comments.slice(0, 20)) {
    const result = await askClaude(
      `You are a Brand Alignment Checker for Reddit comments. Check if this comment aligns with the client's brand while sounding authentic.

BRAND: ${brandProfile.clientName}
Voice: ${brandProfile.brandVoice?.tone || 'Unknown'}
Do NOT Say: ${(brandProfile.brandVoice?.doNotSay || []).join(', ') || 'None'}
Products: ${(brandProfile.coreOfferings?.products || []).join(', ')}
Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}

CHECK:
1. Is brand info accurate? (products, features, claims)
2. Does it sound like a real person, NOT a marketer?
3. Does the brand mention feel natural or forced?
4. Any claims that don't match the brand's actual offerings?
5. Would this get flagged as spam/marketing by Reddit users?

OUTPUT — JSON only, no fences:
{
  "aligned": true/false,
  "score": 85,
  "issues": ["issue1"],
  "fixes": ["fix1"],
  "spamRisk": "low | medium | high"
}`,

      `Thread: ${comment.threadTitle} (${comment.subreddit})\n\nCOMMENT:\n${comment.comment}`,

      { maxTokens: 500, timeout: 30000 }
    );

    try {
      const check = extractJson(result);
      results.push({ ...comment, alignment: check });
    } catch (err) {
      console.error('Failed to parse alignment check:', err.message);
      results.push({ ...comment, alignment: { aligned: true, score: 70, issues: [], fixes: [], spamRisk: 'unknown' } });
    }
  }

  return results;
}

// ─── STEP 7: Build Strategy Report ───

async function buildStrategyReport(data, brandProfile, packageTier) {
  const pkg = getPackage(packageTier);

  const result = await askClaudeLong(
    `You are a Senior Reddit Strategist at AEO Labs. Synthesize all research into an executive Reddit Strategy Report.

Package: ${pkg?.name || packageTier}
Monthly Targets: ${JSON.stringify(pkg?.monthlyTargets || {})}

STRUCTURE:
1. Executive Summary (3-4 sentences)
2. Keyword Performance (which keywords found the best threads)
3. Top Thread Opportunities (ranked by score)
4. Subreddit Strategy Map (which subreddits to prioritize)
5. Comment Strategy Overview (angles, tone, approach)
6. Brand Alignment Notes (any recurring issues)
7. Recommended Actions (prioritized next steps)
8. Risk Assessment (spam detection, community backlash, etc.)

OUTPUT — valid JSON only, no markdown fences:
{
  "executiveSummary": "string",
  "keywordPerformance": [{"keyword": "", "threadsFound": 0, "avgScore": 0, "topThread": ""}],
  "topOpportunities": [{"title": "", "url": "", "subreddit": "", "score": 0, "opportunity": ""}],
  "subredditStrategy": [{"subreddit": "", "archetype": "", "priority": "high|medium|low", "approach": ""}],
  "commentStrategy": {"totalDrafted": 0, "avgAlignmentScore": 0, "approach": ""},
  "brandAlignmentNotes": ["note"],
  "recommendedActions": [{"action": "", "priority": "high|medium|low", "timeline": ""}],
  "riskAssessment": {"overallRisk": "low|medium|high", "risks": [{"risk": "", "mitigation": ""}]}
}`,

    `Build the strategy report from this data:

BRAND: ${brandProfile.clientName}
INDUSTRY: ${brandProfile.industry}

KEYWORDS RESEARCHED: ${JSON.stringify(data.keywords)}

THREAD ANALYSIS: ${JSON.stringify(data.threadAnalysis?.analyzedThreads?.slice(0, 20) || [])}

SUBREDDIT MAP: ${JSON.stringify(data.threadAnalysis?.subredditMap || {})}

COMMENTS GENERATED: ${data.commentsWithAlignment?.length || 0} comments
AVG ALIGNMENT SCORE: ${data.commentsWithAlignment?.length > 0 ? Math.round(data.commentsWithAlignment.reduce((sum, c) => sum + (c.alignment?.score || 0), 0) / data.commentsWithAlignment.length) : 'N/A'}

POSTS GENERATED: ${data.posts?.length || 0} post drafts

BRAND ALIGNMENT REVIEW: ${data.brandAlignmentReport ? `Overall score: ${data.brandAlignmentReport.overall_score}/10, Issues: ${(data.brandAlignmentReport.top_issues || []).join('; ')}` : 'Not run'}

REDDIT BEST PRACTICES: ${data.bestPracticesReport ? `Overall score: ${data.bestPracticesReport.overall_score}/10, Issues: ${(data.bestPracticesReport.top_issues || []).join('; ')}` : 'Not run'}

UPVOTE PLAN: ${data.upvotePlan ? `${data.upvotePlan.totalUpvotes} upvotes planned` : 'N/A'}

AI CITATIONS: ${JSON.stringify(data.aiCitations?.slice(0, 5) || [])}

COMPETITOR PRESENCE: ${data.threadAnalysis?.competitorPresence || 'None detected'}`,

    { maxTokens: 6000, timeout: 120000 }
  );

  try {
    return extractJson(result);
  } catch (err) {
    console.error('Failed to parse strategy report:', err.message, 'Raw:', result?.slice(0, 500));
    return { executiveSummary: 'Report generation failed. Check logs.' };
  }
}

// ─── MAIN PIPELINE ───

/**
 * Run the full Reddit strategy pipeline.
 *
 * @param {object} brandProfile - Brand profile from Brand Guardian
 * @param {string} packageTier - 'a', 'b', or 'c'
 * @param {string} customKeywords - Optional comma-separated keywords
 * @param {function} progressCallback - Async function to report progress
 * @returns {object} Complete strategy data
 */
async function runStrategyPipeline(brandProfile, packageTier, customKeywords, progressCallback) {
  const pkg = getPackage(packageTier);
  let data = {};

  // Step 1: Keywords
  if (progressCallback) await progressCallback('Extracting target keywords...');
  data.keywords = await extractKeywords(brandProfile, packageTier, customKeywords);
  if (progressCallback) await progressCallback(`Found ${data.keywords.length} keywords: ${data.keywords.join(', ')}`);

  // Step 2: Discover threads via DataForSEO
  if (progressCallback) await progressCallback(`Searching Google for Reddit threads across ${data.keywords.length} keywords...`);
  data.threads = await discoverThreads(data.keywords, packageTier);
  if (progressCallback) await progressCallback(`Discovered ${data.threads.length} Reddit threads`);

  // Step 3: AI Citation check (Package B & C only)
  if (pkg?.features?.aiCitationCheck) {
    if (progressCallback) await progressCallback('Checking AI citation data...');
    data.aiCitations = await checkAICitations(data.keywords);
  } else {
    data.aiCitations = [];
  }

  // Step 4: Analyze threads
  if (data.threads.length > 0) {
    if (progressCallback) await progressCallback(`Analyzing ${data.threads.length} threads for opportunities...`);
    data.threadAnalysis = await analyzeThreads(data.threads, brandProfile, packageTier);
    if (progressCallback) {
      const highValue = (data.threadAnalysis.analyzedThreads || []).filter(t => t.category === 'high_value').length;
      await progressCallback(`Analysis complete: ${highValue} high-value, ${data.threadAnalysis.analyzedThreads?.length - highValue} medium/monitor`);
    }
  } else {
    data.threadAnalysis = { analyzedThreads: [], subredditMap: {}, topThemes: [], competitorPresence: '' };
    if (progressCallback) await progressCallback('No Reddit threads found for these keywords.');
  }

  // Step 5: Generate comments
  if (data.threadAnalysis.analyzedThreads?.length > 0) {
    if (progressCallback) await progressCallback('Generating brand-aligned comment drafts...');
    const commentResult = await generateComments(
      data.threadAnalysis.analyzedThreads,
      brandProfile,
      packageTier
    );
    data.comments = commentResult.comments || [];
    if (progressCallback) await progressCallback(`Generated ${data.comments.length} comment drafts`);

    // Step 6: Brand alignment check
    if (data.comments.length > 0) {
      if (progressCallback) await progressCallback('Running brand alignment check on comments...');
      data.commentsWithAlignment = await checkBrandAlignment(data.comments, brandProfile);
      if (progressCallback) {
        const aligned = data.commentsWithAlignment.filter(c => c.alignment?.aligned).length;
        await progressCallback(`Brand alignment: ${aligned}/${data.commentsWithAlignment.length} comments aligned`);
      }
    } else {
      data.commentsWithAlignment = [];
    }
  } else {
    data.comments = [];
    data.commentsWithAlignment = [];
  }

  // Step 7: Generate Posts (Package B & C only)
  if (pkg?.monthlyTargets?.posts > 0 && data.threadAnalysis?.analyzedThreads?.length > 0) {
    if (progressCallback) await progressCallback(`Generating ${pkg.monthlyTargets.posts} Reddit post ideas...`);
    try {
      const postResult = await generatePosts(data.threadAnalysis.analyzedThreads, brandProfile, packageTier);
      data.posts = postResult.posts || [];
      if (progressCallback) await progressCallback(`Generated ${data.posts.length} post drafts`);
    } catch (err) {
      console.error('Post generation failed:', err.message);
      data.posts = [];
    }
  } else {
    data.posts = [];
  }

  // Step 8: Brand Alignment Review (using brand-alignment skill)
  const allContent = [...(data.commentsWithAlignment || []), ...(data.posts || [])];
  if (allContent.length > 0) {
    if (progressCallback) await progressCallback('Running brand alignment skill review...');
    try {
      const alignmentInput = prepareBrandAlignmentInput(
        data.commentsWithAlignment || [],
        data.posts || [],
        brandProfile.clientName
      );
      const alignmentResult = await runBrandAlignmentReview(
        alignmentInput.content_data,
        brandProfile.clientName,
        'reddit',
        brandProfile
      );
      data.brandAlignmentReport = alignmentResult;
      data = writeBrandAlignmentOutput(data, alignmentResult);
      if (progressCallback) {
        const score = alignmentResult.overall_score || 'N/A';
        await progressCallback(`Brand alignment review complete — overall score: ${score}/10`);
      }
    } catch (err) {
      console.error('Brand alignment review failed:', err.message);
      data.brandAlignmentReport = null;
    }
  }

  // Step 9: Reddit Best Practices Review
  if (allContent.length > 0) {
    if (progressCallback) await progressCallback('Running Reddit best practices review...');
    try {
      data.bestPracticesReport = await reviewRedditBestPractices(
        data.commentsWithAlignment || [],
        data.posts || [],
        data.threadAnalysis?.analyzedThreads || []
      );
      if (progressCallback) {
        const score = data.bestPracticesReport?.overall_score || 'N/A';
        await progressCallback(`Reddit best practices review complete — overall score: ${score}/10`);
      }
    } catch (err) {
      console.error('Reddit best practices review failed:', err.message);
      data.bestPracticesReport = null;
    }
  }

  // Step 10: Upvote Support Planning (Package B & C)
  if (pkg?.monthlyTargets?.upvotes > 0) {
    if (progressCallback) await progressCallback('Planning upvote support strategy...');
    try {
      data.upvotePlan = await planUpvoteSupport(
        data.commentsWithAlignment || [],
        data.posts || [],
        packageTier
      );
      if (progressCallback) await progressCallback(`Upvote plan: ${data.upvotePlan?.totalUpvotes || 0} upvotes allocated`);
    } catch (err) {
      console.error('Upvote planning failed:', err.message);
      data.upvotePlan = null;
    }
  }

  // Step 11: Build strategy report
  if (progressCallback) await progressCallback('Building strategy report...');
  data.report = await buildStrategyReport(data, brandProfile, packageTier);

  // Log pipeline output summary for debugging
  console.log('Pipeline complete:', {
    keywords: data.keywords?.length || 0,
    threads: data.threads?.length || 0,
    analyzedThreads: data.threadAnalysis?.analyzedThreads?.length || 0,
    comments: data.commentsWithAlignment?.length || 0,
    posts: data.posts?.length || 0,
    upvotes: data.upvotePlan?.totalUpvotes || 0,
    hasReport: !!data.report?.executiveSummary,
  });

  return data;
}

module.exports = {
  extractKeywords,
  discoverThreads,
  checkAICitations,
  analyzeThreads,
  generateComments,
  checkBrandAlignment,
  buildStrategyReport,
  runStrategyPipeline,
  // Re-export from sub-modules for direct access
  generatePosts,
  planUpvoteSupport,
  runBrandAlignmentReview,
  reviewRedditBestPractices,
};
