const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const BASE_URL = String(process.env.BASE_URL || '').replace(/\/$/, '');
const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN || '';
const PAGBANK_API_BASE = (process.env.PAGBANK_API_BASE || 'https://api.pagseguro.com').replace(/\/$/, '');
const VERIFY_WEBHOOK = String(process.env.VERIFY_PAGBANK_WEBHOOK || '1') !== '0';

if (!process.env.DATABASE_URL) console.warn('DATABASE_URL não configurada. O serviço não deve ser usado em produção até conectar o PostgreSQL.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });

const PRODUCTS = {
  blt: {
    blt1: { name: '1.000 BLT', amount: 1000, cents: 490 },
    blt2: { name: '5.500 BLT', amount: 5500, cents: 1990 },
    blt3: { name: '16.500 BLT', amount: 16500, cents: 4990 },
    blt4: { name: '55.000 BLT', amount: 55000, cents: 14990 },
    blt5: { name: '120.000 BLT', amount: 120000, cents: 29990 }
  },
  unlock: {
    u50: { name: '+50 jogadores regulares', players: 50, cents: 490 },
    u150: { name: '+150 jogadores regulares', players: 150, cents: 990 },
    u400: { name: '+400 jogadores regulares', players: 400, cents: 1990 },
    u800: { name: '+800 jogadores regulares', players: 800, cents: 3490 }
  },
  paid: {
    pp1: { name: 'Alex Monteiro', cents: 990 },
    pp2: { name: 'Bruno Carvalho', cents: 1490 },
    pp3: { name: 'Caio Mendes', cents: 1990 },
    pp4: { name: 'Davi Rocha', cents: 2490 },
    pp5: { name: 'Enzo Martins', cents: 2990 },
    pp6: { name: 'Felipe Costa', cents: 3990 },
    pp7: { name: 'Gabriel Alves', cents: 4990 },
    pp8: { name: 'Henrique Silva', cents: 5990 }
  },
  avatar: {
    av1: { name: 'Estratégico', cents: 290 },
    av2: { name: 'Líder', cents: 490 },
    av3: { name: 'Executivo', cents: 690 },
    av4: { name: 'Visionário', cents: 790 },
    av5: { name: 'Campeão', cents: 990 },
    av6: { name: 'Rei do Mercado', cents: 1290 },
    av7: { name: 'Lenda', cents: 1690 },
    av8: { name: 'Mestre do Futebol', cents: 1990 },
    av9: { name: 'Ícone', cents: 2490 },
    av10: { name: 'Bolada Perfeita', cents: 2990 }
  }
};

function getProduct(kind, productId) {
  return PRODUCTS[kind] && PRODUCTS[kind][productId] ? PRODUCTS[kind][productId] : null;
}
function makeUserKey(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length < 16 || raw.length > 200) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}
async function initDb() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bp_orders (
      id UUID PRIMARY KEY,
      reference_id VARCHAR(64) UNIQUE NOT NULL,
      user_key VARCHAR(128) NOT NULL,
      kind VARCHAR(20) NOT NULL,
      product_id VARCHAR(40) NOT NULL,
      product_name VARCHAR(200) NOT NULL,
      amount_cents INTEGER NOT NULL,
      checkout_id VARCHAR(80),
      status VARCHAR(30) NOT NULL DEFAULT 'CREATED',
      fulfilled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      fulfilled_at TIMESTAMPTZ,
      raw_payload JSONB
    );
    CREATE INDEX IF NOT EXISTS bp_orders_checkout_idx ON bp_orders(checkout_id);
    CREATE INDEX IF NOT EXISTS bp_orders_user_idx ON bp_orders(user_key);
  `);
}

// Captura o corpo bruto para validação SHA-256 do webhook PagBank.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/health', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: 'DATABASE_URL ausente' });
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'bolada-perfeita', version: 'V90', payment: 'PagBank' });
  } catch (e) { res.status(503).json({ ok: false, error: 'database_unavailable' }); }
});

app.post('/api/checkout', async (req, res) => {
  try {
    if (!PAGBANK_TOKEN || !BASE_URL || !process.env.DATABASE_URL) return res.status(503).json({ error: 'Servidor de pagamentos ainda não está configurado.' });
    const { kind, productId, userKey } = req.body || {};
    const product = getProduct(kind, productId);
    const safeUserKey = makeUserKey(userKey);
    if (!product || !safeUserKey) return res.status(400).json({ error: 'Produto ou sessão inválida.' });

    const orderId = crypto.randomUUID();
    const referenceId = `BP90-${orderId}`;
    await pool.query(`INSERT INTO bp_orders (id, reference_id, user_key, kind, product_id, product_name, amount_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orderId, referenceId, safeUserKey, kind, productId, product.name, product.cents]);

    const body = {
      reference_id: referenceId,
      items: [{ reference_id: productId, name: `Bolada Perfeita — ${product.name}`, quantity: 1, unit_amount: product.cents }],
      return_url: `${BASE_URL}/?bp_order=${orderId}`,
      redirect_url: `${BASE_URL}/?bp_order=${orderId}`,
      redirect_waiting_time: 5,
      notification_urls: [`${BASE_URL}/api/pagbank/webhook`],
      payment_notification_urls: [`${BASE_URL}/api/pagbank/webhook`]
    };

    const r = await fetch(`${PAGBANK_API_BASE}/checkouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAGBANK_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      await pool.query(`UPDATE bp_orders SET status='CHECKOUT_ERROR', raw_payload=$2 WHERE id=$1`, [orderId, data]);
      return res.status(r.status).json({ error: 'PagBank recusou a criação do checkout.', details: data });
    }
    const payLink = Array.isArray(data.links) && data.links.find(x => x.rel === 'PAY');
    if (!data.id || !payLink?.href) return res.status(502).json({ error: 'PagBank não retornou o link de pagamento.' });
    await pool.query(`UPDATE bp_orders SET checkout_id=$2, status='CHECKOUT_CREATED', raw_payload=$3 WHERE id=$1`, [orderId, data.id, data]);
    res.json({ orderId, checkoutId: data.id, paymentUrl: payLink.href });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro interno ao criar checkout.' });
  }
});

function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
  } catch { return false; }
}
function verifyPagBankWebhook(req) {
  if (!VERIFY_WEBHOOK) return true;
  const received = req.get('x-authenticity-token');
  if (!received || !PAGBANK_TOKEN || !req.rawBody) return false;
  const expected = crypto.createHash('sha256').update(`${PAGBANK_TOKEN}-${req.rawBody.toString('utf8')}`, 'utf8').digest('hex');
  return safeEqualHex(received, expected);
}
async function queryCheckout(checkoutId) {
  const r = await fetch(`${PAGBANK_API_BASE}/checkouts/${encodeURIComponent(checkoutId)}`, { headers: { Authorization: `Bearer ${PAGBANK_TOKEN}`, Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`PagBank query ${r.status}`);
  return data;
}
async function fulfillOrder(orderId, checkoutData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(`SELECT * FROM bp_orders WHERE id=$1 FOR UPDATE`, [orderId]);
    if (!q.rowCount) { await client.query('ROLLBACK'); return false; }
    const order = q.rows[0];
    if (order.fulfilled) { await client.query('COMMIT'); return true; }
    await client.query(`UPDATE bp_orders SET status='PAID', fulfilled=TRUE, paid_at=COALESCE(paid_at,NOW()), fulfilled_at=NOW(), raw_payload=$2 WHERE id=$1`, [orderId, checkoutData]);
    await client.query('COMMIT');
    return true;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

app.post('/api/pagbank/webhook', async (req, res) => {
  try {
    if (!verifyPagBankWebhook(req)) return res.status(401).send('invalid signature');
    const checkoutId = req.get('x-product-id') || req.body?.id;
    if (!checkoutId || !String(checkoutId).startsWith('CHEC_')) return res.status(200).send('ignored');
    const checkout = await queryCheckout(checkoutId);
    const paid = Array.isArray(checkout.charges) && checkout.charges.some(c => c.status === 'PAID');
    const ref = String(checkout.reference_id || '');
    if (paid && ref.startsWith('BP90-')) {
      const orderId = ref.slice(5);
      await fulfillOrder(orderId, checkout);
    }
    res.status(200).send('ok');
  } catch (e) { console.error('Webhook:', e); res.status(200).send('received'); }
});

app.get('/api/order/:id', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'database_unavailable' });
    const q = await pool.query(`SELECT id, user_key, kind, product_id, product_name, amount_cents, status, fulfilled, created_at, paid_at FROM bp_orders WHERE id=$1`, [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ error: 'pedido_nao_encontrado' });
    const row = q.rows[0];
    const supplied = makeUserKey(req.query.userKey);
    if (!supplied || supplied !== row.user_key) return res.status(403).json({ error: 'pedido_nao_pertence_a_sessao' });
    res.json({ orderId: row.id, kind: row.kind, productId: row.product_id, productName: row.product_name, status: row.status, fulfilled: row.fulfilled, amountCents: row.amount_cents, paidAt: row.paid_at });
  } catch (e) { res.status(500).json({ error: 'erro_consulta' }); }
});

initDb().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Bolada Perfeita V90 ouvindo na porta ${PORT}`))).catch(e => { console.error('Falha ao inicializar banco:', e); process.exit(1); });
