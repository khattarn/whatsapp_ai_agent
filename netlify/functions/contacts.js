// ================================================
// Contacts API
// GET  /api/contacts?businessId=X
// PATCH /api/contacts  → update name, tags, opted_in
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    try {
      let query = supabase
        .from('contacts')
        .select('*')
        .eq('business_id', q.businessId)
        .eq('opted_in', true)
        .order('last_seen', { ascending: false });

      if (q.tag) query = query.contains('tags', [q.tag]);

      const { data } = await query;
      return { statusCode: 200, headers, body: JSON.stringify({ contacts: data || [] }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod === 'PATCH') {
    try {
      const { id, name, tags, opted_in, notes } = JSON.parse(event.body || '{}');
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

      const updates = {};
      if (name !== undefined) updates.name = name;
      if (tags !== undefined) updates.tags = tags;
      if (opted_in !== undefined) updates.opted_in = opted_in;
      if (notes !== undefined) updates.notes = notes;

      const { data } = await supabase.from('contacts').update(updates).eq('id', id).select().single();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, contact: data }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
