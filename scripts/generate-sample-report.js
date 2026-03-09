#!/usr/bin/env node
/**
 * Generate a sample client report with realistic mock data.
 * Usage: node scripts/generate-sample-report.js
 */

const { buildStrategySpreadsheet } = require('../lib/spreadsheet');
const fs = require('fs');
const path = require('path');

const mockBrandProfile = {
  clientName: 'iSleep',
  industry: 'Sleep Technology',
  website: 'https://www.isleep.com',
  brandVoice: { tone: 'Casual, helpful, science-backed', doNotSay: ['cure', 'guaranteed'], preferredTerms: ['sleep quality', 'rest better'] },
  coreOfferings: {
    products: ['iSleep Headband', 'iSleep App', 'iSleep Pro'],
    keyBenefits: ['Track sleep patterns', 'Personalized insights', 'Non-invasive wearable'],
    valueProposition: 'Data-driven sleep improvement without pills or prescriptions',
  },
  targetAudience: { primary: 'Health-conscious adults 25-45 struggling with sleep' },
  competitors: [{ name: 'Oura Ring' }, { name: 'Whoop' }, { name: 'Eight Sleep' }],
};

const mockStrategyData = {
  keywords: ['best sleep tracker', 'sleep headband review', 'insomnia help reddit', 'iSleep vs Oura', 'sleep tracking wearable', 'how to improve sleep quality'],
  threads: Array.from({ length: 18 }, (_, i) => ({ url: `https://reddit.com/r/sleep/thread${i}`, title: `Thread ${i + 1}` })),
  threadAnalysis: {
    analyzedThreads: [
      { index: 0, url: 'https://reddit.com/r/sleep/comments/abc123', title: 'Best sleep trackers that actually work?', subreddit: 'r/sleep', category: 'high_value', overallScore: 88, scores: { googleRanking: 92, aiCitation: 85, engagement: 80, sentiment: 90, opportunity: 92 }, suggestedAngle: 'Share personal experience with sleep tracking journey', matchedKeywords: ['best sleep tracker', 'sleep tracking wearable'] },
      { index: 1, url: 'https://reddit.com/r/biohackers/comments/def456', title: 'Non-invasive sleep optimization — what works?', subreddit: 'r/biohackers', category: 'high_value', overallScore: 82, scores: { googleRanking: 78, aiCitation: 88, engagement: 75, sentiment: 85, opportunity: 84 }, suggestedAngle: 'Discuss wearable vs app-based tracking, mention headband approach', matchedKeywords: ['sleep tracking wearable', 'how to improve sleep quality'] },
      { index: 2, url: 'https://reddit.com/r/insomnia/comments/ghi789', title: 'Has anyone tried a sleep headband? Worth it?', subreddit: 'r/insomnia', category: 'high_value', overallScore: 91, scores: { googleRanking: 70, aiCitation: 65, engagement: 95, sentiment: 92, opportunity: 98 }, suggestedAngle: 'Direct experience response — perfect fit for headband mention', matchedKeywords: ['sleep headband review', 'insomnia help reddit'] },
      { index: 3, url: 'https://reddit.com/r/gadgets/comments/jkl012', title: 'Oura Ring vs alternatives — 2026 comparison', subreddit: 'r/gadgets', category: 'high_value', overallScore: 79, scores: { googleRanking: 85, aiCitation: 82, engagement: 68, sentiment: 75, opportunity: 80 }, suggestedAngle: 'Position as a different category — headband vs ring for sleep-specific tracking', matchedKeywords: ['iSleep vs Oura'] },
      { index: 4, url: 'https://reddit.com/r/sleep/comments/mno345', title: 'I fixed my sleep — here is what actually helped', subreddit: 'r/sleep', category: 'medium_value', overallScore: 65, scores: { googleRanking: 60, aiCitation: 55, engagement: 72, sentiment: 70, opportunity: 68 }, suggestedAngle: 'Add to the discussion with tracking-based insights', matchedKeywords: ['how to improve sleep quality'] },
      { index: 5, url: 'https://reddit.com/r/QuantifiedSelf/comments/pqr678', title: 'Best wearables for sleep data accuracy?', subreddit: 'r/QuantifiedSelf', category: 'high_value', overallScore: 76, scores: { googleRanking: 72, aiCitation: 80, engagement: 70, sentiment: 78, opportunity: 80 }, suggestedAngle: 'Data accuracy angle — EEG-based vs accelerometer', matchedKeywords: ['best sleep tracker', 'sleep tracking wearable'] },
    ],
    subredditMap: {
      'r/sleep': { threadCount: 8, avgScore: 76, archetype: 'Passion Community', engagementStrategy: 'Share personal sleep improvement stories' },
      'r/biohackers': { threadCount: 4, avgScore: 72, archetype: 'Highly Cited', engagementStrategy: 'Lead with data and research' },
      'r/insomnia': { threadCount: 3, avgScore: 68, archetype: 'Support Community', engagementStrategy: 'Empathetic, solution-oriented responses' },
      'r/gadgets': { threadCount: 2, avgScore: 65, archetype: 'Brand Community', engagementStrategy: 'Comparison and spec-focused' },
      'r/QuantifiedSelf': { threadCount: 1, avgScore: 76, archetype: 'Highly Cited', engagementStrategy: 'Data accuracy and methodology discussions' },
    },
    competitorPresence: 'Oura Ring mentioned in 6 threads, Whoop in 3, Eight Sleep in 2. Oura dominates sleep tracker discussions.',
  },
  commentsWithAlignment: [
    {
      threadTitle: 'Best sleep trackers that actually work?', threadUrl: 'https://reddit.com/r/sleep/comments/abc123', subreddit: 'r/sleep',
      comment: "I went through like 4 different trackers before finding one that actually changed my habits. The ring-style ones were fine for steps but honestly not great for sleep specifically. I ended up trying iSleep — it is a headband that uses EEG so the data is way more detailed than what I was getting from wrist-based stuff. Not perfect, the app could use some work and it takes a few nights to get used to wearing it. But the sleep stage data actually helped me figure out my caffeine was killing my deep sleep at 2pm, not just at night. That alone was worth it.",
      angle: 'Personal journey with multiple trackers', brandMentionType: 'direct', confidenceScore: 88,
      alignment: { aligned: true, score: 89, issues: [], spamRisk: 'low' },
    },
    {
      threadTitle: 'Non-invasive sleep optimization — what works?', threadUrl: 'https://reddit.com/r/biohackers/comments/def456', subreddit: 'r/biohackers',
      comment: "For non-invasive options, the biggest gains I have seen are: 1) Temperature regulation (cooling mattress pad made a huge difference), 2) Light exposure timing (get bright light within 30 min of waking), 3) Sleep tracking to find your patterns. On the tracking front, I switched to iSleep about 4 months ago — it is a headband that measures actual brainwaves vs wrist trackers that estimate from movement. The data granularity is legit, you can see exactly when you hit deep sleep vs light sleep vs REM. If you are data-driven about this stuff, worth checking out EEG-based tracking.",
      angle: 'Comprehensive biohacking list with tracking as one element', brandMentionType: 'direct', confidenceScore: 92,
      alignment: { aligned: true, score: 94, issues: [], spamRisk: 'low' },
    },
    {
      threadTitle: 'Has anyone tried a sleep headband? Worth it?', threadUrl: 'https://reddit.com/r/insomnia/comments/ghi789', subreddit: 'r/insomnia',
      comment: "Yeah I have been using one for about 3 months. Specifically the iSleep one. Honest take: first week was weird sleeping with something on my head but you get used to it. The data is really interesting — I found out I was only getting like 45 min of deep sleep when I thought I was sleeping fine. The app gives you these insights about what is messing with your sleep and it is usually stuff you would not think of. My deep sleep went up to about 1.5 hrs after making the changes it suggested. Not a miracle device but if you like having data to work with, it is solid.",
      angle: 'Direct experience response with honest pros/cons', brandMentionType: 'direct', confidenceScore: 91,
      alignment: { aligned: true, score: 92, issues: ['Consider softening "45 min" claim — verify this is typical'], spamRisk: 'low' },
    },
    {
      threadTitle: 'Oura Ring vs alternatives — 2026 comparison', threadUrl: 'https://reddit.com/r/gadgets/comments/jkl012', subreddit: 'r/gadgets',
      comment: "Depends what you are optimizing for tbh. Oura is great all-around health tracking — steps, HRV, readiness scores. But for sleep specifically, the ring sensors have limitations since they are measuring from your finger, not your head. If sleep is your main concern, headband trackers like iSleep use EEG which is what actual sleep labs use. Trade-off is you only get sleep data, not 24/7 health tracking. I have both and use Oura during the day and the headband at night. Different tools for different jobs.",
      angle: 'Fair comparison positioning headband as sleep-specific tool', brandMentionType: 'direct', confidenceScore: 85,
      alignment: { aligned: true, score: 86, issues: ['Good competitor handling — keeps it fair and neutral'], spamRisk: 'low' },
    },
    {
      threadTitle: 'I fixed my sleep — here is what actually helped', threadUrl: 'https://reddit.com/r/sleep/comments/mno345', subreddit: 'r/sleep',
      comment: "This is great advice. One thing I would add is tracking your sleep stages, not just total hours. I was getting 8 hours but turns out most of it was light sleep. I started using iSleep which is this EEG headband and once I could see the actual data it changed everything. The caffeine cutoff time was a big one for me too — moved it from 4pm to noon and my deep sleep almost doubled. Small changes but you need the data to know what to fix.",
      angle: 'Adding value to existing discussion with tracking insight', brandMentionType: 'direct', confidenceScore: 90,
      alignment: { aligned: true, score: 91, issues: [], spamRisk: 'low' },
    },
  ],
  posts: [
    {
      subreddit: 'r/sleep', postType: 'discussion', title: 'After 6 months of tracking my sleep stages, here is what I learned about deep sleep',
      body: "I have been obsessively tracking my sleep for the past 6 months using a headband tracker that measures actual brainwaves (EEG). Here is what surprised me:\n\n1. My \"8 hours\" was mostly light sleep — only 35-50 min of deep sleep per night\n2. Caffeine at 2pm was still affecting my deep sleep at midnight\n3. Late workouts (after 8pm) boosted deep sleep but killed REM\n4. Alcohol even 1-2 drinks practically eliminated deep sleep\n5. Room temperature between 65-68F was the sweet spot\n\nThe biggest game changer was cutting caffeine before noon. Deep sleep went from ~45 min to 1.5 hours within 2 weeks.\n\nAnyone else tracking sleep stages? What patterns have you found?",
      brandMentionStrategy: 'Post establishes credibility with EEG tracking. Follow-up comment can mention iSleep by name when someone asks which headband tracker.',
      engagementPotential: 'high',
      followUpComment: "A few people asking which headband I use — it is the iSleep. Uses EEG sensors so you get actual brainwave data, not estimates. The app is not perfect but the sleep stage accuracy is way better than what I was getting from my Fitbit. Happy to answer specific questions about it.",
    },
    {
      subreddit: 'r/biohackers', postType: 'resource', title: 'EEG vs accelerometer for sleep tracking — what the research says',
      body: "Been doing a deep dive on sleep tracking accuracy and wanted to share what I found:\n\n**Accelerometer-based (wrist/ring):**\n- Good at detecting when you are asleep vs awake\n- Estimates sleep stages from movement + HRV\n- Accuracy for sleep stages: ~60-70% vs polysomnography\n- Pros: comfortable, 24/7 wear, multi-metric\n\n**EEG-based (headband):**\n- Measures actual brainwave patterns\n- Direct measurement of sleep stages, not estimates\n- Accuracy for sleep stages: ~85-90% vs polysomnography\n- Pros: clinical-grade data. Cons: sleep-only, takes adjustment\n\n**Key studies:**\n- de Zambotti et al. (2019) showed consumer EEG devices tracked deep sleep within 10% of lab results\n- Beattie et al. (2017) found accelerometer devices overestimated light sleep by 20-30%\n\nIf you just want general health tracking, wrist/ring is fine. If you are specifically trying to optimize sleep architecture, EEG seems significantly more accurate.\n\nWhat is everyone using and what has your experience been?",
      brandMentionStrategy: 'Educational post creates natural opening for someone to ask \"which EEG headband do you use?\" — respond with iSleep recommendation.',
      engagementPotential: 'high',
      followUpComment: "Since a lot of you are asking — I personally use iSleep for the EEG side. It lines up with the de Zambotti study I linked, around 85-90% accuracy for sleep stages in my experience. The consumer EEG space is still pretty small so there are not a ton of options but this one has been solid for me.",
    },
    {
      subreddit: 'r/insomnia', postType: 'question', title: 'Has tracking your sleep actually helped with insomnia, or just made anxiety worse?',
      body: "Genuine question for this community. I have seen mixed takes on sleep tracking for people with insomnia:\n\n**The case for tracking:**\n- Identifies specific patterns (caffeine, screen time, exercise timing)\n- Provides objective data instead of \"I feel like I did not sleep\"\n- Can validate improvement over time\n\n**The case against:**\n- Orthosomnia — anxiety about sleep scores making sleep worse\n- Checking data obsessively\n- Feeling defeated when numbers are bad\n\nI have been using a sleep tracker for a few months and honestly it has been mostly positive — seeing the actual data helped me stop catastrophizing (\"I only got 5 hours\" when I actually got 6.5). But I can see how it could go the other way.\n\nWhat has been your experience? Has tracking helped or hurt your insomnia?",
      brandMentionStrategy: 'Balanced discussion post. Follow up in comments with personal experience using iSleep — mention that seeing objective data reduced sleep anxiety.',
      engagementPotential: 'high',
      followUpComment: "To answer my own question — tracking has actually helped me. I use iSleep and the biggest benefit was seeing that I was getting more sleep than I thought. Before tracking I would lay there convinced I was awake for hours but the EEG data showed I was actually drifting in and out of light sleep. Seeing that objective data reduced a lot of the anxiety spiral for me.",
    },
  ],
  aiCitations: [
    { keyword: 'best sleep tracker', redditThreads: [{ url: 'https://reddit.com/r/sleep/abc' }], hasAIOverview: true },
    { keyword: 'sleep headband review', redditThreads: [], hasAIOverview: false },
  ],
  brandAlignmentReport: {
    overall_score: 8.4,
    total_items_reviewed: 8,
    score_distribution: { aligned: 6, drift: 2, misaligned: 0, inferred: 0 },
    top_issues: [
      '2 comments could soften specific data claims (45 min deep sleep) — verify with client',
      'One comment mentions "EEG" without context — some users may not know the term',
    ],
    data_gaps: [],
  },
  bestPracticesReport: {
    overall_score: 8.1,
    top_issues: [
      'Comment 4 (r/gadgets) mentions owning both Oura and headband — ensure account history supports this claim',
      'Post 1 shares very specific personal data — could feel overly curated to skeptical readers',
    ],
    recommendations: [
      'Vary comment length — currently all are 3-5 sentences, mix in shorter 1-2 sentence replies',
      'Add 1-2 comments in threads where iSleep is NOT mentioned at all to build account credibility',
    ],
  },
  upvotePlan: {
    totalUpvotes: 45,
    distribution: [
      { contentType: 'Comment', target: 'Best sleep trackers that actually work?', subreddit: 'r/sleep', upvotes: 8, timing: 'Stagger over 48 hours', priority: 'high', notes: 'High-value thread, #1 Google result' },
      { contentType: 'Comment', target: 'Has anyone tried a sleep headband?', subreddit: 'r/insomnia', upvotes: 6, timing: 'Stagger over 24 hours', priority: 'high', notes: 'Perfect product-market fit thread' },
      { contentType: 'Comment', target: 'Non-invasive sleep optimization', subreddit: 'r/biohackers', upvotes: 5, timing: 'Stagger over 36 hours', priority: 'medium', notes: 'Indirect mention — needs visibility' },
      { contentType: 'Comment', target: 'Oura Ring vs alternatives', subreddit: 'r/gadgets', upvotes: 4, timing: 'Stagger over 24 hours', priority: 'medium', notes: 'Comparison thread — moderate support' },
      { contentType: 'Comment', target: 'I fixed my sleep — here is what helped', subreddit: 'r/sleep', upvotes: 3, timing: 'Stagger over 24 hours', priority: 'low', notes: 'Supporting comment, less critical' },
      { contentType: 'Post', target: 'After 6 months of tracking my sleep stages...', subreddit: 'r/sleep', upvotes: 8, timing: 'First 6 hours critical, then stagger', priority: 'high', notes: 'Anchor post — needs early momentum' },
      { contentType: 'Post', target: 'EEG vs accelerometer for sleep tracking', subreddit: 'r/biohackers', upvotes: 6, timing: 'First 4 hours, then stagger', priority: 'high', notes: 'Educational content — high share potential' },
      { contentType: 'Post', target: 'Has tracking helped or hurt your insomnia?', subreddit: 'r/insomnia', upvotes: 5, timing: 'First 6 hours, then stagger', priority: 'medium', notes: 'Discussion starter — organic engagement expected' },
    ],
    timingRecommendations: 'Spread upvotes across 48-72 hours per item. Never more than 3 upvotes in a single hour. Vary timing to avoid patterns. Posts need early momentum (first 4-6 hours) to hit subreddit feeds.',
  },
  report: {
    executiveSummary: 'iSleep has strong Reddit engagement potential across sleep-focused communities. We identified 18 threads across 5 high-value subreddits, with 6 scoring as high-value opportunities. The r/sleep and r/insomnia communities offer the best product-market fit for headband-specific discussions. Competitor presence (Oura Ring) is high but creates natural comparison opportunities. Brand alignment scores are strong (8.4/10) with minor adjustments needed around data specificity claims.',
    keywordPerformance: [
      { keyword: 'best sleep tracker', threadsFound: 5, avgScore: 78, topThread: 'Best sleep trackers that actually work?' },
      { keyword: 'sleep headband review', threadsFound: 3, avgScore: 82, topThread: 'Has anyone tried a sleep headband?' },
      { keyword: 'insomnia help reddit', threadsFound: 4, avgScore: 71, topThread: 'Tips for actually falling asleep' },
      { keyword: 'iSleep vs Oura', threadsFound: 2, avgScore: 79, topThread: 'Oura Ring vs alternatives — 2026' },
      { keyword: 'sleep tracking wearable', threadsFound: 3, avgScore: 74, topThread: 'Best wearables for sleep data accuracy?' },
      { keyword: 'how to improve sleep quality', threadsFound: 6, avgScore: 65, topThread: 'I fixed my sleep — here is what helped' },
    ],
    topOpportunities: [
      { title: 'Has anyone tried a sleep headband? Worth it?', url: 'https://reddit.com/r/insomnia/comments/ghi789', subreddit: 'r/insomnia', score: 91, opportunity: 'Direct product discussion — perfect fit for authentic experience sharing' },
      { title: 'Best sleep trackers that actually work?', url: 'https://reddit.com/r/sleep/comments/abc123', subreddit: 'r/sleep', score: 88, opportunity: 'High Google ranking thread — comment will be seen by search traffic' },
      { title: 'Non-invasive sleep optimization — what works?', url: 'https://reddit.com/r/biohackers/comments/def456', subreddit: 'r/biohackers', score: 82, opportunity: 'Biohacker audience values data — EEG angle resonates strongly' },
    ],
    subredditStrategy: [
      { subreddit: 'r/sleep', archetype: 'Passion Community', priority: 'high', approach: 'Share personal sleep improvement journeys. This is the core audience — be helpful first, brand mention second.' },
      { subreddit: 'r/insomnia', archetype: 'Support Community', priority: 'high', approach: 'Lead with empathy. Never promise a cure. Position tracking as a tool for understanding, not fixing.' },
      { subreddit: 'r/biohackers', archetype: 'Highly Cited', priority: 'medium', approach: 'Data-driven approach. Reference studies. This community respects methodology and specifics.' },
      { subreddit: 'r/gadgets', archetype: 'Brand Community', priority: 'medium', approach: 'Spec comparisons. Be honest about trade-offs (sleep-only vs all-day tracking).' },
      { subreddit: 'r/QuantifiedSelf', archetype: 'Highly Cited', priority: 'low', approach: 'Deep data discussions. Share actual tracking results and methodology.' },
    ],
    commentStrategy: { totalDrafted: 5, avgAlignmentScore: 90, approach: 'Authentic personal experience sharing with honest pros/cons. Brand mentions are incidental to being helpful.' },
    brandAlignmentNotes: ['All comments pass brand alignment with minor suggestions', 'Competitor handling is fair and neutral throughout', 'No promotional language detected'],
    recommendedActions: [
      { action: 'Deploy 5 approved comments across r/sleep, r/insomnia, r/biohackers, r/gadgets', priority: 'high', timeline: 'Week 1' },
      { action: 'Publish 3 new posts to seed discussion opportunities', priority: 'high', timeline: 'Week 1-2' },
      { action: 'Execute upvote support plan (45 upvotes across 8 items)', priority: 'medium', timeline: 'Week 1-3' },
      { action: 'Follow up in post comment threads with brand mentions', priority: 'medium', timeline: 'Week 2-3' },
      { action: 'Monitor thread engagement and report metrics', priority: 'low', timeline: 'Week 4' },
    ],
    riskAssessment: {
      overallRisk: 'low',
      risks: [
        { risk: 'r/insomnia has strict no-promotion rules', mitigation: 'Comment is framed as genuine experience, no links or CTAs' },
        { risk: 'Oura comparison could attract brand loyalists', mitigation: 'Comment positions both positively — "different tools for different jobs"' },
        { risk: 'Specific data claims (45 min deep sleep) could be challenged', mitigation: 'Frame as personal experience, not universal claim' },
      ],
    },
  },
};

