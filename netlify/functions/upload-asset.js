// ================================================
// Asset Upload & Management
// POST   /api/upload-asset
//   Body: { businessId, fileName, fileType, fileData (base64) }
//   → uploads to Supabase Storage bucket 'assets'
//   → returns { url, path }
//
// GET    /api/upload-asset?businessId=X
//   → lists all assets for a business
//
// DELETE /api/upload-asset?businessId=X&path=X
//   → deletes a single asset
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET = 'assets';
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS };

  // ── GET: list assets for a business ──────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const { businessId } = event.queryStringParameters || {};
    if (!businessId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'businessId required' }) };

    const { data, error } = await supabase.storage.from(BUCKET).list(businessId, {
      limit: 200,
      sortBy: { column: 'created_at', order: 'desc' },
    });

    if (error) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };

    const assets = (data || [])
      .filter(f => f.name !== '.emptyFolderPlaceholder')
      .map(f => ({
        name: f.name,
        path: `${businessId}/${f.name}`,
        size: f.metadata?.size || 0,
        contentType: f.metadata?.mimetype || 'application/octet-stream',
        updatedAt: f.updated_at,
        url: supabase.storage.from(BUCKET).getPublicUrl(`${businessId}/${f.name}`).data.publicUrl,
      }));

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ assets }) };
  }

  // ── POST: generate a signed upload URL (client uploads directly to Supabase) ─
  if (event.httpMethod === 'POST') {
    try {
      const { businessId, fileName, fileType } = JSON.parse(event.body || '{}');

      if (!businessId || !fileName || !fileType) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'businessId, fileName, and fileType are required' }) };
      }

      // Sanitize filename: lowercase, alphanumeric + dash/underscore/dot only
      const safe = fileName.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_');
      const ts = Date.now();
      const path = `${businessId}/${ts}-${safe}`;

      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };

      const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ signedUrl: data.signedUrl, path, publicUrl }) };
    } catch (err) {
      console.error('[upload-asset] POST error:', err);
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── DELETE: remove an asset ───────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const { businessId, path } = event.queryStringParameters || {};
    if (!businessId || !path) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'businessId and path required' }) };

    // Safety: path must start with businessId to prevent cross-tenant deletion
    if (!path.startsWith(`${businessId}/`)) {
      return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };
};
