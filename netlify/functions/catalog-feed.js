// ================================================
// WhatsApp / Meta Catalogue Feed
// GET /feeds/<businessId>.csv                       → CSV product feed (netlify.toml rewrites this here)
// GET /api/catalog-feed?businessId=X                → same CSV
// GET /api/catalog-feed?businessId=X&format=json    → readiness report for the dashboard
//
// Meta Commerce Manager pulls the CSV on a schedule (a "scheduled data feed"), so the Meta catalogue that is
// connected to the WhatsApp number follows the Catalogue tab: price, stock and image edits flow through.
// Meta requires: id, title, description, availability, condition, price, link, image_link, brand.
// Products with no price or no usable image can't be listed on WhatsApp — they are left out and reported.
// ================================================

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PAGE = 1000;   // Supabase returns at most 1000 rows per request

// Site's own base URL, from the request — used as the "link" fallback for products with no product/order URL.
function siteBase(event) {
  const host = event.headers?.['x-forwarded-host'] || event.headers?.host;
  if (!host) return '';
  return `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}`;
}

// The ID Meta knows a product by. Kept stable: an explicit Meta ID wins, then SKU, then our row id.
function retailerId(p) {
  return String(p.meta_product_id || p.sku || p.id).trim();
}

const isHttpsUrl = u => /^https:\/\/\S+$/i.test(String(u || '').trim());

// Split products into feed-ready items and skipped ones (with reasons), and note soft warnings.
function evaluateProducts(products, brand, base) {
  const items = [], skipped = [], warnings = [];
  const seen = new Map();   // retailer id → product name, to catch duplicates

  for (const p of products) {
    const reasons = [];
    const price = Number(p.price);
    if (!p.name || !String(p.name).trim()) reasons.push('no name');
    if (!(price > 0)) reasons.push('no price');
    if (!isHttpsUrl(p.image_url)) reasons.push(p.image_url ? 'image URL is not https' : 'no image');

    const id = retailerId(p);
    if (seen.has(id)) reasons.push(`same ID as "${seen.get(id)}" (${id}) — give one a different SKU`);
    else seen.set(id, p.name);

    if (reasons.length) { skipped.push({ name: p.name || '(unnamed)', reasons }); continue; }

    let link = [p.product_url, p.payment_url].map(u => String(u || '').trim()).find(isHttpsUrl);
    if (!link) {
      link = base ? `${base}/` : '';
      warnings.push({ name: p.name, message: 'no product or order link — the feed uses your site address' });
    }

    const extras = [];
    if ((p.sizes || []).length)  extras.push(`Sizes: ${p.sizes.join(', ')}`);
    if ((p.colors || []).length) extras.push(`Colors: ${p.colors.join(', ')}`);
    const description = [p.description || p.name, ...extras].join('\n').trim().slice(0, 5000);

    items.push({
      id,
      title: String(p.name).trim().slice(0, 150),
      description,
      availability: p.in_stock ? 'in stock' : 'out of stock',
      condition: 'new',
      price: `${price.toFixed(2)} ${p.currency || 'INR'}`,
      link,
      image_link: String(p.image_url).trim(),
      brand: brand || 'Brand',
      product_type: p.category || '',
    });
  }
  return { items, skipped, warnings };
}

const COLUMNS = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'product_type'];

function toCsv(items) {
  const cell = v => `"${String(v ?? '').replace(/\r/g, '').replace(/"/g, '""')}"`;
  return [COLUMNS.join(','), ...items.map(it => COLUMNS.map(c => cell(it[c])).join(','))].join('\n') + '\n';
}

async function loadProducts(businessId) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products').select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

exports.handler = async (event) => {
  const json = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: json };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return { statusCode: 405, headers: json, body: 'Method Not Allowed' };

  const q = event.queryStringParameters || {};
  // /feeds/<id>.csv arrives as ?path=<id>.csv
  const businessId = (q.businessId || String(q.path || '').replace(/\.csv$/i, '')).trim();
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
    return { statusCode: 400, headers: json, body: JSON.stringify({ error: 'valid businessId required' }) };
  }

  try {
    const { data: biz } = await supabase.from('businesses').select('id, name').eq('id', businessId).maybeSingle();
    if (!biz) return { statusCode: 404, headers: json, body: JSON.stringify({ error: 'Business not found' }) };

    const products = await loadProducts(businessId);
    const { items, skipped, warnings } = evaluateProducts(products, biz.name, siteBase(event));

    if (q.format === 'json') {
      return {
        statusCode: 200, headers: json,
        body: JSON.stringify({ total: products.length, ready: items.length, skipped, warnings }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
      body: toCsv(items),
    };
  } catch (err) {
    console.error('[catalog-feed] error:', err);
    return { statusCode: 500, headers: json, body: JSON.stringify({ error: err.message }) };
  }
};

// Exported for tests
exports._internals = { evaluateProducts, toCsv, retailerId };
