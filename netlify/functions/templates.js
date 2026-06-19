// ================================================
// WhatsApp Template Management API
// GET    /api/templates?businessId=X             → list templates from Meta
// GET    /api/templates?businessId=X&status=X    → filter by status
// POST   /api/templates                          → create & submit for approval
// DELETE /api/templates?businessId=X&name=X      → delete by template name
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const META_API = 'https://graph.facebook.com/v19.0';

async function metaRequest(method, path, accessToken, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${META_API}${path}`, opts);
  return res.json();
}

// Upload a publicly accessible media URL to Meta and return a header_handle.
// Meta requires this for IMAGE/VIDEO/DOCUMENT template header examples.
async function uploadMediaForHandle(mediaUrl, accessToken) {
  const appId = process.env.META_APP_ID;
  if (!appId) throw new Error('META_APP_ID env var is not set. Add it in Netlify → Environment Variables.');

  // Fetch the file
  const fileResp = await fetch(mediaUrl);
  if (!fileResp.ok) throw new Error(`Could not fetch media URL (${fileResp.status}): ${mediaUrl}`);
  const contentType = fileResp.headers.get('content-type') || 'application/octet-stream';
  const buffer = await fileResp.arrayBuffer();
  const fileLength = buffer.byteLength;
  const fileName = mediaUrl.split('/').pop().split('?')[0] || 'media';

  // Step 1 — create upload session
  const sessionUrl = `${META_API}/${appId}/uploads?file_name=${encodeURIComponent(fileName)}&file_length=${fileLength}&file_type=${encodeURIComponent(contentType)}&access_token=${accessToken}`;
  const sessionRes = await fetch(sessionUrl, { method: 'POST' });
  const sessionData = await sessionRes.json();
  if (!sessionData.id) throw new Error(`Meta upload session failed: ${JSON.stringify(sessionData)}`);
  const uploadSessionId = sessionData.id; // "upload:{id}"

  // Step 2 — upload binary data
  const uploadRes = await fetch(`${META_API}/${uploadSessionId}`, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${accessToken}`,
      'file_offset': '0',
      'Content-Type': contentType,
    },
    body: buffer,
  });
  const uploadData = await uploadRes.json();
  if (!uploadData.h) throw new Error(`Meta file upload failed: ${JSON.stringify(uploadData)}`);
  return uploadData.h;
}

async function getBusiness(businessId) {
  const { data } = await supabase
    .from('businesses')
    .select('id, name, waba_id, access_token')
    .eq('id', businessId)
    .single();
  return data;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list templates from Meta ─────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const { businessId, status } = event.queryStringParameters || {};
    if (!businessId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };

    const biz = await getBusiness(businessId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
    if (!biz.waba_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'waba_id not set for this business' }) };

    let path = `/${biz.waba_id}/message_templates?fields=id,name,status,language,category,components,rejected_reason&limit=100`;
    if (status && status !== 'ALL') path += `&status=${status}`;

    const data = await metaRequest('GET', path, biz.access_token);

    if (data.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: data.error.message, details: data.error }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ templates: data.data || [], paging: data.paging }) };
  }

  // ── POST: create template and submit for Meta review ──────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { businessId, name, category, language, components } = body;

      if (!businessId || !name || !category || !language || !components?.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId, name, category, language, and components are required' }) };
      }
      if (!/^[a-z0-9_]+$/.test(name)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Template name must be lowercase letters, numbers, and underscores only' }) };
      }

      const biz = await getBusiness(businessId);
      if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
      if (!biz.waba_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'waba_id not set for this business' }) };

      // Resolve _mediaUrl on HEADER components → upload to Meta and inject header_handle example
      const resolvedComponents = await Promise.all(components.map(async (comp) => {
        if (comp.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(comp.format) && comp._mediaUrl) {
          const { _mediaUrl, ...rest } = comp;
          const handle = await uploadMediaForHandle(_mediaUrl, biz.access_token);
          return { ...rest, example: { header_handle: [handle] } };
        }
        return comp;
      }));

      const result = await metaRequest('POST', `/${biz.waba_id}/message_templates`, biz.access_token, {
        name,
        language,
        category,
        components: resolvedComponents,
      });

      if (result.error) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: result.error.message || 'Meta API error', details: result.error }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: result.id, status: result.status }) };
    } catch (err) {
      console.error('[templates] POST error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── DELETE: delete template by name ──────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const { businessId, name } = event.queryStringParameters || {};
    if (!businessId || !name) return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId and name required' }) };

    const biz = await getBusiness(businessId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
    if (!biz.waba_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'waba_id not set for this business' }) };

    const result = await metaRequest('DELETE', `/${biz.waba_id}/message_templates?name=${encodeURIComponent(name)}`, biz.access_token);

    if (result.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: result.error.message, details: result.error }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
