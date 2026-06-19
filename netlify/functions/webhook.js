// ================================================
// WhatsApp Webhook Handler
// GET  → Meta verification challenge
// POST → Incoming messages from customers
// ================================================

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Nyaya Saathi legal aid gateway (Beta3 whatsapp-service.js) ────────────
const LEGAL_AID_GATEWAY = (process.env.LEGAL_AID_GATEWAY_URL || '').replace(/\/$/, '');
const LEGAL_AID_APP_URL = (process.env.LEGAL_AID_APP_URL || 'https://www.legalaidai.in').replace(/\/$/, '');

async function callGateway(action, params) {
  if (!LEGAL_AID_GATEWAY) throw new Error('LEGAL_AID_GATEWAY_URL not set');
  const url = new URL(`${LEGAL_AID_GATEWAY}/.netlify/functions/whatsapp-service`);
  const payload = JSON.stringify({ action, ...params });
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-wa-secret': process.env.WHATSAPP_SERVICE_SECRET || '' },
    }, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ success: false }); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Keywords that signal the AI should auto-reply ──────────────────────────
const SIMPLE_PATTERNS = [
  /\b(hello|hi|hey|helo|namaste|namaskar)\b/i,
  /\b(price|cost|rate|how much|kitna|rate)\b/i,
  /\b(hours?|timing|open|close|kab)\b/i,
  /\b(deliver|shipping|dispatch|track|order)\b/i,
  /\b(size|available|stock|colour|color|rang)\b/i,
  /\b(subscription|plan|monthly|yearly|annual|subscribe)\b/i,
  /\b(feature|how does|what is|explain|kya hai)\b/i,
  /\b(payment|pay|upi|card|bank)\b/i,
  /\b(thank|thanks|dhanyawad|shukriya)\b/i,
  /\b(return policy|refund policy|exchange policy)\b/i,
];

// Keywords that should always go to a human
const COMPLEX_PATTERNS = [
  /\b(complaint|complain|refund|return|exchange|damaged|wrong|issue|problem)\b/i,
  /\b(legal advice|my case|court|lawyer|vakeel|FIR|police)\b/i,
  /\b(cancel|cancellation|delete account|close account)\b/i,
  /\b(fraud|scam|cheated|deceived)\b/i,
];

function needsHuman(text) {
  if (!text) return false;
  return COMPLEX_PATTERNS.some(p => p.test(text));
}

function isSimpleQuery(text) {
  if (!text) return false;
  if (needsHuman(text)) return false;
  return SIMPLE_PATTERNS.some(p => p.test(text));
}

// ── Send a WhatsApp text message via the Cloud API ─────────────────────────
async function sendWhatsAppMessage(accessToken, phoneNumberId, toPhone, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhone,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    }
  );
  const data = await res.json();
  return data;
}

// ── Resolve advocate name from the advocates table by phone ───────────────
async function resolveAdvocateName(phone) {
  const { data: adv } = await supabase
    .from('advocates')
    .select('full_name')
    .eq('phone_e164', '+' + phone)
    .single();
  return adv?.full_name || null;
}

// ── Find or create contact ─────────────────────────────────────────────────
async function upsertContact(phone, businessId) {
  const { data: existing } = await supabase
    .from('contacts')
    .select('*')
    .eq('phone', phone)
    .eq('business_id', businessId)
    .single();

  if (existing) {
    const updatePayload = { last_seen: new Date().toISOString() };
    // Self-heal: if name is still the raw phone number, resolve from advocates
    if (existing.name === phone) {
      const advName = await resolveAdvocateName(phone);
      if (advName) {
        updatePayload.name = advName;
        existing.name = advName;
      }
    }
    await supabase.from('contacts').update(updatePayload).eq('id', existing.id);
    return existing;
  }

  // New contact — look up advocate name before falling back to phone
  const advName = await resolveAdvocateName(phone);
  const { data: created } = await supabase
    .from('contacts')
    .insert({ phone, name: advName || phone, business_id: businessId, last_seen: new Date().toISOString() })
    .select()
    .single();
  return created;
}

// ── Find or create open conversation ──────────────────────────────────────
async function upsertConversation(contactId, businessId) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('business_id', businessId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) return existing;

  const { data: created } = await supabase
    .from('conversations')
    .insert({ contact_id: contactId, business_id: businessId, status: 'open', ai_enabled: true })
    .select()
    .single();
  return created;
}

