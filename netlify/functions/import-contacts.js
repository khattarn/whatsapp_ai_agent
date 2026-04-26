// ================================================
// Import Contacts Function
// GET  /api/import-contacts?businessId=X        → list contacts
// GET  /api/import-contacts?businessId=X&tag=vip → filter by tag
// POST /api/import-contacts                      → bulk upsert contacts
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list contacts ────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    let query = supabase
      .from('contacts')
      .select('id, phone, name, opted_in, tags, last_seen, created_at')
      .eq('business_id', q.businessId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (q.tag) query = query.contains('tags', [q.tag]);
    if (q.optedIn === 'true') query = query.eq('opted_in', true);

    const { data, error } = await query;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

    return { statusCode: 200, headers, body: JSON.stringify({ contacts: data || [] }) };
  }

  // ── POST: bulk import contacts ────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const { businessId, contacts } = JSON.parse(event.body || '{}');

      if (!businessId || !contacts?.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId and contacts array required' }) };
      }

      const now = new Date().toISOString();

      // Clean and validate each row
      const rows = contacts
        .map(c => ({
          phone: String(c.phone || '').replace(/[\s\-\(\)\+\.]/g, ''),
          name: (String(c.name || '')).trim() || String(c.phone),
          business_id: businessId,
          opted_in: true,
          tags: Array.isArray(c.tags)
            ? c.tags.map(t => String(t).trim()).filter(Boolean)
            : (c.tags ? String(c.tags).split(',').map(t => t.trim()).filter(Boolean) : []),
          last_seen: now,
        }))
        .filter(r => r.phone.length >= 7 && /^\d+$/.test(r.phone));

      if (!rows.length) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: 'No valid contacts found. Phone must be digits only with country code (e.g. 919876543210 for India).',
          }),
        };
      }

      // Upsert — updates existing contacts, inserts new ones
      const { data, error } = await supabase
        .from('contacts')
        .upsert(rows, { onConflict: 'phone,business_id', ignoreDuplicates: false })
        .select('id');

      if (error) throw error;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          imported: data?.length || rows.length,
          total: contacts.length,
          skipped: contacts.length - rows.length,
        }),
      };
    } catch (err) {
      console.error('Import contacts error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
