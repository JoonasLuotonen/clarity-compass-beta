// /api/analyze.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ---- config
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini'; // small, cheap, vision not required here

// Basic jargon list for clarity check (fallback heuristics)
const JARGON = [
  'synergy','leverage','cutting-edge','turnkey','mission-critical','scalable',
  'best-in-class','bleeding edge','paradigm','holistic','world-class',
  'ecosystem','framework','innovative solutions'
];
const CTA_REGEX = /(book|contact|get\s?a\s?quote|get started|start now|try it|buy now|add to cart|schedule|demo)/i;

// ---- HTTP handler
export default async function handler(req, res) {
  try {
    const { url, context = 'consultancy', scopeLabel = '', clientMetrics = null } = await readJson(req);

    // 1) Fetch URL HTML + extract readable text (optional if URL provided)
    let html = '', text = '';
    if (url && /^https?:\/\//i.test(url)) {
      const r = await fetch(url, { headers: { 'User-Agent': 'ClarityCompass/0.2 (+https://example.com)' } });
      html = await r.text();
      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      // Trim extremely long pages to control token costs:
      text = bodyText.slice(0, 12000); // ~12k chars is plenty for a homepage
    }

    // 2) Build fallback heuristic scores (0..1) so we always return something
    const h = {
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

    // 3) If API key present and we have some text, ask GPT for proper scores + reasons
    let ai = null;
    if (process.env.OPENAI_API_KEY && (text || html)) {
      ai = await askOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        context,
        scopeLabel,
        text,
        // pass starting points so the model has a hint (and stays cheap)
        seed: {
          user_offer: h.user_offer,
          user_navigation: h.user_navigation,
          user_action: h.user_action,
          story_purpose: h.story_purpose
        }
      });
    }

    // 4) Merge AI (1..5) with heuristics (0..1 → 1..5) and build reasons
    const to5 = v => clampInt(Math.round(v * 4 + 1), 1, 5);
    const scores = {
      user: {
        offer: ai?.scores?.user?.offer ?? to5(h.user_offer),
        navigation: ai?.scores?.user?.navigation ?? to5(h.user_navigation),
        action: ai?.scores?.user?.action ?? to5(h.user_action)
      },
      visual: {
        consistency: ai?.scores?.visual?.consistency ?? to5(h.visual_consistency),
        tone: ai?.scores?.visual?.tone ?? to5(h.visual_tone),
        environment: ai?.scores?.visual?.environment ?? to5(h.visual_environment)
      },
      story: {
        purpose: ai?.scores?.story?.purpose ?? to5(h.story_purpose),
        emotion: ai?.scores?.story?.emotion ?? to5(h.story_emotion),
        identity: ai?.scores?.story?.identity ?? to5(h.story_identity)
      }
    };

    const reasons = normalizeReasons(ai?.reasons);

    // 5) Quick wins from weakest two lenses
    const quickWins = makeQuickWins(scores, scopeLabel);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify({ scores, reasons, quickWins }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ error: e.message || 'Analysis failed' }));
  }
}

// ---- Utilities

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  return body;
}

