require('dotenv').config();
const express    = require('express');
const bodyParser = require('body-parser');
const cors       = require('cors');
const http       = require('http');
const WebSocket  = require('ws');
const twilio     = require('twilio');
const Anthropic  = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { Pool }   = require('pg');

const app    = express();
const server = http.createServer(app);

// Two WebSocket servers: voice (/conversation) and KDS (/kds)
const wssVoice = new WebSocket.Server({ noServer: true });
const wssKDS   = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = req.url.split('?')[0];
  if (path === '/conversation') {
    wssVoice.handleUpgrade(req, socket, head, ws => wssVoice.emit('connection', ws, req));
  } else if (path === '/kds') {
    wssKDS.handleUpgrade(req, socket, head, ws => wssKDS.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ==================== POSTGRESQL ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      order_ref   TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      customer_name TEXT,
      phone       TEXT,
      subtotal    NUMERIC(10,2),
      tax         NUMERIC(10,2),
      total       NUMERIC(10,2),
      status      TEXT DEFAULT 'new',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id          SERIAL PRIMARY KEY,
      order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      item_id     INTEGER,
      item_name   TEXT,
      qty         INTEGER,
      unit_price  NUMERIC(10,2),
      line_total  NUMERIC(10,2)
    );
  `);
  console.log('✅ Database tables ready');
}

// ---- DB helpers ----
async function dbFindCustomer(phone) {
  const clean = phone.replace(/\D/g, '');
  const { rows } = await pool.query(
    'SELECT * FROM customers WHERE regexp_replace(phone, \'\\D\', \'\', \'g\') = $1 LIMIT 1',
    [clean]
  );
  return rows[0] || null;
}

async function dbUpsertCustomer(name, phone) {
  const { rows } = await pool.query(
    `INSERT INTO customers (name, phone)
     VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [name, phone]
  );
  return rows[0];
}

async function dbSaveOrder(order, customerId) {
  const { rows } = await pool.query(
    `INSERT INTO orders (order_ref, customer_id, customer_name, phone, subtotal, tax, total, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [order.id, customerId || null, order.customer, order.phone,
     order.subtotal, order.tax, order.total, order.status, order.time]
  );
  const dbId = rows[0].id;
  for (const item of order.items) {
    await pool.query(
      `INSERT INTO order_items (order_id, item_id, item_name, qty, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [dbId, item.id, item.name, item.qty, item.price, item.price * item.qty]
    );
  }
  return dbId;
}

async function dbUpdateOrderStatus(orderRef, status) {
  await pool.query('UPDATE orders SET status=$1 WHERE order_ref=$2', [status, orderRef]);
}

// Get last N unique items a customer ordered (for favourites)
async function dbGetFavourites(customerId, limit = 5) {
  const { rows } = await pool.query(
    `SELECT oi.item_name, oi.unit_price, SUM(oi.qty) as total_qty
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.customer_id = $1
     GROUP BY oi.item_name, oi.unit_price
     ORDER BY total_qty DESC
     LIMIT $2`,
    [customerId, limit]
  );
  return rows;
}

