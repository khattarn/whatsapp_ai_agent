// ================================================
// Broadcast Campaign API
// GET  /api/broadcast?businessId=X  → list campaigns
// POST /api/broadcast               → create & send campaign
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

// Delay between messages to avoid rate limits (200ms)
const delay = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list broadcasts ───────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    const { data } = await supabase
      .from('broadcasts')
      .select('*')
      .eq('business_id', q.businessId)
      .order('created_at', { ascending: false })
      .limit(50);

    return { statusCode: 200, headers, body: JSON.stringify({ broadcasts: data || [] }) };
  }

  // ── POST: create and send broadcast ───────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const { businessId, name, message, contactIds, tags } = JSON.parse(event.body || '{}');

      if (!businessId || !message || !name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId, name and message required' }) };
      }

      // Fetch business
      const { data: biz } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', businessId)
        .single();

      if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };

      // Resolve recipients
      let contactQuery = supabase
        .from('contacts')
        .select('*')
        .eq('business_id', businessId)
        .eq('opted_in', true);

      // Filter by specific contact IDs or tags
      if (contactIds?.length) {
        contactQuery = contactQuery.in('id', contactIds);
      } else if (tags?.length) {
        contactQuery = contactQuery.overlaps('tags', tags);
      }

      const { data: contacts } = await contactQuery;
      if (!contacts?.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No opted-in recipients found' }) };
      }

      // Create broadcast record
      const { data: broadcast } = await supabase
        .from('broadcasts')
        .insert({
          business_id: businessId,
          name,
          message,
          recipient_count: contacts.length,
          status: 'sending',
          sent_at: new Date().toISOString(),
        })
        .select()
        .single();

      // Insert recipients
      await supabase.from('broadcast_recipients').insert(
        contacts.map(c => ({ broadcast_id: broadcast.id, contact_id: c.id, status: 'pending' }))
      );

      // Send messages
      let sentCount = 0;
      let failedCount = 0;

      for (const contact of contacts) {
        try {
          const waRes = await sendWhatsAppMessage(
            biz.access_token,
            biz.phone_number_id,
            contact.phone,
            message
          );
          const msgId = waRes.messages?.[0]?.id;
          const status = msgId ? 'sent' : 'failed';

          if (msgId) {
            sentCount++;
          } else {
            failedCount++;
          }

          // Update recipient status
          await supabase.from('broadcast_recipients')
            .update({ status, meta_message_id: msgId, sent_at: new Date().toISOString() })
            .eq('broadcast_id', broadcast.id)
            .eq('contact_id', contact.id);

          // Also log in the conversation
          const { data: conv } = await supabase
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .eq('business_id', businessId)
            .eq('status', 'open')
            .single();

          if (conv) {
            await supabase.from('messages').insert({
              conversation_id: conv.id,
              from_phone: biz.phone_number_id,
              to_phone: contact.phone,
              content: message,
              direction: 'outbound',
              sender_type: 'agent',
              status,
              meta_message_id: msgId,
              timestamp: new Date().toISOString(),
            });
          }

          await delay(200); // Rate limit protection
        } catch (err) {
          failedCount++;
          console.error(`Failed to send to ${contact.phone}:`, err.message);
        }
      }

      // Update broadcast totals
      await supabase.from('broadcasts').update({
        status: 'sent',
        sent_count: sentCount,
        failed_count: failedCount,
      }).eq('id', broadcast.id);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          broadcastId: broadcast.id,
          sent: sentCount,
          failed: failedCount,
          total: contacts.length,
        }),
      };
    } catch (err) {
      console.error('Broadcast error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
