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
    const { data } = await supabase
      .from('businesses')
      .select('id, name, description, phone_number_id, color, ai_auto_threshold, system_prompt')
      .order('created_at', { ascending: true });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ businesses: data || [] }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
