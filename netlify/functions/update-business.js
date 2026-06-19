// ================================================
// Update Business AI Settings
// PATCH /api/update-business
// Body: { id, system_prompt, ai_auto_threshold }
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'PATCH') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { id, system_prompt, ai_auto_threshold } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };

    const VALID_THRESHOLDS = ['all', 'simple', 'none'];
    const updates = {};
    if (system_prompt !== undefined) updates.system_prompt = system_prompt;
    if (ai_auto_threshold !== undefined) {
      if (!VALID_THRESHOLDS.includes(ai_auto_threshold)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'ai_auto_threshold must be all | simple | none' }) };
      }
      updates.ai_auto_threshold = ai_auto_threshold;
    }

    if (!Object.keys(updates).length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Nothing to update' }) };
    }

    const { error } = await supabase.from('businesses').update(updates).eq('id', id);
    if (error) throw error;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
