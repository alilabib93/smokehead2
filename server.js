const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 8080;

const CONFIG = {
  BOSTA_API_KEY:          process.env.BOSTA_API_KEY          || 'db07878f527de76c6075c16c504766d00d3bd15bc1ce55b4e8a791fa41ff212f',
  BOSTA_API_URL:          'https://app.bosta.co/api/v2',
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET || '',
};

const SKU_MAP = {
  'BO-2143023':'BO-2143023','BO-2143025':'BO-2143025','BO-2143048':'BO-2143048',
  'BO-2754540':'BO-2754540','BO-2143049-BLK':'BO-2143049','BO-2143049-RED':'BO-2143049',
  'BO-2143049-GRN':'BO-2143049','BO-2143049-BLU':'BO-2143049','BO-2143049-ORG':'BO-2143049',
  'BO-2143030':'BO-2143030','BO-2143042':'BO-2143042','BO-2451233':'BO-2451233',
  'BO-2143033':'BO-2143033','BO-2143032':'BO-2143032','BO-2451232':'BO-2451232',
  'BO-2143041':'BO-2143041','BO-2176091':'BO-2176091','BO-2143058':'BO-2143058',
};

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function log(level, msg, data) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function verifyShopifyWebhook(req) {
  const secret = CONFIG.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) { log('warn', 'No webhook secret — skipping'); return true; }
  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
  return hmac === digest;
}

function parsePhone(raw) {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('002')) d = d.slice(3);
  if (d.startsWith('20'))  d = d.slice(2);
  if (d.length === 11 && d.startsWith('01')) return d;
  if (d.length === 10 && d.startsWith('1'))  return '0' + d;
  return d || null;
}

function mapAddress(order) {
  const addr     = order.shipping_address || order.billing_address || {};
  const customer = order.customer || {};
  const phone    = parsePhone(addr.phone || customer.phone || '');
  const firstLine = [addr.address1, addr.address2].filter(Boolean).join(', ');
  const cityMap = {
    'cairo':'Cairo','القاهرة':'Cairo','giza':'Giza','الجيزة':'Giza',
    'alexandria':'Alexandria','6th of october':'Giza','october':'Giza',
    'sheikh zayed':'Giza','new cairo':'Cairo','maadi':'Cairo',
    'heliopolis':'Cairo','nasr city':'Cairo','zamalek':'Cairo',
    'el shorouk':'Cairo','shorouk':'Cairo','obour':'Cairo','badr':'Cairo',
  };
  const city = cityMap[(addr.city||'').toLowerCase().trim()] || addr.city || 'Cairo';
  const fullName = addr.name ||
    `${addr.first_name||''} ${addr.last_name||''}`.trim() ||
    `${customer.first_name||''} ${customer.last_name||''}`.trim();
  return { phone, firstLine, city, fullName };
}

function buildBostaPayload(order) {
  const address = mapAddress(order);
  const items = [];
  for (const item of order.line_items || []) {
    const bostaSku = SKU_MAP[(item.sku||'').trim()];
    if (!bostaSku) { log('warn', `SKU not in map: "${item.sku}" — skipping`); continue; }
    items.push({ bostaSku, qty: item.quantity });
  }
  if (items.length === 0) throw new Error('No valid Bosta SKUs found');
  return {
    type: 10,
    specs: {
      packageType: 'Small',
      packageDetails: {
        description: items.map(i => `${i.bostaSku} x${i.qty}`).join(', '),
        itemsCount:  items.reduce((s, i) => s + i.qty, 0),
      },
    },
    dropOffAddress: {
      firstLine: address.firstLine,
      city:      address.city,
    },
    receiver: {
      firstName: address.fullName.split(' ')[0] || address.fullName,
      lastName:  address.fullName.split(' ').slice(1).join(' ') || '-',
      phone:     address.phone,
    },
    cod:               parseFloat(order.total_price || 0),
    notes:             `Shopify Order #${order.order_number || order.id}`,
    allowToOpenPackage: true,
  };
}

async function createBostaOrder(payload) {
  const res = await axios.post(
    `${CONFIG.BOSTA_API_URL}/deliveries?apiVersion=1`,
    payload,
    { headers: { 'Authorization': CONFIG.BOSTA_API_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data;
}

app.post('/webhook/orders/create', async (req, res) => {
  res.status(200).send('OK');
  if (!verifyShopifyWebhook(req)) { log('error', 'HMAC failed'); return; }
  let order;
  try { order = JSON.parse(req.body.toString()); }
  catch (e) { log('error', 'Parse failed', { error: e.message }); return; }
  const orderNum = order.order_number || order.id;
  log('info', `📦 New order: #${orderNum}`, {
    customer: (order.shipping_address||{}).name,
    total: order.total_price,
    items: (order.line_items||[]).map(i => `${i.sku} x${i.quantity}`),
  });
  const address = mapAddress(order);
  if (!address.phone) { log('error', `❌ #${orderNum} — no valid phone`); return; }
  let payload;
  try { payload = buildBostaPayload(order); log('info', `🚚 Sending to Bosta #${orderNum}`, payload); }
  catch (e) { log('error', `❌ Payload build failed #${orderNum}`, { error: e.message }); return; }
  try {
    const result = await createBostaOrder(payload);
    log('info', `✅ Bosta order created #${orderNum}`, {
      tracking: result?.data?.trackingNumber || result?.trackingNumber,
    });
  } catch (err) {
    log('error', `❌ Bosta API error #${orderNum}`, err.response?.data || err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'running', time: new Date().toISOString() }));
app.listen(PORT, () => log('info', `🔥 Running on port ${PORT}`));
