require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const app = express();
const server = http.createServer(app);

// Two WebSocket servers: voice calls (/conversation) and KDS dashboard (/kds)
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ==================== IN-MEMORY STORE ====================
const orders = [];
const callSessions = {};
// customers keyed by phone number for quick lookup
const customersByPhone = {};

// ==================== MENU ====================
const MENU = {
  Breakfast: [
    { id: 1,  name: 'Bacon, Egg and Cheese',        price: 4.99  },
    { id: 2,  name: 'Pastrami Egg and Cheese',       price: 8.99  },
    { id: 3,  name: 'Turkey Sausage Egg and Cheese', price: 6.49  },
    { id: 4,  name: 'Steak Egg and Cheese',          price: 8.99  },
    { id: 5,  name: 'Chorizo Egg and Cheese',        price: 6.99  },
    { id: 6,  name: 'Ham Egg and Cheese',            price: 4.99  },
    { id: 7,  name: 'BLT',                           price: 4.99  },
    { id: 8,  name: 'Beef Sausage Egg and Cheese',   price: 6.49  },
    { id: 9,  name: 'Beef Bacon Egg and Cheese',     price: 6.99  },
    { id: 10, name: 'Egg and Cheese',                price: 3.99  },
    { id: 11, name: 'Turkey Bacon Egg and Cheese',   price: 6.49  },
    { id: 12, name: 'Grilled Cheese',                price: 3.99  },
    { id: 13, name: 'Sausage Egg and Cheese',        price: 4.99  },
    { id: 14, name: 'Taylor Ham Egg and Cheese',     price: 4.99  },
    { id: 15, name: 'Kimchi Egg and Cheese',         price: 5.99  },
  ],
  'NY Platters': [
    { id: 20, name: 'NY Steak Platter',              price: 10.99 },
    { id: 21, name: 'NY Chicken and Steak Platter',  price: 12.99 },
    { id: 22, name: 'NY Shrimp Platter',             price: 11.99 },
    { id: 23, name: 'NY Chicken and Shrimp Platter', price: 11.99 },
    { id: 24, name: 'Grilled Tilapia Platter',       price: 13.99 },
    { id: 25, name: 'Grilled Salmon Platter',        price: 13.99 },
    { id: 26, name: 'NY Falafel Platter',            price: 8.99  },
    { id: 27, name: 'NY Chicken Platter',            price: 8.99  },
  ]
};

const ALL_ITEMS = Object.values(MENU).flat();

function getMenuText() {
  return ALL_ITEMS.map(i => `"${i.name}" $${i.price.toFixed(2)}`).join('\n');
}

// ==================== KDS BROADCAST + SMS ====================
function broadcastKDS(data) {
  wssKDS.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

async function sendSMSToCustomer(order) {
  try {
    const msg = `Hi ${order.customer}! Your order ${order.id} from Outwater Grill is READY for pickup! 🍔 See you soon!`;
    await twilioClient.messages.create({
      body: msg,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: order.phone
    });
    console.log(`📱 SMS sent to ${order.phone} for order ${order.id}`);
    return true;
  } catch (err) {
    console.error('SMS error:', err.message);
    return false;
  }
}

// ==================== KDS WEBSOCKET ====================
wssKDS.on('connection', ws => {
  console.log('📺 KDS client connected');
  ws.send(JSON.stringify({ type: 'init', orders }));

  ws.on('message', async msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.type === 'advance_order') {
      const order = orders.find(o => o.num === data.num);
      if (order) {
        const flow = { new: 'prep', prep: 'ready', ready: 'done' };
        const next = flow[order.status];
        if (next === 'done') {
          orders.splice(orders.indexOf(order), 1);
          broadcastKDS({ type: 'order_removed', num: data.num });
        } else {
          order.status = next;
          broadcastKDS({ type: 'order_updated', order });
          // Auto-SMS when order moves to ready
          if (next === 'ready') {
            const sent = await sendSMSToCustomer(order);
            if (sent) broadcastKDS({ type: 'sms_sent', num: order.num, customer: order.customer });
          }
        }
      }
    }

    // Manual SMS resend from dashboard
    if (data.type === 'send_sms') {
      const order = orders.find(o => o.num === data.num);
      if (order) {
        const sent = await sendSMSToCustomer(order);
        broadcastKDS({ type: 'sms_sent', num: order.num, customer: order.customer, success: sent });
      }
    }
  });
});