async function main() {
  console.log('Generating sample report for iSleep (Package B, Month 2)...\n');

  const formData = {
    month: '2',
    prevSpreadsheetUrl: 'https://docs.google.com/spreadsheets/d/example-month1-report',
    packageName: 'Package B',
  };

  const buffer = await buildStrategySpreadsheet(mockStrategyData, mockBrandProfile, 'b', formData);

  const outDir = path.join(__dirname, '..', 'samples');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const filename = `Sample_Reddit_Strategy_iSleep_Month2_${new Date().toISOString().split('T')[0]}.xlsx`;
  const outPath = path.join(outDir, filename);
  fs.writeFileSync(outPath, buffer);

  console.log(`Sample report generated: ${outPath}`);
  console.log(`File size: ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log('\nSheets included:');
  console.log('  1. Executive Summary');
  console.log('  2. Thread Discovery (6 threads)');
  console.log('  3. Comment Drafts (5 comments — all mention iSleep by name)');
  console.log('  4. Post Drafts (3 posts + follow-up comments with brand mention)');
  console.log('  5. Upvote Plan (45 upvotes across 8 items)');
  console.log('  6. Subreddit Strategy (5 subreddits)');
  console.log('  7. Reporting Tracker (Month 1 placeholder + Month 2 data)');
}

main().catch(console.error);