// ── Get last N messages for Claude context ────────────────────────────────
async function getConversationHistory(conversationId, limit = 12) {
  const { data } = await supabase
    .from('messages')
    .select('content, sender_type, direction')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['customer', 'ai', 'agent'])
    .order('timestamp', { ascending: true })
    .limit(limit);
  return data || [];
}

// ── Legal Aid: menus ──────────────────────────────────────────────────────
function languagePrompt() {
  return '🌐 *Choose your language / भाषा चुनें / भाषा निवडा*\n\n1️⃣ English\n2️⃣ हिंदी (Hindi)\n3️⃣ मराठी (Marathi)\n\nReply 1, 2, or 3.';
}

function buildMenu(lang, name, userType) {
  const greet = { en: `Hello ${name}! 👋`, hi: `नमस्ते ${name}! 👋`, mr: `नमस्कार ${name}! 👋` }[lang] || `Hello ${name}! 👋`;
  if (userType === 'advocate') {
    return { en: `${greet}\n\n⚖️ *Nyaya Saathi — Advocate Assistant*\n\nHow can I help you today?\n\n1️⃣ Legal Research\n2️⃣ Draft Document\n3️⃣ eCourts Case Status\n4️⃣ My Cases (App)\n5️⃣ Calendar (App)\n6️⃣ Help\n\nReply with a number.`,
             hi: `${greet}\n\n⚖️ *न्याय साथी — अधिवक्ता सहायक*\n\nआज मैं आपकी कैसे मदद करूँ?\n\n1️⃣ कानूनी शोध\n2️⃣ दस्तावेज़ ड्राफ्ट\n3️⃣ eCourts केस स्थिति\n4️⃣ मेरे केस (ऐप)\n5️⃣ कैलेंडर (ऐप)\n6️⃣ सहायता\n\nनंबर लिखें।`,
             mr: `${greet}\n\n⚖️ *न्याय साथी — वकील सहाय्यक*\n\nआज मी आपली कशी मदत करू?\n\n1️⃣ कायदेशीर संशोधन\n2️⃣ कागदपत्र मसुदा\n3️⃣ eCourts केस स्थिती\n4️⃣ माझे केस (अ‍ॅप)\n5️⃣ दिनदर्शिका (अ‍ॅप)\n6️⃣ मदत\n\nक्रमांक टाइप करा.` }[lang] || '';
  }
  return { en: `${greet}\n\n⚖️ *Nyaya Saathi — Legal Assistant*\n\nHow can I help you?\n\n1️⃣ Legal Research\n2️⃣ eCourts Case Status\n3️⃣ My Cases (App)\n4️⃣ Help\n\nReply with a number.`,
           hi: `${greet}\n\n⚖️ *न्याय साथी — कानूनी सहायक*\n\nमैं कैसे मदद करूँ?\n\n1️⃣ कानूनी शोध\n2️⃣ eCourts केस स्थिति\n3️⃣ मेरे केस (ऐप)\n4️⃣ सहायता\n\nनंबर लिखें।`,
           mr: `${greet}\n\n⚖️ *न्याय साथी — कायदेशीर सहाय्यक*\n\nमी कशी मदत करू?\n\n1️⃣ कायदेशीर संशोधन\n2️⃣ eCourts केस स्थिती\n3️⃣ माझे केस (अ‍ॅप)\n4️⃣ मदत\n\nक्रमांक टाइप करा.` }[lang] || '';
}