function average(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function clampInt(v, min, max){ return Math.max(min, Math.min(max, v)); }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

// Heuristic fallbacks (very rough but free)
function scoreOfferClarity(text){
  if (!text) return 0.4;
  const sentences = text.split(/[.!?]/).map(s=>s.trim()).filter(Boolean);
  const short = sentences.filter(s=>s.split(' ').length <= 12).length;
  const jargonCount = JARGON.reduce((n,j)=> n + (text.toLowerCase().includes(j) ? 1 : 0), 0);
  let score = Math.min(1, short / 10);
  score -= Math.min(0.5, jargonCount * 0.05);
  return clamp01(score);
}
function scoreNavClarity(html){
  if (!html) return 0.4;
  const lower = html.toLowerCase();
  const hasMenu = lower.includes('<nav') || lower.includes('menu');
  const hasKeyLinks = ['services','pricing','about','contact','work','cases'].filter(k=>lower.includes(k)).length;
  let score = 0.2 + (hasMenu?0.3:0) + Math.min(0.5, hasKeyLinks * 0.1);
  return clamp01(score);
}
function scoreActionClarity(html){
  if (!html) return 0.3;
  const lower = html.toLowerCase();
  const ctaHits = (lower.match(CTA_REGEX) || []).length;
  const btnHits = (lower.match(/<button|class=\\"btn|class='btn/g) || []).length;
  let score = 0.2 + Math.min(0.5, ctaHits * 0.2) + Math.min(0.3, btnHits * 0.05);
  return clamp01(score);
}
function scoreStoryPurpose(text){
  if (!text) return 0.4;
  const hasWhy  = /(why|mission|we exist|we believe|our story|purpose)/i.test(text);
  const hasWho  = /(we|our team|founded|handmade|crafted|designed)/i.test(text);
  let score = 0.3 + (hasWhy?0.3:0) + (hasWho?0.2:0);
  return clamp01(score);
}

// Make quick wins from weakest two lenses
function makeQuickWins(scores, scope){
  const lensAvg = {
    user:   average(Object.values(scores.user)),
    visual: average(Object.values(scores.visual)),
    story:  average(Object.values(scores.story))
  };
  const ordered = Object.entries(lensAvg).sort((a,b)=>a[1]-b[1]).map(([k])=>k).slice(0,2);
  const wins = [];
  for (const lens of ordered) {
    if (lens==='user') wins.push({
      title:`Clarify next steps on ${scope || 'this page'}`,
      tip:'Add a single primary CTA above the fold and repeat it near the footer. Use a clear verb (Book a call, Get a quote).'
    });
    if (lens==='visual') wins.push({
      title:`Tighten visual consistency on ${scope || 'this page'}`,
      tip:'Limit colors to 1–2 accents, unify button styles, and increase spacing between sections to reduce noise.'
    });
    if (lens==='story') wins.push({
      title:`State the value in plain words on ${scope || 'this page'}`,
      tip:'Replace jargon with a one-sentence promise and add one proof point (metric, client name, or outcome).'
    });
  }
  return wins;
}

// Normalize reasons object to fixed keys with short text
function normalizeReasons(r) {
  const def = (t='') => (typeof t === 'string' ? t.slice(0, 220) : '');
  const out = {
    user:   { offer:'', navigation:'', action:'' },
    visual: { consistency:'', tone:'', environment:'' },
    story:  { purpose:'', emotion:'', identity:'' }
  };
  if (!r) return out;
  if (r.user)   { out.user.offer = def(r.user.offer); out.user.navigation = def(r.user.navigation); out.user.action = def(r.user.action); }
  if (r.visual) { out.visual.consistency = def(r.visual.consistency); out.visual.tone = def(r.visual.tone); out.visual.environment = def(r.visual.environment); }
  if (r.story)  { out.story.purpose = def(r.story.purpose); out.story.emotion = def(r.story.emotion); out.story.identity = def(r.story.identity); }
  return out;
}

// ---- OpenAI call
async function askOpenAI({ apiKey, context, scopeLabel, text, seed }) {
  const questions = getQuestions(context, scopeLabel || 'this page');

  const sys = 'You are a strict evaluator. Return only valid JSON. Keep reasons short (<= 30 words). Scores are integers 1–5.';
  const usr = `
Evaluate the following page TEXT for clarity. Score each question 1..5 and give a short reason.

QUESTIONS:
${questions.map((q,i)=>`${i+1}. ${q}`).join('\n')}

If unsure, make a best effort using the text.

Return JSON with shape:
{
  "scores": {
    "user":    {"offer":1-5,"navigation":1-5,"action":1-5},
    "visual":  {"consistency":1-5,"tone":1-5,"environment":1-5},
    "story":   {"purpose":1-5,"emotion":1-5,"identity":1-5}
  },
  "reasons": {
    "user":    {"offer": "...", "navigation": "...", "action": "..."},
    "visual":  {"consistency": "...", "tone": "...", "environment": "..."},
    "story":   {"purpose": "...", "emotion": "...", "identity": "..."}
  }
}

STARTING HINTS (optional, may adjust):
${JSON.stringify(seed || {}, null, 2)}

TEXT (trimmed):
${text}
  `.trim();

  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role:'system', content: sys },
        { role:'user',   content: usr }
      ]
    })
  });

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content || '{}';

  // Try parse JSON from the model
  try {
    const parsed = JSON.parse(content);
    // sanitize to ints 1..5
    const coerce = v => clampInt(parseInt(v, 10), 1, 5);
    const s = parsed.scores || {};
    const scores = {
      user:    { offer:coerce(s?.user?.offer), navigation:coerce(s?.user?.navigation), action:coerce(s?.user?.action) },
      visual:  { consistency:coerce(s?.visual?.consistency), tone:coerce(s?.visual?.tone), environment:coerce(s?.visual?.environment) },
      story:   { purpose:coerce(s?.story?.purpose), emotion:coerce(s?.story?.emotion), identity:coerce(s?.story?.identity) }
    };
    return { scores, reasons: parsed.reasons || null };
  } catch {
    return null; // fall back to heuristics
  }
}

