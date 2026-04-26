// ================================================
// Send Message API
// POST /api/send-message
// Body: { conversationId, content, approve_suggestion_id? }
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { conversationId, content, approveSuggestionId } = JSON.parse(event.body || '{}');

    if (!conversationId || !content) {
      return { statusCode: 400, body: JSON.stringify({ error: 'conversationId and content required' }) };
    }

    // Fetch conversation with contact and business
    const { data: conv } = await supabase
      .from('conversations')
      .select('*, contacts(*), businesses(*)')
      .eq('id', conversationId)
      .single();

    if (!conv) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Conversation not found' }) };
    }

    const { businesses: biz, contacts: contact } = conv;

    // Send via WhatsApp API
    const waRes = await sendWhatsAppMessage(
      biz.access_token,
      biz.phone_number_id,
      contact.phone,
      content
    );

    const msgId = waRes.messages?.[0]?.id;
    const status = msgId ? 'sent' : 'failed';

    // If approving an AI suggestion, delete the suggestion message first
    if (approveSuggestionId) {
      await supabase.from('messages').delete().eq('id', approveSuggestionId);
    }

    // Store the sent message
    const { data: msg } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      from_phone: biz.phone_number_id,
      to_phone: contact.phone,
      content,
      direction: 'outbound',
      sender_type: 'agent',
      status,
      meta_message_id: msgId,
      timestamp: new Date().toISOString(),
    }).select().single();

    // Update conversation
    await supabase.from('conversations').update({
      last_message: content,
      last_message_at: new Date().toISOString(),
      needs_human: false,
      unread_count: 0,
      updated_at: new Date().toISOString(),
    }).eq('id', conversationId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: msg, whatsapp: waRes }),
    };
  } catch (err) {
    console.error('send-message error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