async function dbGetCustomerStats(customerId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as order_count, COALESCE(SUM(total),0) as total_spent
     FROM orders WHERE customer_id=$1`,
    [customerId]
  );
  return rows[0];
}

// ==================== IN-MEMORY (live orders for KDS) ====================
const liveOrders   = [];   // orders currently on kitchen board
const callSessions = {};   // active phone calls

// ==================== MENU ====================
const MENU = {
  Breakfast: [
    { id: 1,  name: 'Bacon, Egg and Cheese',         price: 4.99 },
    { id: 2,  name: 'Pastrami Egg and Cheese',        price: 8.99 },
    { id: 3,  name: 'Turkey Sausage Egg and Cheese',  price: 6.49 },
    { id: 4,  name: 'Steak Egg and Cheese',           price: 8.99 },
    { id: 5,  name: 'Chorizo Egg and Cheese',         price: 6.99 },
    { id: 6,  name: 'Ham Egg and Cheese',             price: 4.99 },
    { id: 7,  name: 'BLT',                            price: 4.99 },
    { id: 8,  name: 'Beef Sausage Egg and Cheese',    price: 6.49 },
    { id: 9,  name: 'Beef Bacon Egg and Cheese',      price: 6.99 },
    { id: 10, name: 'Egg and Cheese',                 price: 3.99 },
    { id: 11, name: 'Turkey Bacon Egg and Cheese',    price: 6.49 },
    { id: 12, name: 'Grilled Cheese',                 price: 3.99 },
    { id: 13, name: 'Sausage Egg and Cheese',         price: 4.99 },
    { id: 14, name: 'Taylor Ham Egg and Cheese',      price: 4.99 },
    { id: 15, name: 'Kimchi Egg and Cheese',          price: 5.99 },
  ],
  'NY Platters': [
    { id: 20, name: 'NY Steak Platter',               price: 10.99 },
    { id: 21, name: 'NY Chicken and Steak Platter',   price: 12.99 },
    { id: 22, name: 'NY Shrimp Platter',              price: 11.99 },
    { id: 23, name: 'NY Chicken and Shrimp Platter',  price: 11.99 },
    { id: 24, name: 'Grilled Tilapia Platter',        price: 13.99 },
    { id: 25, name: 'Grilled Salmon Platter',         price: 13.99 },
    { id: 26, name: 'NY Falafel Platter',             price: 8.99  },
    { id: 27, name: 'NY Chicken Platter',             price: 8.99  },
  ]
};
const ALL_ITEMS = Object.values(MENU).flat();

function getMenuText() {
  return ALL_ITEMS.map(i => `"${i.name}" $${i.price.toFixed(2)}`).join('\n');
}

// ==================== KDS BROADCAST + SMS ====================
function broadcastKDS(data) {
  wssKDS.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
  });
}

async function sendSMSToCustomer(order) {
  try {
    await twilioClient.messages.create({
      body: `Hi ${order.customer}! Your order ${order.id} from Outwater Grill is READY for pickup! 🍔 See you soon!`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: order.phone
    });
    console.log(`📱 SMS sent to ${order.phone}`);
    return true;
  } catch (err) {
    console.error('SMS error:', err.message);
    return false;
  }
}

// ==================== KDS WEBSOCKET ====================
wssKDS.on('connection', ws => {
  console.log('📺 KDS connected');
  ws.send(JSON.stringify({ type: 'init', orders: liveOrders }));

  ws.on('message', async raw => {
    let data; try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'advance_order') {
      const order = liveOrders.find(o => o.num === data.num);
      if (!order) return;
      const flow = { new: 'prep', prep: 'ready', ready: 'done' };
      const next = flow[order.status];
      if (next === 'done') {
        liveOrders.splice(liveOrders.indexOf(order), 1);
        broadcastKDS({ type: 'order_removed', num: data.num });
        await dbUpdateOrderStatus(order.id, 'completed');
      } else {
        order.status = next;
        broadcastKDS({ type: 'order_updated', order });
        await dbUpdateOrderStatus(order.id, next);
        if (next === 'ready') {
          const sent = await sendSMSToCustomer(order);
          if (sent) broadcastKDS({ type: 'sms_sent', num: order.num, customer: order.customer });
        }
      }
    }

    if (data.type === 'send_sms') {
      const order = liveOrders.find(o => o.num === data.num);
      if (order) {
        const sent = await sendSMSToCustomer(order);
        broadcastKDS({ type: 'sms_sent', num: order.num, customer: order.customer, success: sent });
      }
    }
  });
});

// ==================== ORDER PLACEMENT ====================
async function placeOrder(session) {
  if (!session.cart.length) return null;

  const subtotal  = session.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax       = subtotal * 0.08;
  const total     = subtotal + tax;
  const orderNum  = Math.floor(Math.random() * 9000) + 1000;

  const order = {
    id:       '#' + orderNum,
    num:      orderNum,
    customer: session.customerName || 'Phone Customer',
    phone:    session.callerPhone,
    items:    [...session.cart],
    subtotal, tax, total,
    status:   'new',
    time:     new Date(),
    timeStr:  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  liveOrders.push(order);
  broadcastKDS({ type: 'new_order', order });

  // Persist to DB
  try {
    let customerId = session.dbCustomerId || null;
    if (!customerId && session.callerPhone) {
      const cust = await dbUpsertCustomer(session.customerName || 'Phone Customer', session.callerPhone);
      customerId = cust.id;
    }
    await dbSaveOrder(order, customerId);
    console.log(`✅ Order ${order.id} saved to DB for customer ${order.customer}`);
  } catch (err) {
    console.error('DB save error:', err.message);
  }

  return order;
}

// ==================== CART LOGIC ====================
function updateCartFromAI(session, userSpeech, aiText) {
  const isConfirming = /\b(added|got it|adding|sure|one .* coming|i added)\b/i.test(aiText);
  if (!isConfirming) return;

  let bestMatch = null, bestScore = 0;

  ALL_ITEMS.forEach(item => {
    const nameLower = item.name.toLowerCase();
    const combined  = (userSpeech + ' ' + aiText).toLowerCase();
    const words     = nameLower.split(' ').filter(w => w.length > 2);
    const score     = words.filter(w => combined.includes(w)).length;

    if (score >= 2 && (score > bestScore || (score === bestScore && item.name.length > (bestMatch?.name.length || 0)))) {
      bestScore  = score;
      bestMatch  = item;
    }
  });

  if (bestMatch) {
    const existing = session.cart.find(c => c.id === bestMatch.id);
    if (existing) existing.qty += 1;
    else session.cart.push({ ...bestMatch, qty: 1, note: '' });
    console.log(`🛒 Cart: ${bestMatch.name}`);
  }
}

// ==================== AI RESPONSE ====================
async function getAIResponse(session, userSpeech) {
  const cartText = session.cart.length
    ? session.cart.map(i => `${i.qty}x ${i.name} ($${(i.price * i.qty).toFixed(2)})`).join(', ')
    : 'empty';

  // Build favourite intro for returning customers
  let returningContext = '';
  if (session.favourites && session.favourites.length > 0) {
    const favList = session.favourites.map((f, i) => `${i + 1}. ${f.item_name} $${parseFloat(f.unit_price).toFixed(2)}`).join(', ');
    returningContext = `This is a RETURNING customer. Their top favourites are: ${favList}. You already greeted them with their name and listed their favourites. They are now ordering.`;
  }

  const systemPrompt = `You are the AI phone ordering assistant for Outwater Grill restaurant in Garfield, NJ.
Keep responses SHORT — 1-2 sentences only. You are speaking out loud on a phone call.
Customer name: ${session.customerName || 'unknown'}
Current cart: ${cartText}
${returningContext}

FULL MENU:
${getMenuText()}

RULES:
- Match what the customer says to the closest menu item. Make your best guess.
- "bacon and cheese" = Bacon, Egg and Cheese
- "taylor ham" or "pork roll" = Taylor Ham Egg and Cheese
- "steak" alone = NY Steak Platter
- "chicken" alone = NY Chicken Platter
- "sausage" alone = Sausage Egg and Cheese
- When adding an item say EXACTLY: "Got it, added [EXACT ITEM NAME]. Anything else?"
- When customer says done/that's it/checkout/confirm: summarize order with total including 8% tax, then end with [ORDER_COMPLETE]
- If cart is empty at checkout, ask what they want
- Never make up items not on the menu`;

  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system:     systemPrompt,
    messages:   [...session.history, { role: 'user', content: userSpeech }]
  });

  const aiText = response.content[0].text;
  session.history.push({ role: 'user', content: userSpeech });
  session.history.push({ role: 'assistant', content: aiText });
  if (session.history.length > 16) session.history = session.history.slice(-16);

  updateCartFromAI(session, userSpeech, aiText);

  const orderComplete = aiText.includes('[ORDER_COMPLETE]');
  return { text: aiText.replace('[ORDER_COMPLETE]', '').trim(), orderComplete };
}

// ==================== CONVERSATIONRELAY WEBSOCKET ====================
wssVoice.on('connection', async (ws, req) => {
  const urlParams = new URL(req.url, 'http://localhost');
  const callSid   = urlParams.searchParams.get('callSid') || 'unknown';
  console.log(`📞 Call connected: ${callSid}`);

  const session = {
    callSid, callerPhone: '',
    customerName: null, dbCustomerId: null,
    favourites: [],
    cart: [], history: [], step: 'get_name'
  };
  callSessions[callSid] = session;

  ws.on('message', async (rawData) => {
    let event; try { event = JSON.parse(rawData); } catch { return; }

    // ---- SETUP: caller phone arrives, look up in DB ----
    if (event.type === 'setup') {
      session.callerPhone = event.from || '';
      console.log(`[${callSid}] Caller phone: ${session.callerPhone}`);

      try {
        const existing = await dbFindCustomer(session.callerPhone);
        if (existing) {
          session.customerName  = existing.name;
          session.dbCustomerId  = existing.id;
          session.step          = 'ordering';
          session.favourites    = await dbGetFavourites(existing.id, 5);
          const stats           = await dbGetCustomerStats(existing.id);

          // Build welcome back message with favourites
          let favText = '';
          if (session.favourites.length > 0) {
            favText = ' Your favourites are: ' +
              session.favourites.map((f, i) => `${i + 1}. ${f.item_name}`).join(', ') + '.';
          }
          const orderWord = stats.order_count == 1 ? 'order' : 'orders';
          const welcome = `Welcome back ${existing.name}! You have placed ${stats.order_count} ${orderWord} with us.${favText} Would you like to repeat one of your favourites or order something new?`;

          ws.send(JSON.stringify({ type: 'text', token: welcome, last: true }));
          console.log(`[${callSid}] Returning customer: ${existing.name}`);
        }
        // New customer — ConversationRelay already said the welcomeGreeting
      } catch (err) {
        console.error('DB lookup error:', err.message);
      }
      return;
    }

    // ---- PROMPT: customer speaking ----
    if (event.type === 'prompt') {
      const userSpeech = (event.voicePrompt || '').trim();
      if (!userSpeech) return;
      console.log(`[${callSid}] Customer: "${userSpeech}"`);

      // New customer — collect name first
      if (session.step === 'get_name') {
        // Extract just the name (strip "my name is", "I'm", etc.)
        const name = userSpeech
          .replace(/^(my name is |i'm |i am |it's |its )/i, '')
          .trim()
          .split(' ')
          .slice(0, 2)        // first + last name max
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');

        session.customerName = name;
        session.step = 'ordering';

        // Save to DB immediately so we have them on record
        try {
          const cust = await dbUpsertCustomer(name, session.callerPhone);
          session.dbCustomerId = cust.id;
          console.log(`[${callSid}] New customer saved: ${name} ${session.callerPhone}`);
        } catch (err) {
          console.error('DB upsert error:', err.message);
        }

        ws.send(JSON.stringify({
          type:  'text',
          token: `Great to meet you ${name}! Welcome to Outwater Grill. We have breakfast sandwiches and NY Style Platters. What can I get for you today?`,
          last:  true
        }));
        return;
      }

      // Returning customer picking a favourite by number
      if (session.step === 'ordering' && session.favourites.length > 0) {
        const numMatch = userSpeech.match(/\b([1-5]|one|two|three|four|five)\b/i);
        const numMap   = { one:1, two:2, three:3, four:4, five:5 };
        if (numMatch) {
          const pick = parseInt(numMatch[1]) || numMap[numMatch[1].toLowerCase()];
          const fav  = session.favourites[pick - 1];
          if (fav) {
            const menuItem = ALL_ITEMS.find(i => i.name === fav.item_name);
            if (menuItem) {
              session.cart.push({ ...menuItem, qty: 1, note: '' });
              ws.send(JSON.stringify({
                type:  'text',
                token: `Got it, added ${menuItem.name}. Anything else or shall I confirm your order?`,
                last:  true
              }));
              return;
            }
          }
        }
      }

      // Normal AI ordering
      try {
        const { text, orderComplete } = await getAIResponse(session, userSpeech);

        if (orderComplete && session.cart.length > 0) {
          const order = await placeOrder(session);
          const itemList = order.items.map(i => `${i.qty} ${i.name}`).join(', ');
          ws.send(JSON.stringify({
            type:  'text',
            token: `Perfect! Your order number is ${order.num}. You ordered ${itemList}. Total is $${order.total.toFixed(2)} including tax. We will text you when it is ready. Thank you ${session.customerName || ''}, see you soon at Outwater Grill!`,
            last:  true
          }));
          delete callSessions[callSid];
        } else {
          ws.send(JSON.stringify({ type: 'text', token: text, last: true }));
        }
      } catch (err) {
        console.error('AI error:', err.message);
        ws.send(JSON.stringify({ type: 'text', token: "Sorry, I had a little trouble. Could you repeat that?", last: true }));
      }
    }
  });

  ws.on('close', () => console.log(`[${callSid}] Call ended`));
  ws.on('error', err => console.error(`[${callSid}] WS error:`, err.message));
});

// ==================== TWILIO VOICE ROUTE ====================
app.post('/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const host    = req.headers.host || 'outwater-grill-d64d7ae4fd7e.herokuapp.com';
  const wsUrl   = `wss://${host}/conversation?callSid=${callSid}`;

  // welcomeGreeting only plays for NEW customers (returning customers get greeted via setup event)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="Thank you for calling Outwater Grill in Garfield! I am your AI ordering assistant. May I have your name please?" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
  console.log(`📞 Incoming call — ${req.body.From} — ${callSid}`);
});

// ==================== REST API ====================
app.get('/api/orders', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, json_agg(json_build_object(
        'item_name', oi.item_name, 'qty', oi.qty,
        'unit_price', oi.unit_price, 'line_total', oi.line_total
       ) ORDER BY oi.id) as items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customers', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
        COUNT(o.id)            as order_count,
        COALESCE(SUM(o.total),0) as total_spent,
        MAX(o.created_at)      as last_order_at
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id
       GROUP BY c.id
       ORDER BY last_order_at DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customers/:id/favourites', async (req, res) => {
  try {
    const favs = await dbGetFavourites(req.params.id, 10);
    res.json(favs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Live orders (KDS)
app.get('/api/live-orders', (req, res) => res.json(liveOrders));

app.get('/health', (req, res) => res.json({ status: 'ok', liveOrders: liveOrders.length }));

// ==================== START ====================
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🍔 Outwater Grill running on port ${PORT}`);
      console.log(`📞 Voice webhook: POST /voice/incoming`);
      console.log(`📺 KDS: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to init DB:', err.message);
    // Start anyway — system still works without DB
    server.listen(PORT, () => console.log(`🍔 Running on port ${PORT} (no DB)`));
  });