// Map context to your 9 clarity questions (keeps the AI aligned with the UI)
function getQuestions(context, scope) {
  const C = {
    consultancy: [
      `How instantly can someone tell what your company offers when they land on ${scope}?`,
      `How easy is it for a potential client to find relevant information or services on ${scope}?`,
      `How clearly does ${scope} guide a potential client toward contacting you or starting a project?`,
      `How consistent does the design of ${scope} feel—does everything look like it belongs together?`,
      `How well does the visual style of ${scope} communicate the level of quality and professionalism you deliver?`,
      `How comfortable and confident does ${scope} feel—calm and credible vs. cluttered or chaotic?`,
      `How clearly does ${scope} explain your value in plain, human language?`,
      `How convincingly does ${scope} show the results of your work, not just what you delivered?`,
      `How much character and point of view comes through on ${scope}, instead of a neutral corporate tone?`
    ],
    saas: [
      `How quickly can a new user see what they can achieve on ${scope}?`,
      `How easy is it to spot the main action on ${scope} without searching?`,
      `How naturally do messages on ${scope} read—human and clear vs. robotic or coded?`,
      `How calm and focused does ${scope} feel on first view?`,
      `How consistent are icons, buttons, and patterns across ${scope}?`,
      `How credible does the visual tone of ${scope} feel for your product’s maturity?`,
      `How quickly could a visitor explain in one sentence what ${scope} does?`,
      `How well does ${scope} deliver on the promise from your marketing?`,
      `How distinct does your product voice feel on ${scope}?`
    ],
    outdoor: [
      `How quickly can someone tell what kind of product or activity ${scope} is about?`,
      `How clearly do the visuals on ${scope} show how the product is used in real life?`,
      `How clearly does ${scope} communicate why the product exists—the problem it solves or the benefit it gives?`,
      `How well do the visuals on ${scope} express the intended feeling—rugged, light, premium, or technical?`,
      `How consistent are colors, typography, and imagery across ${scope}?`,
      `How naturally does ${scope} express the place your brand belongs—on the mountain, in the city, or out on the trail?`,
      `How clearly does ${scope} express what your brand stands for—the bigger reason you exist beyond the products?`,
      `How strongly does ${scope} make people feel something—like inspiration, trust, or excitement—beyond recognition?`,
      `How recognizable would your brand be if the logo were hidden on ${scope}?`
    ]
  };
  return C[context] || C.consultancy;
}
