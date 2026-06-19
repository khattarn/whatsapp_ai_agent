// ================================================
// Template Approval Notifications
// GET  /api/template-notifications           → unseen notifications
// POST /api/template-notifications           → mark IDs as seen
//   Body: { ids: ['uuid', ...] }
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS };

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('template_notifications')
      .select('*')
      .eq('seen', false)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ notifications: data || [] }) };
  }

  if (event.httpMethod === 'POST') {
    const { ids } = JSON.parse(event.body || '{}');
    if (!ids?.length) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'ids required' }) };

    const { error } = await supabase
      .from('template_notifications')
      .update({ seen: true })
      .in('id', ids);

    if (error) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };
};
