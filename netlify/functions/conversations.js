// ================================================
// Conversations API
// GET  /api/conversations?businessId=X&status=open
// GET  /api/conversations?id=X   → single conversation with messages
// PATCH /api/conversations        → update status / ai_enabled / needs_human
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  // ── GET: fetch conversations or single thread ──────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const q = event.queryStringParameters || {};

      // Single conversation with messages
      if (q.id) {
        const { data: conv } = await supabase
          .from('conversations')
          .select('*, contacts(*), businesses(id, name, color, phone_number_id)')
          .eq('id', q.id)
          .single();

        if (!conv) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };

        const { data: messages } = await supabase
          .from('messages')
          .select('*')
          .eq('conversation_id', q.id)
          .order('timestamp', { ascending: true });

        // Reset unread count
        await supabase.from('conversations').update({ unread_count: 0 }).eq('id', q.id);

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ conversation: conv, messages: messages || [] }),
        };
      }

      // List conversations for a business
      const businessId = q.businessId;
      if (!businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

      let query = supabase
        .from('conversations')
        .select('*, contacts(id, name, phone, channel_user_id), businesses(id, name, color)')
        .eq('business_id', businessId)
        .order('last_message_at', { ascending: false })
        .limit(100);

      if (q.status) query = query.eq('status', q.status);
      if (q.needsHuman === 'true') query = query.eq('needs_human', true);
      if (q.channel) query = query.eq('channel', q.channel);

      const { data: convs } = await query;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ conversations: convs || [] }),
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── PATCH: update a conversation ──────────────────────────────────────
  if (event.httpMethod === 'PATCH') {
    try {
      const { id, status, ai_enabled, needs_human, contact_name } = JSON.parse(event.body || '{}');
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

      const updates = {};
      if (status !== undefined) updates.status = status;
      if (ai_enabled !== undefined) updates.ai_enabled = ai_enabled;
      if (needs_human !== undefined) updates.needs_human = needs_human;
      updates.updated_at = new Date().toISOString();

      const { data } = await supabase.from('conversations').update(updates).eq('id', id).select().single();

      // Update contact name if provided
      if (contact_name && data?.contact_id) {
        await supabase.from('contacts').update({ name: contact_name }).eq('id', data.contact_id);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, conversation: data }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
