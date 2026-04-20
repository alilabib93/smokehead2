/**
 * ============================================================
 *  SMOKEHEAD — Shopify → Bosta Auto-Fulfillment
 * ============================================================
 *  When a customer places an order on Shopify, this server:
 *  1. Receives the Shopify webhook
 *  2. Verifies it's genuine (HMAC check)
 *  3. Creates a Bosta delivery order automatically
 *  4. Logs everything for easy debugging
 * ============================================================
 */

const express    = require('express');
const axios      = require('axios');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIGURATION ─────────────────────────────────────────────────────────────
const CONFIG = {
  BOSTA_API_KEY:        process.env.BOSTA_API_KEY        || 'db07878f527de76c6075c16c504766d00d3bd15bc1ce55b4e8a791fa41ff212f',
  BOSTA_API_URL:        'https://app.bosta.co/api/v2',
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET || '',  // set this after step 4
  PICKUP_CITY:          'Cairo',   // your city — Bosta uses this for routing
};

// ── SKU MAP — Shopify SKU → Bosta SKU ─────────────────────────────────────────
// Already matching since we used the same IDs in the Shopify CSV
// Add any variants here (grinder colours all map to the same Bosta SKU)
const SKU_MAP = {
  'BO-2143023':     'BO-2143023',   // Captain Cook 6mm 100pcs
  'BO-2143025':     'BO-2143025',   // Captain Cook 9mm 50pcs
  'BO-2143048':     'BO-2143048',   // Jibill 6mm 50pcs
  'BO-2754540':     'BO-2754540',   // Honeypuff 8mm 50pcs
  'BO-2143049-BLK': 'BO-2143049',   // Grinder Black  ──┐
  'BO-2143049-RED': 'BO-2143049',   // Grinder Red       │ all map to
  'BO-2143049-GRN': 'BO-2143049',   // Grinder Green     │ same Bosta SKU
  'BO-2143049-BLU': 'BO-2143049',   // Grinder Blue      │
  'BO-2143049-ORG': 'BO-2143049',   // Grinder Orange  ──┘
  'BO-2143030':     'BO-2143030',   // Cone Joint Holder
  'BO-2143042':     'BO-2143042',   // Silicone Bowl
  'BO-2451233':     'BO-2451233',   // Mini Silicone Bowl
  'BO-2143033':     'BO-2143033',   // Silicone Container 22ml Black
  'BO-2143032':     'BO-2143032',   // Silicone Container 22ml Orange/Black
  'BO-2451232':     'BO-2451232',   // Silicone Container 5ml
  'BO-2143041':     'BO-2143041',   // Burger Silicone Container
  'BO-2176091':     'BO-2176091',   // Cigar Holder
  'BO-2143058':     'BO-2143058',   // Pokeball Silicone Container
};

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
// We need raw body for HMAC verification, parsed JSON for everything else
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── LOGGER ────────────────────────────────────────────────────────────────────
function log(level, msg, data = null) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// ── SHOPIFY HMAC VERIFICATION ─────────────────────────────────────────────────
function verifyShopifyWebhook(req) {
  const secret = CONFIG.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    log('warn', 'No webhook secret set — skipping HMAC verification (set SHOPIFY_WEBHOOK_SECRET in env)');
    return true;
  }
  const hmac      = req.headers['x-shopify-hmac-sha256'];
  const body      = req.body;
  const digest    = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');
  return hmac === digest;
}

// ── PARSE PHONE NUMBER ────────────────────────────────────────────────────────
// Bosta requires Egyptian phone numbers starting with 01x (10 digits)
function parsePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits
  let digits = raw.replace(/\D/g, '');
  // Remove country code prefix if present (002, +2, 20)
  if (digits.startsWith('002')) digits = digits.slice(3);
  if (digits.startsWith('20'))  digits = digits.slice(2);
  // Should now be 11 digits starting with 01
  if (digits.length === 11 && digits.startsWith('01')) return digits;
  // If 10 digits, prepend 0
  if (digits.length === 10 && digits.startsWith('1'))  return '0' + digits;
  return digits || null;
}

