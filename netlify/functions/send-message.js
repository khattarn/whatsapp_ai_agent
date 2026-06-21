// ================================================
// Send Message API
// POST /api/send-message
// Body: { conversationId, content, approveSuggestionId? }
// Routes to WhatsApp, Instagram, or Facebook based on conversation.channel
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

async function sendInstagramMessage(accessToken, recipientId, text) {
  const res = await fetch('https://graph.facebook.com/v19.0/me/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  return res.json();
}

async function sendFacebookMessage(pageToken, recipientId, text) {
  const res = await fetch('https://graph.facebook.com/v19.0/me/messages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pageToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
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
    const channel = conv.channel || 'whatsapp';

    // Send via the appropriate channel API
    let sendResult;
    let fromId;
    let toId;

    if (channel === 'instagram') {
      fromId = biz.ig_account_id;
      toId = contact.channel_user_id;
      sendResult = await sendInstagramMessage(biz.access_token, toId, content);
    } else if (channel === 'facebook') {
      fromId = biz.fb_page_id;
      toId = contact.channel_user_id;
      const token = biz.fb_page_token || biz.access_token;
      sendResult = await sendFacebookMessage(token, toId, content);
    } else {
      fromId = biz.phone_number_id;
      toId = contact.phone;
      sendResult = await sendWhatsAppMessage(biz.access_token, fromId, toId, content);
    }

    const msgId = sendResult?.messages?.[0]?.id || sendResult?.message_id || null;
    const status = msgId ? 'sent' : 'failed';

    // If approving an AI suggestion, delete the suggestion message first
    if (approveSuggestionId) {
      await supabase.from('messages').delete().eq('id', approveSuggestionId);
    }

    // Store the sent message
    const { data: msg } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      from_phone: fromId,
      to_phone: toId,
      content,
      direction: 'outbound',
      sender_type: 'agent',
      status,
      meta_message_id: msgId,
      timestamp: new Date().toISOString(),
      channel,
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
      body: JSON.stringify({ success: true, message: msg, result: sendResult }),
    };
  } catch (err) {
    console.error('send-message error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