// ── Legal Aid: full session handler ──────────────────────────────────────
async function handleLegalAid(business, _contact, conversation, text, fromPhone, phoneNumberId) {
  const sd       = conversation.session_data || {};
  const state    = sd.state    || 'lang_select';
  const lang     = sd.lang     || 'en';
  const uid      = sd.uid      || null;
  const name     = sd.name     || 'there';
  const userType = sd.user_type || 'citizen';
  const appUrl   = LEGAL_AID_APP_URL + (userType === 'advocate' ? '/advocate' : '/citizen');
  const tLow     = (text || '').trim().toLowerCase();

  async function reply(msg) {
    if (!msg) return;
    await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, msg);
    await supabase.from('messages').insert({
      conversation_id: conversation.id, from_phone: phoneNumberId, to_phone: fromPhone,
      content: msg, direction: 'outbound', sender_type: 'ai', status: 'sent',
      timestamp: new Date().toISOString(),
    });
  }

  async function setSession(patch) {
    await supabase.from('conversations').update({ session_data: { ...sd, ...patch } }).eq('id', conversation.id);
  }

  function loc(key) {
    const MAP = {
      menu_back:   { en: 'Type *menu* to go back to the main menu.', hi: 'मुख्य मेनू के लिए *menu* टाइप करें।', mr: 'मुख्य मेनूसाठी *menu* टाइप करा.' },
      unavailable: { en: '⚠️ Service temporarily unavailable. Please try again.', hi: '⚠️ सेवा अस्थायी रूप से उपलब्ध नहीं है।', mr: '⚠️ सेवा तात्पुरती अनुपलब्ध आहे.' },
    };
    return (MAP[key] || {})[lang] || (MAP[key] || {}).en || '';
  }

  // "menu" keyword resets from any state
  if (['menu', 'मेनू', 'मेनु'].includes(tLow) && state !== 'lang_select') {
    if (!uid) {
      await setSession({ state: 'unregistered_menu' });
      await reply(`⚖️ *LegalAid AI — Nyaya Saathi*\n\n1️⃣ Ask a Legal Question (free)\n2️⃣ Get Full App Access\n3️⃣ Talk to Our Team\n\nReply with 1, 2, or 3.`);
      return;
    }
    await setSession({ state: 'menu', user_type: userType });
    await reply(buildMenu(lang, name, userType));
    return;
  }

  // ── Verify + language selection ─────────────────────────────────────────
  if (state === 'lang_select') {
    const sub = await callGateway('verify-subscriber', { phone: fromPhone });
    if (!sub.registered) {
      await setSession({ state: 'unregistered_menu' });
      await reply(
        `👋 Welcome to *LegalAid AI — Nyaya Saathi!* ⚖️\n\n` +
        `India's AI-powered legal assistant for advocates and citizens.\n\n` +
        `I can help you with:\n` +
        `• Instant answers on Indian law\n` +
        `• Case law research\n` +
        `• Document drafting\n\n` +
        `*Choose an option:*\n\n` +
        `1️⃣ Ask a Legal Question (free, instant)\n` +
        `2️⃣ Get Full App Access (free beta)\n` +
        `3️⃣ Talk to Our Team\n\n` +
        `Reply with 1, 2, or 3.`
      );
      return;
    }
    if (!sub.subscribed) {
      await reply(`Hi ${sub.name || 'there'}! 👋\n\nYour account doesn't have WhatsApp AI access.\nPlease upgrade your plan at: ${LEGAL_AID_APP_URL}`);
      return;
    }
    await setSession({ uid: sub.uid, name: sub.name || 'there', user_type: sub.user_type || 'citizen', state: 'awaiting_lang' });
    await reply(languagePrompt());
    return;
  }

  // ── Language choice (1/2/3) ─────────────────────────────────────────────
  if (state === 'awaiting_lang') {
    if (['1','2','3'].includes(tLow)) {
      const chosenLang = tLow === '1' ? 'en' : tLow === '2' ? 'hi' : 'mr';
      await setSession({ lang: chosenLang, state: 'menu' });
      await callGateway('set-language', { uid: sd.uid, language: chosenLang });
      await reply(buildMenu(chosenLang, sd.name || 'there', sd.user_type || 'citizen'));
    } else {
      await reply(languagePrompt());
    }
    return;
  }

  // ── Main menu ───────────────────────────────────────────────────────────
  if (state === 'menu') {
    if (userType === 'advocate') {
      if (tLow === '1') {
        await setSession({ state: 'research', user_type: userType });
        await reply({ en: '⚖️ *Legal Research*\n\nType your legal question.\n\n' + loc('menu_back'), hi: '⚖️ *कानूनी शोध*\n\nअपना प्रश्न टाइप करें।\n\n' + loc('menu_back'), mr: '⚖️ *कायदेशीर संशोधन*\n\nआपला प्रश्न टाइप करा.\n\n' + loc('menu_back') }[lang] || '');
      } else if (tLow === '2') {
        await setSession({ state: 'draft', user_type: userType });
        await reply({ en: '📝 *Draft Document*\n\nWhat type? (e.g., bail application, legal notice, vakalatnama)\n\n' + loc('menu_back'), hi: '📝 *दस्तावेज़ ड्राफ्ट*\n\nकिस प्रकार का? (जैसे: bail application, legal notice, vakalatnama)\n\n' + loc('menu_back'), mr: '📝 *कागदपत्र मसुदा*\n\nकोणत्या प्रकारचे? (उदा: bail application, legal notice)\n\n' + loc('menu_back') }[lang] || '');
      } else if (tLow === '3') {
        await setSession({ state: 'ecourts', user_type: userType });
        await reply({ en: '📋 *Case Status (eCourts)*\n\nType your CNR number:\nExample: DLHC010123456789\n\n' + loc('menu_back'), hi: '📋 *केस स्थिति*\n\nCNR नंबर टाइप करें:\nउदाहरण: DLHC010123456789\n\n' + loc('menu_back'), mr: '📋 *केस स्थिती*\n\nCNR नंबर टाइप करा:\nउदा: DLHC010123456789\n\n' + loc('menu_back') }[lang] || '');
      } else if (tLow === '4') {
        await reply({ en: `📁 *My Cases*\n\nManage cases in the app:\n${appUrl}\n\n` + loc('menu_back'), hi: `📁 *मेरे केस*\n\nऐप खोलें:\n${appUrl}\n\n` + loc('menu_back'), mr: `📁 *माझे केस*\n\nअ‍ॅप उघडा:\n${appUrl}\n\n` + loc('menu_back') }[lang] || '');
      } else if (tLow === '5') {
        await reply({ en: `📅 *Calendar*\n\nView court dates:\n${appUrl}\n\n` + loc('menu_back'), hi: `📅 *कैलेंडर*\n\nतिथियाँ देखें:\n${appUrl}\n\n` + loc('menu_back'), mr: `📅 *दिनदर्शिका*\n\nतारखा पाहा:\n${appUrl}\n\n` + loc('menu_back') }[lang] || '');
      } else if (tLow === '6') {
        await reply({ en: `ℹ️ *Help*\n\nEmail: info@legalaidai.in\nWebsite: ${LEGAL_AID_APP_URL}\n\n` + loc('menu_back'), hi: `ℹ️ *सहायता*\n\nईमेल: info@legalaidai.in\n${LEGAL_AID_APP_URL}\n\n` + loc('menu_back'), mr: `ℹ️ *मदत*\n\nईमेल: info@legalaidai.in\n${LEGAL_AID_APP_URL}\n\n` + loc('menu_back') }[lang] || '');
      } else {
        await reply(buildMenu(lang, name, userType));
      }
    } else {
      if (tLow === '1') {
        await setSession({ state: 'research', user_type: userType });
        await reply({ en: '⚖️ *Legal Research*\n\nType your legal question.\n\n' + loc('menu_back'), hi: '⚖️ *कानूनी शोध*\n\nप्रश्न टाइप करें।\n\n' + loc('menu_back'), mr: '⚖️ *कायदेशीर संशोधन*\n\nप्रश्न टाइप करा.\n\n' + loc('menu_back') }[lang] || '');
      } else if (tLow === '2') {
        await setSession({ state: 'ecourts', user_type: userType });
        await reply({ en: '📋 *Case Status (eCourts)*\n\nType your CNR number:\nExample: DLHC010123456789\n\n' + loc('menu_back'), hi: '📋 *केस स्थिति*\n\nCNR नंबर:\nउदाहरण: DLHC010123456789\n\n' + loc('menu_back'), mr: '📋 *केस स्थिती*\n\nCNR क्रमांक:\nउदा: DLHC010123456789\n\n' + loc('menu_back') }[lang] || '');
      } else if (tLow === '3') {
        await reply({ en: `📁 *My Cases*\n\nView cases:\n${appUrl}\n\n` + loc('menu_back'), hi: `📁 *मेरे केस*\n\n${appUrl}\n\n` + loc('menu_back'), mr: `📁 *माझे केस*\n\n${appUrl}\n\n` + loc('menu_back') }[lang] || '');
      } else if (tLow === '4') {
        await reply({ en: `ℹ️ *Help*\n\nEmail: info@legalaidai.in\nWebsite: ${LEGAL_AID_APP_URL}\n\n` + loc('menu_back'), hi: `ℹ️ *सहायता*\n\nईमेल: info@legalaidai.in\n${LEGAL_AID_APP_URL}\n\n` + loc('menu_back'), mr: `ℹ️ *मदत*\n\nईमेल: info@legalaidai.in\n${LEGAL_AID_APP_URL}\n\n` + loc('menu_back') }[lang] || '');
      } else {
        await reply(buildMenu(lang, name, userType));
      }
    }
    return;
  }

  // ── Research flow ───────────────────────────────────────────────────────
  if (state === 'research') {
    await reply({ en: '⚖️ Researching…', hi: '⚖️ शोध कर रहे हैं…', mr: '⚖️ संशोधन करत आहोत…' }[lang] || '⚖️ Researching…');
    try {
      const res = await callGateway('research', { uid, query: text, language: lang });
      await reply(res.text || { en: 'Sorry, could not generate a response.', hi: 'क्षमा करें, उत्तर नहीं मिला।', mr: 'माफ करा, उत्तर मिळाले नाही.' }[lang] || '');
    } catch (e) { await reply(loc('unavailable')); }
    await reply({ en: 'Ask another question, or type *menu* to go back.', hi: 'और प्रश्न पूछें, या मेनू के लिए *menu* टाइप करें।', mr: 'आणखी प्रश्न विचारा, किंवा मेनूसाठी *menu* टाइप करा.' }[lang] || '');
    return;
  }

  // ── eCourts flow ────────────────────────────────────────────────────────
  if (state === 'ecourts') {
    const cnr = (text || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{12}$/.test(cnr)) {
      await reply({ en: '❌ Invalid CNR format.\nCorrect: DLHC010123456789\nPlease try again.', hi: '❌ CNR सही नहीं है।\nसही: DLHC010123456789\nपुनः टाइप करें।', mr: '❌ CNR चुकीचा आहे.\nयोग्य: DLHC010123456789\nपुन्हा टाइप करा.' }[lang] || '');
      return;
    }
    await reply({ en: '📋 Fetching case status…', hi: '📋 केस स्थिति जाँच रहे हैं…', mr: '📋 केस स्थिती तपासत आहोत…' }[lang] || '');
    try {
      const res = await callGateway('ecourts-status', { cnrNumber: cnr });
      await reply(res.text || { en: 'Could not fetch case status.', hi: 'केस स्थिति नहीं मिली।', mr: 'केस स्थिती मिळाली नाही.' }[lang] || '');
    } catch (e) { await reply(loc('unavailable')); }
    await setSession({ state: 'menu', user_type: userType });
    await reply(loc('menu_back'));
    return;
  }

  // ── Draft flow (advocate only) ──────────────────────────────────────────
  if (state === 'draft') {
    await reply({ en: '📝 Generating draft…', hi: '📝 ड्राफ्ट तैयार हो रहा है…', mr: '📝 मसुदा तयार होत आहे…' }[lang] || '');
    const query = `Generate a concise ${text} template for Indian courts. Plain text only, no markdown. Under 350 words.`;
    try {
      const res = await callGateway('research', { uid, query, language: lang });
      await reply(res.text || { en: 'Could not generate draft.', hi: 'ड्राफ्ट तैयार नहीं हो सका।', mr: 'मसुदा तयार होऊ शकला नाही.' }[lang] || '');
    } catch (e) { await reply(loc('unavailable')); }
    await setSession({ state: 'menu', user_type: userType });
    await reply(loc('menu_back'));
    return;
  }

  // ── Unregistered user menu (option 1/2/3) ──────────────────────────────
  if (state === 'unregistered_menu') {
    if (tLow === '1') {
      await setSession({ state: 'unregistered_query' });
      await reply(
        `Sure! Type your legal question and I'll give you an instant answer.\n\n` +
        `For full research with case citations and document drafting, get free access at:\n` +
        `${LEGAL_AID_APP_URL}/advocate`
      );
    } else if (tLow === '2') {
      await reply(
        `Get free beta access in 2 minutes:\n\n` +
        `👉 ${LEGAL_AID_APP_URL}/advocate\n\n` +
        `After signing up, save your WhatsApp number in Settings to enable this chatbot for your account. ✅`
      );
    } else if (tLow === '3') {
      await supabase.from('conversations').update({ needs_human: true, ai_enabled: false }).eq('id', conversation.id);
      await reply(
        `Happy to help! Our team will reach out to you shortly. 🙏\n\n` +
        `You can also email us: info@legalaidai.in\n` +
        `Website: ${LEGAL_AID_APP_URL}`
      );
    } else {
      await reply(`Please reply with:\n\n1️⃣ Ask a Legal Question\n2️⃣ Get Full App Access\n3️⃣ Talk to Our Team`);
    }
    return;
  }

  // ── Unregistered user free query ────────────────────────────────────────
  if (state === 'unregistered_query') {
    await reply('⚖️ Researching…');
    try {
      const aiRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'You are Nyaya Saathi, an AI legal assistant for Indian law. Answer the user\'s legal question concisely and accurately. Cite relevant Indian statutes or landmark cases where helpful. Keep the response under 350 words in plain text (no markdown).',
        messages: [{ role: 'user', content: text || '' }],
      });
      const answer = aiRes.content[0]?.text || 'Sorry, I could not generate a response. Please try again.';
      await reply(answer);
    } catch (e) {
      console.error('[handleLegalAid] unregistered query error:', e.message);
      await reply('Sorry, I could not process your question right now. Please try again.');
    }
    await reply(
      `For full legal research with case citations and document drafting, get free access at:\n` +
      `${LEGAL_AID_APP_URL}/advocate\n\n` +
      `Ask another question, or type *menu* to go back.`
    );
    return;
  }

  // Fallback: unknown state → reset to language selection
  await setSession({ state: 'lang_select' });
  await reply(languagePrompt());
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // ── Webhook verification (GET from Meta) ───────────────────────────────
  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};
    if (
      p['hub.mode'] === 'subscribe' &&
      p['hub.verify_token'] === process.env.WEBHOOK_VERIFY_TOKEN
    ) {
      return { statusCode: 200, body: p['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  // ── Incoming messages (POST from Meta) ────────────────────────────────
  if (event.httpMethod === 'POST') {
    // Always return 200 immediately so Meta doesn't retry
    try {
      const body = JSON.parse(event.body || '{}');
      const entry = body.entry?.[0];

      // ── Template status updates (APPROVED / REJECTED / PAUSED) ───────────
      for (const change of (entry?.changes || [])) {
        if (change.field === 'message_template_status_update') {
          const v = change.value || {};
          await supabase.from('template_notifications').insert({
            template_id:   String(v.message_template_id || ''),
            template_name: v.message_template_name || '',
            language:      v.message_template_language || null,
            event:         v.event || 'UNKNOWN',
            reason:        v.reason || null,
          });
          console.log('[webhook] template status update:', v.message_template_name, v.event);
        }
      }

      const change = entry?.changes?.[0];
      const value = change?.value;

      // Write delivery/read status events to shared Supabase (wa_message_events)
      if (value?.statuses?.length) {
        const UNDELIVERABLE_CODES = [131026, 131042];
        for (const s of value.statuses) {
          const errObj = s.errors?.[0] || null;
          const { error: evtErr } = await supabase.from('wa_message_events').insert({
            wamid: s.id,
            phone: s.recipient_id,
            status: s.status,
            timestamp: new Date(parseInt(s.timestamp) * 1000).toISOString(),
            error_code: errObj?.code || null,
            error_title: errObj?.title || null,
          });
          if (evtErr) console.error('[webhook] wa_message_events insert failed:', evtErr.message);

          // Mark permanently undeliverable advocates so cron skips them
          if (s.status === 'failed' && UNDELIVERABLE_CODES.includes(errObj?.code)) {
            const phone = '+' + s.recipient_id;
            const { error: advErr } = await supabase.from('advocates')
              .update({ status: 'wa_failed' })
              .eq('phone_e164', phone)
              .in('status', ['contacted', 'ready_to_contact']);
            if (advErr) console.error('[webhook] advocate wa_failed update failed:', advErr.message);
            else console.log('[webhook] marked wa_failed:', phone, errObj?.code);
          }
        }
      }

      // Only process actual messages (not status updates)
      if (!value?.messages?.length) {
        return { statusCode: 200, body: 'OK' };
      }

      const message   = value.messages[0];
      const phoneNumberId = value.metadata.phone_number_id;
      const fromPhone = message.from;
      const msgType   = message.type;
      const text      = message.text?.body || null;
      const mediaUrl  = message.image?.id || message.document?.id || null;
      const ts        = new Date(parseInt(message.timestamp || Date.now() / 1000) * 1000).toISOString();

      // Find the business this phone number belongs to
      const { data: business } = await supabase
        .from('businesses')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .single();

      if (!business) return { statusCode: 200, body: 'OK' };

      // Upsert contact & conversation
      const contact = await upsertContact(fromPhone, business.id);
      const conversation = await upsertConversation(contact.id, business.id);

      // Store the inbound message
      const UNSUPPORTED_LABELS = {
        audio: '🎤 Voice message received', image: '📷 Image received',
        video: '🎥 Video received', document: '📄 Document received',
        sticker: '🔖 Sticker received', location: '📍 Location shared',
        contacts: '👤 Contact card received', reaction: '👍 Reaction received',
      };
      const contentText = text || UNSUPPORTED_LABELS[msgType] || `[${msgType} message received]`;
      await supabase.from('messages').insert({
        conversation_id: conversation.id,
        from_phone: fromPhone,
        to_phone: phoneNumberId,
        content: contentText,
        message_type: msgType === 'text' ? 'text' : (msgType === 'image' ? 'image' : 'document'),
        direction: 'inbound',
        sender_type: 'customer',
        status: 'delivered',
        meta_message_id: message.id,
        media_url: mediaUrl,
        timestamp: ts,
      });

      // Update conversation last_message
      await supabase.from('conversations').update({
        last_message: contentText,
        last_message_at: ts,
        unread_count: (conversation.unread_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq('id', conversation.id);

      // ── Opt-out / re-subscribe handling — intercepts before any AI routing ────
      const OPT_OUT_RE = /^\s*(stop|unsubscribe|cancel|opt[\s-]?out|end|quit)\s*$/i;
      const OPT_IN_RE  = /^\s*(start|subscribe|optin|opt[\s-]?in|resume|resubscribe)\s*$/i;
      if (text && OPT_OUT_RE.test(text)) {
        const optOutMsg = "You have been unsubscribed from Nyaya Saathi messages. We will not contact you in the future.\n\nTo resubscribe, reply *START* anytime.";
        await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, optOutMsg);
        await supabase.from('messages').insert({
          conversation_id: conversation.id, from_phone: phoneNumberId, to_phone: fromPhone,
          content: optOutMsg, direction: 'outbound', sender_type: 'ai', status: 'sent',
          timestamp: new Date().toISOString(),
        });
        await supabase.from('advocates')
          .update({ do_not_contact: true })
          .eq('phone_e164', '+' + fromPhone);
        await supabase.from('conversations').update({ status: 'closed' }).eq('id', conversation.id);
        return { statusCode: 200, body: 'OK' };
      }
      if (text && OPT_IN_RE.test(text)) {
        const optInMsg = "Welcome back to Nyaya Saathi! ⚖️\n\nYou have been resubscribed. You will receive messages from us again.\n\nReply *menu* to get started.";
        await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, optInMsg);
        await supabase.from('messages').insert({
          conversation_id: conversation.id, from_phone: phoneNumberId, to_phone: fromPhone,
          content: optInMsg, direction: 'outbound', sender_type: 'ai', status: 'sent',
          timestamp: new Date().toISOString(),
        });
        await supabase.from('advocates')
          .update({ do_not_contact: false })
          .eq('phone_e164', '+' + fromPhone);
        await supabase.from('conversations').update({ status: 'open' }).eq('id', conversation.id);
        return { statusCode: 200, body: 'OK' };
      }

      // ── Legal Aid branch — runs for Nyaya Saathi business ────────────
      if (business.service_mode === 'legal_aid') {
        if (msgType !== 'text' && msgType !== 'button' && msgType !== 'interactive' && msgType !== 'reaction') {
          const unsupportedReply = "Thanks for reaching out! We can't process audio/image messages right now. Please type your question and we'll be happy to help.";
          await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, unsupportedReply);
          await supabase.from('messages').insert({
            conversation_id: conversation.id, from_phone: phoneNumberId, to_phone: fromPhone,
            content: unsupportedReply, direction: 'outbound', sender_type: 'ai', status: 'sent',
            timestamp: new Date().toISOString(),
          });
          return { statusCode: 200, body: 'OK' };
        }
        await handleLegalAid(business, contact, conversation, text, fromPhone, phoneNumberId);
        return { statusCode: 200, body: 'OK' };
      }

      // ── AI routing (Hybrid mode) ─────────────────────────────────────
      if (msgType !== 'text' && msgType !== 'button' && msgType !== 'interactive' && msgType !== 'reaction') {
        const unsupportedReply = "Thanks for reaching out! We can't process audio/image messages right now. Please type your question and we'll be happy to help.";
        await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, unsupportedReply);
        await supabase.from('messages').insert({
          conversation_id: conversation.id, from_phone: phoneNumberId, to_phone: fromPhone,
          content: unsupportedReply, direction: 'outbound', sender_type: 'ai', status: 'sent',
          timestamp: new Date().toISOString(),
        });
        return { statusCode: 200, body: 'OK' };
      }

      if (conversation.ai_enabled && text) {
        const complex    = needsHuman(text);
        const simple     = isSimpleQuery(text);
        const threshold  = business.ai_auto_threshold || 'simple'; // 'all' | 'simple' | 'none'

        if (complex) {
          // Always escalate complex queries to a human regardless of threshold
          await supabase.from('conversations').update({ needs_human: true }).eq('id', conversation.id);
          const holdMsg = 'Thank you for reaching out! Your message has been flagged for our team and a human agent will get back to you shortly. 🙏';
          await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, holdMsg);
          await supabase.from('messages').insert({
            conversation_id: conversation.id,
            from_phone: phoneNumberId,
            to_phone: fromPhone,
            content: holdMsg,
            direction: 'outbound',
            sender_type: 'ai',
            status: 'sent',
            timestamp: new Date().toISOString(),
          });
        } else if (threshold === 'none') {
          // Never auto-send — always queue for agent review
          const history = await getConversationHistory(conversation.id, 12);
          const claudeMessages = history.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.content,
          }));
          if (!claudeMessages.length || claudeMessages[claudeMessages.length - 1].role !== 'user') {
            claudeMessages.push({ role: 'user', content: text });
          }
          const aiRes = await anthropic.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 500,
            system: business.system_prompt || `You are a helpful customer service assistant for ${business.name}. Be concise, friendly, and helpful.`,
            messages: claudeMessages,
          });
          const aiText = aiRes.content[0]?.text || 'Thank you for your message! We will get back to you shortly.';
          await supabase.from('messages').insert({
            conversation_id: conversation.id,
            from_phone: phoneNumberId,
            to_phone: fromPhone,
            content: aiText,
            direction: 'outbound',
            sender_type: 'ai_suggestion',
            status: 'pending_review',
            timestamp: new Date().toISOString(),
          });
          await supabase.from('conversations').update({ needs_human: true }).eq('id', conversation.id);
        } else {
          // Generate Claude response for all non-complex messages
          const history = await getConversationHistory(conversation.id, 12);
          const claudeMessages = history.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.content,
          }));

          if (!claudeMessages.length || claudeMessages[claudeMessages.length - 1].role !== 'user') {
            claudeMessages.push({ role: 'user', content: text });
          }

          const aiRes = await anthropic.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 500,
            system: business.system_prompt || `You are a helpful customer service assistant for ${business.name}. Be concise, friendly, and helpful.`,
            messages: claudeMessages,
          });

          const aiText = aiRes.content[0]?.text || 'Thank you for your message! We will get back to you shortly.';

          // 'all' → auto-send everything; 'simple' → auto-send only pattern-matched queries
          const shouldAutoSend = threshold === 'all' || (threshold === 'simple' && simple);

          if (shouldAutoSend) {
            const waRes = await sendWhatsAppMessage(business.access_token, phoneNumberId, fromPhone, aiText);
            await supabase.from('messages').insert({
              conversation_id: conversation.id,
              from_phone: phoneNumberId,
              to_phone: fromPhone,
              content: aiText,
              direction: 'outbound',
              sender_type: 'ai',
              status: waRes.messages ? 'sent' : 'failed',
              meta_message_id: waRes.messages?.[0]?.id,
              timestamp: new Date().toISOString(),
            });
          } else {
            // Queue as AI suggestion for agent review
            await supabase.from('messages').insert({
              conversation_id: conversation.id,
              from_phone: phoneNumberId,
              to_phone: fromPhone,
              content: aiText,
              direction: 'outbound',
              sender_type: 'ai_suggestion',
              status: 'pending_review',
              timestamp: new Date().toISOString(),
            });
            await supabase.from('conversations').update({ needs_human: true }).eq('id', conversation.id);
          }
        }
      }

      return { statusCode: 200, body: 'OK' };
    } catch (err) {
      console.error('Webhook error:', err);
      return { statusCode: 200, body: 'OK' }; // Always 200 to Meta
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
