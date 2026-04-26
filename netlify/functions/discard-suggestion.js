// ================================================
// Discard AI Suggestion message
// POST /api/discard-suggestion
// Body: { messageId }
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { messageId } = JSON.parse(event.body || '{}');
    if (!messageId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'messageId required' }) };

    await supabase.from('messages').delete().eq('id', messageId).eq('sender_type', 'ai_suggestion');

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
