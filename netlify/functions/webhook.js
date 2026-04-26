// ================================================
// WhatsApp Webhook Handler
// GET  → Meta verification challenge
// POST → Incoming messages from customers
// ================================================

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── Find or create contact ─────────────────────────────────────────────────
async function upsertContact(phone, businessId) {
  const { data: existing } = await supabase
    .from('contacts')
    .select('*')
    .eq('phone', phone)
    .eq('business_id', businessId)
    .single();

  if (existing) {
    await supabase.from('contacts').update({ last_seen: new Date().toISOString() }).eq('id', existing.id);
    return existing;
  }

  const { data: created } = await supabase
    .from('contacts')
    .insert({ phone, name: phone, business_id: businessId, last_seen: new Date().toISOString() })
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
      const change = entry?.changes?.[0];
      const value = change?.value;

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
      const contentText = text || `[${msgType} message received]`;
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

      // ── AI routing (Hybrid mode) ─────────────────────────────────────
      if (conversation.ai_enabled && text) {
        const complex = needsHuman(text);
        const simple  = isSimpleQuery(text);

        if (complex) {
          // Mark as needing human, store a note
          await supabase.from('conversations').update({ needs_human: true }).eq('id', conversation.id);
          // Send a holding message via AI
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
        } else {
          // Generate Claude response for all non-complex messages
          const history = await getConversationHistory(conversation.id, 12);
          const claudeMessages = history.map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'assistant',
            content: m.content,
          }));

          // Ensure conversation ends with user message
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

          if (simple) {
            // Auto-send for simple FAQs
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