// ── MAP SHOPIFY ADDRESS → BOSTA ADDRESS ───────────────────────────────────────
function mapAddress(shopifyOrder) {
  const addr    = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};
  const customer = shopifyOrder.customer || {};

  // Phone: try shipping address phone first, then customer phone, then billing
  const rawPhone =
    addr.phone ||
    customer.phone ||
    (shopifyOrder.billing_address || {}).phone ||
    '';

  const phone = parsePhone(rawPhone);

  // Full address string for Bosta's "firstLine"
  const addressParts = [
    addr.address1,
    addr.address2,
    addr.address3,
  ].filter(Boolean).join(', ');

  // Bosta city mapping — normalize common variations
  const cityMap = {
    'cairo':          'Cairo',
    'القاهرة':        'Cairo',
    'giza':           'Giza',
    'الجيزة':         'Giza',
    'alexandria':     'Alexandria',
    'الإسكندرية':     'Alexandria',
    'الاسكندرية':     'Alexandria',
    '6th of october': 'Giza',
    'october':        'Giza',
    'sheikh zayed':   'Giza',
    'new cairo':      'Cairo',
    'maadi':          'Cairo',
    'heliopolis':     'Cairo',
    'nasr city':      'Cairo',
    'zamalek':        'Cairo',
  };

  const rawCity = (addr.city || '').toLowerCase().trim();
  const city = cityMap[rawCity] || addr.city || CONFIG.PICKUP_CITY;

  return {
    phone,
    firstLine: addressParts || addr.address1 || '',
    city,
    fullName: addr.name || `${addr.first_name || ''} ${addr.last_name || ''}`.trim() ||
              `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
  };
}

// ── BUILD BOSTA PAYLOAD ───────────────────────────────────────────────────────
function buildBostaPayload(shopifyOrder) {
  const address = mapAddress(shopifyOrder);

  // Map line items to Bosta specs
  const specs = [];
  for (const item of shopifyOrder.line_items || []) {
    const shopifySku = (item.sku || '').trim();
    const bostaSku   = SKU_MAP[shopifySku];

    if (!bostaSku) {
      log('warn', `SKU not found in map: "${shopifySku}" — skipping item`, { title: item.title });
      continue;
    }

    specs.push({
      sku:      bostaSku,
      quantity: item.quantity,
    });
  }

  if (specs.length === 0) {
    throw new Error('No valid Bosta SKUs found in order — cannot create shipment');
  }

  // Bosta order total in EGP (Shopify stores prices in cents * 100)
  const codAmount = parseFloat((shopifyOrder.total_price || 0));

  return {
    type:          10,           // 10 = delivery from warehouse (FBB)
    specs: {
      packageDetails: specs.map(s => ({
        sku:      s.sku,
        quantity: s.quantity,
      }))
    },
    dropOffAddress: {
      firstLine: address.firstLine,
      city:      address.city,
    },
    receiver: {
      firstName: address.fullName.split(' ')[0] || address.fullName,
      lastName:  address.fullName.split(' ').slice(1).join(' ') || '',
      phone:     address.phone,
    },
    cod:           codAmount,
    notes:         `Shopify Order #${shopifyOrder.order_number || shopifyOrder.id}`,
    allowToOpenPackage: true,
  };
}

// ── CREATE BOSTA ORDER ─────────────────────────────────────────────────────────
async function createBostaOrder(payload) {
  const res = await axios.post(
    `${CONFIG.BOSTA_API_URL}/deliveries`,
    payload,
    {
      headers: {
        'Authorization': CONFIG.BOSTA_API_KEY,
        'Content-Type':  'application/json',
      },
      timeout: 15000,
    }
  );
  return res.data;
}

// ── MAIN WEBHOOK HANDLER ──────────────────────────────────────────────────────
app.post('/webhook/orders/create', async (req, res) => {
  // 1. Acknowledge immediately (Shopify times out at 5s)
  res.status(200).send('OK');

  // 2. Verify webhook is from Shopify
  if (!verifyShopifyWebhook(req)) {
    log('error', 'Webhook HMAC verification failed — ignoring');
    return;
  }

  // 3. Parse order
  let order;
  try {
    order = JSON.parse(req.body.toString());
  } catch (e) {
    log('error', 'Failed to parse webhook body', { error: e.message });
    return;
  }

  const orderNum = order.order_number || order.id;
  log('info', `📦 New Shopify order received: #${orderNum}`, {
    customer: order.shipping_address?.name || order.customer?.first_name,
    total:    order.total_price,
    items:    (order.line_items || []).map(i => `${i.sku} x${i.quantity}`),
  });

  // 4. Validate phone number
  const address = mapAddress(order);
  if (!address.phone) {
    log('error', `❌ Order #${orderNum} has no valid Egyptian phone number — cannot create Bosta order`, {
      raw_phone: order.shipping_address?.phone || order.customer?.phone || 'MISSING',
    });
    return;
  }

  // 5. Build Bosta payload
  let payload;
  try {
    payload = buildBostaPayload(order);
    log('info', `🚚 Creating Bosta order for #${orderNum}`, payload);
  } catch (e) {
    log('error', `❌ Failed to build Bosta payload for #${orderNum}`, { error: e.message });
    return;
  }

  // 6. Send to Bosta
  try {
    const bostaResponse = await createBostaOrder(payload);
    log('info', `✅ Bosta order created for Shopify #${orderNum}`, {
      bosta_tracking: bostaResponse?.data?.trackingNumber || bostaResponse?.trackingNumber,
      bosta_id:       bostaResponse?.data?._id || bostaResponse?._id,
    });
  } catch (err) {
    const errorData = err.response?.data || err.message;
    log('error', `❌ Bosta API error for Shopify #${orderNum}`, errorData);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:  'running',
    service: 'Smokehead → Bosta Integration',
    time:    new Date().toISOString(),
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('info', `🔥 Smokehead Bosta integration running on port ${PORT}`);
});
