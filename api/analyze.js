import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// Basic jargon list for clarity check (extend as needed)
const JARGON = [
  'synergy','leverage','cutting-edge','turnkey','mission-critical','scalable','best-in-class','bleeding edge','paradigm','holistic','world-class','ecosystem','framework','innovative solutions'
];

// CTA patterns to detect action clarity
const CTA_REGEX = /(book|contact|get\s?a\s?quote|get started|start now|try it|buy now|add to cart|schedule|demo)/i;

export default async function handler(req, res) {
  try {
    const { url, context = 'consultancy', scopeLabel = '', clientMetrics } = await parseBody(req);
    let html = ''; let text = '';

    if (url && /^https?:\/\//i.test(url)) {
      const r = await fetch(url, { headers: { 'User-Agent': 'ClarityCompassBot/0.1 (+https://example.com)' } });
      html = await r.text();
      const $ = cheerio.load(html);
      // strip scripts/styles
      $('script, style, noscript').remove();
      text = $('body').text().replace(/\s+/g,' ').trim();
    }

    // Heuristic scores default [0..1]
    const heuristics = {
      user_offer: scoreOfferClarity(text),
      user_navigation: scoreNavClarity(html),
      user_action: scoreActionClarity(html),
      visual_consistency: clientMetrics?.visualConsistency ?? 0.5,
      visual_tone: clientMetrics?.visualTone ?? 0.5,
      visual_environment: clientMetrics?.visualEnvironment ?? 0.5,
      story_purpose: scoreStoryPurpose(text),
      story_emotion: clientMetrics?.storyEmotion ?? 0.5,
      story_identity: clientMetrics?.storyIdentity ?? 0.5
    };

    // Optional: LLM refinement (only if key present)
    const llmKey = process.env.OPENAI_API_KEY;
    if (llmKey && text) {
      const llmScores = await llmRefine(llmKey, { text, context, scopeLabel, heuristics });
      Object.assign(heuristics, llmScores);
    }

    // Map to 1..5 scale
    const to5 = v => Math.round(v * 4 + 1);
    const scores = {
      user: {
        offer: to5(heuristics.user_offer),
        navigation: to5(heuristics.user_navigation),
        action: to5(heuristics.user_action)
      },
      visual: {
        consistency: to5(heuristics.visual_consistency),
        tone: to5(heuristics.visual_tone),
        environment: to5(heuristics.visual_environment)
      },
      story: {
        purpose: to5(heuristics.story_purpose),
        emotion: to5(heuristics.story_emotion),
        identity: to5(heuristics.story_identity)
      }
    };

    // Compose quick wins from weakest two lenses
    const lensAverages = {
      user: average(Object.values(scores.user)),
      visual: average(Object.values(scores.visual)),
      story: average(Object.values(scores.story))
    };
    const sorted = Object.entries(lensAverages).sort((a,b)=>a[1]-b[1]);

    const quickWins = makeQuickWins(sorted.map(([k])=>k), context, scopeLabel);

    res.setHeader('Content-Type','application/json');
    res.status(200).send(JSON.stringify({ scores, quickWins }));
  } catch (e) {
    res.status(500).send(JSON.stringify({ error: e.message }));
  }
}

async function parseBody(req){
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  return body;
}

function average(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }

// Heuristic functions (very rough first pass)
function scoreOfferClarity(text){
  if(!text) return 0.4;
  // reward presence of short headline-like sentences
  const sentences = text.split(/[.!?]/).map(s=>s.trim()).filter(Boolean);
  const short = sentences.filter(s=>s.split(' ').length<=12).length;
  const jargonCount = JARGON.reduce((n,j)=> n + (text.toLowerCase().includes(j)?1:0), 0);
  let score = Math.min(1, short / 10);
  score -= Math.min(0.5, jargonCount * 0.05);
  return clamp01(score);
}

function scoreNavClarity(html){
  if(!html) return 0.4;
  const lower = html.toLowerCase();
  const hasMenu = lower.includes('<nav') || lower.includes('menu');
  const hasKeyLinks = ['services','pricing','about','contact','work','cases'].filter(k=>lower.includes(k)).length;
  let score = 0.2 + (hasMenu?0.3:0) + Math.min(0.5, hasKeyLinks*0.1);
  return clamp01(score);
}

function scoreActionClarity(html){
  if(!html) return 0.3;
  const lower = html.toLowerCase();
  const ctaHits = (lower.match(CTA_REGEX) || []).length;
  const btnHits = (lower.match(/<button|class=\"btn|class='btn/g) || []).length;
  let score = 0.2 + Math.min(0.5, ctaHits*0.2) + Math.min(0.3, btnHits*0.05);
  return clamp01(score);
}

function scoreStoryPurpose(text){
  if(!text) return 0.4;
  const hasWhy = /(why|mission|we exist|we believe|our story|purpose)/i.test(text);
  const hasWho = /(we|our team|founded|handmade|crafted|designed)/i.test(text);
  let score = 0.3 + (hasWhy?0.3:0) + (hasWho?0.2:0);
  return clamp01(score);
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

async function llmRefine(key, { text, context, scopeLabel, heuristics }){
  // Optional refinement stub; keep token usage small.
  const prompt = `You are evaluating ${context} content for \"${scopeLabel}\". Based on the TEXT below, adjust 0..1 scores for: user_offer, user_navigation, user_action, story_purpose. Reply ONLY with a JSON object with those keys, values between 0 and 1.\n\nTEXT:\n${text}\n\nHeuristic starting scores:\n${JSON.stringify(heuristics)}`;

  try{
    const r = await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
      body: JSON.stringify({
        model:'gpt-4o-mini',
        messages:[{role:'system', content:'You are a careful evaluator that returns strict JSON.'},{role:'user', content: prompt}],
        temperature:0
      })
    });
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    // sanitize
    const clean = {};
    ['user_offer','user_navigation','user_action','story_purpose'].forEach(k=>{
      let v = Number(parsed[k]);
      if(Number.isFinite(v)) clean[k] = clamp01(v);
    });
    return clean;
  }catch(e){
    return {};
  }
}

function makeQuickWins(orderedLenses, context, scope){
  const wins = [];
  for(const lens of orderedLenses.slice(0,2)){
    if(lens==='user') wins.push({
      title: `Clarify next steps on ${scope || 'this page'}`,
      tip: 'Add a single primary CTA above the fold and repeat it near the footer. Use a clear verb (Book a call, Get a quote).'
    });
    if(lens==='visual') wins.push({
      title: `Tighten visual consistency on ${scope || 'this page'}`,
      tip: 'Limit colors to 1–2 accents, unify button styles, and increase spacing between sections to reduce noise.'
    });
    if(lens==='story') wins.push({
      title: `State the value in plain words on ${scope || 'this page'}`,
      tip: 'Replace jargon with a one-sentence promise and add one proof point (metric, client name, or outcome).'
    });
  }
  return wins;
}
