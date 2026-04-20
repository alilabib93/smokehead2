# Smokehead — Shopify × Bosta Integration

Every order placed on your Shopify store automatically creates a Bosta delivery.

---

## Deploy in 5 minutes (Railway — free)

### Step 1 — Create a GitHub repo
1. Go to github.com → New repository
2. Name it `smokehead-bosta`
3. Upload all files from this folder

### Step 2 — Deploy to Railway
1. Go to railway.app → Login with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select `smokehead-bosta`
4. Railway auto-detects Node.js and deploys

### Step 3 — Add environment variables on Railway
In your Railway project → **Variables** tab, add:
```
BOSTA_API_KEY = db07878f527de76c6075c16c504766d00d3bd15bc1ce55b4e8a791fa41ff212f
SHOPIFY_WEBHOOK_SECRET = (leave blank for now, fill after step 4)
```

### Step 4 — Add webhook in Shopify
1. Shopify Admin → **Settings → Notifications → Webhooks**
2. Click **Create webhook**
3. Event: `Order creation`
4. Format: `JSON`
5. URL: `https://YOUR-RAILWAY-URL.railway.app/webhook/orders/create`
   (Railway gives you a URL after deploy — copy it from the Railway dashboard)
6. Click Save — Shopify shows you a **webhook secret** → copy it
7. Go back to Railway Variables → paste it as `SHOPIFY_WEBHOOK_SECRET`
8. Railway auto-restarts with the new variable

### Step 5 — Make sure Shopify collects phone numbers
1. Shopify Admin → **Settings → Checkout**
2. Under "Customer contact" → set phone to **Required**
3. This ensures every order has a phone number for Bosta

---

## How it works

```
Customer orders → Shopify fires webhook → This server receives it
→ Maps SKUs to Bosta SKUs → Creates Bosta delivery order
→ Bosta picks from warehouse → Delivers to customer
→ Customer pays (COD or online via Bosta's payment link)
```

## SKU mapping

Your Shopify SKUs already match Bosta SKUs (BO-XXXXXXX format).
Grinder colour variants (BO-2143049-BLK etc.) all map to BO-2143049 on Bosta.

## Logs

Railway shows live logs. Every order prints:
- ✅ Success with Bosta tracking number
- ❌ Error with reason (missing phone, unknown SKU, API error)

---

## Test it

Place a test order on your Shopify store (use Shopify's bogus gateway in test mode).
Check Railway logs — you should see the order received and Bosta order created.
