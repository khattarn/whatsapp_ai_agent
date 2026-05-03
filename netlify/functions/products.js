// ================================================
// Products / Catalogue API
// GET   /api/products?businessId=X               → list all
// GET   /api/products?businessId=X&category=Y   → filter by category
// GET   /api/products?businessId=X&q=search     → keyword search
// GET   /api/products?businessId=X&inStock=true → in-stock only
// POST  /api/products                            → create product
// PATCH /api/products                            → update product
// DELETE /api/products?id=X                      → delete product
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ───────────────────────────────────────────────────────────────
function parseArray(val) {
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // ── GET: list / search products ───────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.businessId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId required' }) };
    }

    try {
      let query = supabase
        .from('products')
        .select('*')
        .eq('business_id', q.businessId)
        .order('in_stock', { ascending: false })   // in-stock first
        .order('category')
        .order('name');

      if (q.category) query = query.eq('category', q.category);
      if (q.inStock === 'true') query = query.eq('in_stock', true);

      // Keyword search across name, category, description, tags
      if (q.q) {
        const term = q.q.toLowerCase();
        query = query.or(
          `name.ilike.%${term}%,category.ilike.%${term}%,description.ilike.%${term}%,sku.ilike.%${term}%`
        );
      }

      const { data, error } = await query.limit(200);
      if (error) throw error;

      return { statusCode: 200, headers, body: JSON.stringify({ products: data || [] }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: create product ───────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const {
        businessId,
        name,
        category = 'Other',
        description,
        price,
        sizes,
        colors,
        imageUrl,
        productUrl,
        paymentUrl,
        sku,
        inStock = true,
        metaProductId,
        tags,
      } = body;

      if (!businessId || !name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'businessId and name required' }) };
      }

      const { data, error } = await supabase
        .from('products')
        .insert({
          business_id:     businessId,
          name:            name.trim(),
          category:        category.trim(),
          description:     description?.trim() || null,
          price:           price ? parseFloat(price) : null,
          currency:        'INR',
          sizes:           parseArray(sizes),
          colors:          parseArray(colors),
          image_url:       imageUrl?.trim() || null,
          product_url:     productUrl?.trim() || null,
          payment_url:     paymentUrl?.trim() || null,
          sku:             sku?.trim() || null,
          in_stock:        Boolean(inStock),
          meta_product_id: metaProductId?.trim() || null,
          tags:            parseArray(tags),
        })
        .select()
        .single();

      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, product: data }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── PATCH: update product ──────────────────────────────────────────────
  if (event.httpMethod === 'PATCH') {
    try {
      const body = JSON.parse(event.body || '{}');
      const {
        id,
        name,
        category,
        description,
        price,
        sizes,
        colors,
        imageUrl,
        productUrl,
        paymentUrl,
        sku,
        inStock,
        metaProductId,
        tags,
      } = body;

      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

      const updates = {};
      if (name       !== undefined) updates.name            = name.trim();
      if (category   !== undefined) updates.category        = category.trim();
      if (description!== undefined) updates.description     = description?.trim() || null;
      if (price      !== undefined) updates.price           = price ? parseFloat(price) : null;
      if (sizes      !== undefined) updates.sizes           = parseArray(sizes);
      if (colors     !== undefined) updates.colors          = parseArray(colors);
      if (imageUrl   !== undefined) updates.image_url       = imageUrl?.trim() || null;
      if (productUrl !== undefined) updates.product_url     = productUrl?.trim() || null;
      if (paymentUrl !== undefined) updates.payment_url     = paymentUrl?.trim() || null;
      if (sku        !== undefined) updates.sku             = sku?.trim() || null;
      if (inStock    !== undefined) updates.in_stock        = Boolean(inStock);
      if (metaProductId !== undefined) updates.meta_product_id = metaProductId?.trim() || null;
      if (tags       !== undefined) updates.tags            = parseArray(tags);

      const { data, error } = await supabase
        .from('products')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, product: data }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── DELETE: remove product ─────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const q = event.queryStringParameters || {};
    if (!q.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id required' }) };

    try {
      const { error } = await supabase.from('products').delete().eq('id', q.id);
      if (error) throw error;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: 'Method Not Allowed' };
};
