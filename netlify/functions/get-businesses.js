// ================================================
// Get Businesses (safe — no access tokens exposed)
// GET /api/get-businesses
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async () => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    // Try full query including AI settings columns
    const { data, error } = await supabase
      .from('businesses')
      .select('id, name, description, phone_number_id, color, ai_auto_threshold, system_prompt')
      .order('created_at', { ascending: true });

    if (!error) {
      return { statusCode: 200, headers, body: JSON.stringify({ businesses: data || [] }) };
    }

    // AI columns may not exist yet — fall back to basic columns so the app still loads
    const { data: basic, error: err2 } = await supabase
      .from('businesses')
      .select('id, name, description, phone_number_id, color')
      .order('created_at', { ascending: true });

    if (err2) throw err2;
    return { statusCode: 200, headers, body: JSON.stringify({ businesses: basic || [] }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