// ==================== ORDER PLACEMENT ====================
function placeOrder(session) {
  if (!session.cart.length) return null;
  const subtotal = session.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  const orderNum = Math.floor(Math.random() * 9000) + 1000;

  const order = {
    id: '#' + orderNum,
    num: orderNum,
    customer: session.customerName || 'Phone Customer',
    phone: session.callerPhone,
    items: [...session.cart],
    subtotal,
    tax,
    total,
    status: 'new',
    time: new Date(),
    timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  orders.push(order);
  broadcastKDS({ type: 'new_order', order });
  console.log(`✅ Order placed: ${order.id} for ${order.customer} — $${order.total.toFixed(2)}`);

  // Save customer
  if (session.callerPhone) {
    customersByPhone[session.callerPhone] = {
      name: session.customerName,
      phone: session.callerPhone,
      orders: (customersByPhone[session.callerPhone]?.orders || 0) + 1,
      spent: ((customersByPhone[session.callerPhone]?.spent || 0) + subtotal)
    };
  }

  return order;
}

// ==================== CART LOGIC ====================
function updateCartFromAI(session, userSpeech, aiText) {
  const combinedText = (userSpeech + ' ' + aiText).toLowerCase();

  // Only add items when AI clearly confirms ("added", "got it", "sure")
  const isConfirming = /\b(added|got it|sure|adding|one .* coming|i added)\b/i.test(aiText);
  if (!isConfirming) return;

  // Find best (longest/most specific) match
  let bestMatch = null;
  let bestScore = 0;

  ALL_ITEMS.forEach(item => {
    const nameLower = item.name.toLowerCase();
    // Check if the AI response contains this item name
    if (!aiText.toLowerCase().includes(nameLower.split(' ')[0])) return;

    // Score by how many words of the item name appear in speech+AI text
    const words = nameLower.split(' ').filter(w => w.length > 2);
    const score = words.filter(w => combinedText.includes(w)).length;
    const specificity = item.name.length; // prefer longer/more specific names

    if (score >= 2 && (score > bestScore || (score === bestScore && specificity > (bestMatch?.name.length || 0)))) {
      bestScore = score;
      bestMatch = item;
    }
  });

  if (bestMatch) {
    const existing = session.cart.find(c => c.id === bestMatch.id);
    if (existing) {
      existing.qty += 1;
    } else {
      session.cart.push({ ...bestMatch, qty: 1, note: '' });
    }
    console.log(`🛒 Added to cart: ${bestMatch.name}`);
  }
}

// ==================== AI RESPONSE ====================
async function getAIResponse(session, userSpeech) {
  const cartText = session.cart.length
    ? session.cart.map(i => `${i.qty}x ${i.name} ($${(i.price * i.qty).toFixed(2)})`).join(', ')
    : 'empty';

  const systemPrompt = `You are the AI phone ordering assistant for Outwater Grill restaurant in Garfield, NJ.
Keep responses SHORT — 1-2 sentences only. You are speaking out loud on a phone call.
Customer name: ${session.customerName || 'unknown'}
Current cart: ${cartText}

FULL MENU:
${getMenuText()}

RULES:
- Match what the customer says to the closest menu item. Make your best guess.
- "bacon and cheese" or "bacon egg cheese" = Bacon, Egg and Cheese
- "taylor ham" or "pork roll" = Taylor Ham Egg and Cheese
- "steak" alone = NY Steak Platter
- "chicken" alone = NY Chicken Platter
- "sausage" alone = Sausage Egg and Cheese
- When adding an item say EXACTLY: "Got it, added [EXACT ITEM NAME]. Anything else?"
- When customer says done/that's it/checkout/confirm, say their order back and end with [ORDER_COMPLETE]
- Tax is 8%, mention total with tax when confirming order
- If cart is empty at checkout, ask what they want
- Never make up items not on the menu`;

  const messages = [
    ...session.history,
    { role: 'user', content: userSpeech }
  ];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: systemPrompt,
    messages
  });

  const aiText = response.content[0].text;

  session.history.push({ role: 'user', content: userSpeech });
  session.history.push({ role: 'assistant', content: aiText });
  if (session.history.length > 16) session.history = session.history.slice(-16);

  updateCartFromAI(session, userSpeech, aiText);

  const orderComplete = aiText.includes('[ORDER_COMPLETE]');
  const cleanText = aiText.replace('[ORDER_COMPLETE]', '').trim();

  return { text: cleanText, orderComplete };
}

// ==================== CONVERSATIONRELAY WEBSOCKET ====================
wssVoice.on('connection', (ws, req) => {
  const urlParams = new URL(req.url, 'http://localhost');
  const callSid = urlParams.searchParams.get('callSid') || 'unknown';
  console.log(`📞 ConversationRelay connected: ${callSid}`);

  callSessions[callSid] = {
    callSid,
    callerPhone: '',
    customerName: null,
    cart: [],
    history: [],
    step: 'get_name'
  };

  const session = callSessions[callSid];

  ws.on('message', async (rawData) => {
    let event;
    try { event = JSON.parse(rawData); } catch { return; }
    console.log(`[${callSid}] Event: ${event.type}`, event.voicePrompt || '');

    if (event.type === 'setup') {
      session.callerPhone = event.from || '';
      const existing = customersByPhone[session.callerPhone];
      if (existing) {
        session.customerName = existing.name;
        session.step = 'ordering';
      }
      return;
    }

    if (event.type === 'prompt') {
      const userSpeech = (event.voicePrompt || '').trim();
      if (!userSpeech) return;
      console.log(`[${callSid}] Customer: "${userSpeech}"`);

      // Collect name first
      if (session.step === 'get_name') {
        session.customerName = userSpeech.replace(/^(my name is |i'm |i am )/i, '').trim();
        session.step = 'ordering';
        ws.send(JSON.stringify({
          type: 'text',
          token: `Nice to meet you, ${session.customerName}! What would you like to order today? We have breakfast sandwiches and NY Style Platters.`,
          last: true
        }));
        return;
      }

      // Process order with AI
      try {
        const { text, orderComplete } = await getAIResponse(session, userSpeech);

        if (orderComplete && session.cart.length > 0) {
          const order = placeOrder(session);
          const confirmText = `Perfect! Your order number is ${order.num}. You ordered ${order.items.map(i => `${i.qty} ${i.name}`).join(', ')}. Your total is $${order.total.toFixed(2)} including tax. We will text you when it is ready. Thank you for calling Outwater Grill!`;
          ws.send(JSON.stringify({ type: 'text', token: confirmText, last: true }));
          delete callSessions[callSid];
        } else {
          ws.send(JSON.stringify({ type: 'text', token: text, last: true }));
        }
      } catch (err) {
        console.error('AI error:', err.message);
        ws.send(JSON.stringify({ type: 'text', token: "I'm sorry, I had a little trouble. Could you repeat that?", last: true }));
      }
    }
  });

  ws.on('close', () => console.log(`[${callSid}] Disconnected`));
  ws.on('error', err => console.error(`[${callSid}] WS Error:`, err.message));
});

// ==================== TWILIO VOICE ROUTE ====================
app.post('/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const callerPhone = req.body.From || '';
  const host = req.headers.host || 'outwater-grill-d64d7ae4fd7e.herokuapp.com';

  const existing = customersByPhone[callerPhone];
  const welcomeGreeting = existing
    ? `Welcome back to Outwater Grill, ${existing.name}! What can I get for you today?`
    : `Thank you for calling Outwater Grill in Garfield! I am your AI ordering assistant. What is your name please?`;

  const wsUrl = `wss://${host}/conversation?callSid=${callSid}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="${welcomeGreeting}" />
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
  console.log(`📞 Incoming call from ${callerPhone} — CallSid: ${callSid}`);
});

// ==================== REST API ====================
app.get('/api/orders', (req, res) => res.json(orders));
app.get('/api/customers', (req, res) => res.json(Object.values(customersByPhone)));

app.post('/api/orders/:num/advance', async (req, res) => {
  const order = orders.find(o => o.num === parseInt(req.params.num));
  if (!order) return res.status(404).json({ error: 'Not found' });
  const flow = { new: 'prep', prep: 'ready', ready: 'done' };
  const next = flow[order.status];
  if (next === 'done') {
    orders.splice(orders.indexOf(order), 1);
    broadcastKDS({ type: 'order_removed', num: order.num });
    return res.json({ removed: true });
  }
  order.status = next;
  broadcastKDS({ type: 'order_updated', order });
  if (next === 'ready') {
    const sent = await sendSMSToCustomer(order);
    if (sent) broadcastKDS({ type: 'sms_sent', num: order.num, customer: order.customer });
  }
  res.json(order);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', orders: orders.length }));

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍔 Outwater Grill running on port ${PORT}`);
  console.log(`📞 Voice webhook: POST /voice/incoming`);
  console.log(`📺 KDS dashboard: http://localhost:${PORT}`);
});
