require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MENU = [
  { id: 1,  name: 'Bacon Egg and Cheese',           price: 4.99  },
  { id: 2,  name: 'Pastrami Egg and Cheese',         price: 8.99  },
  { id: 3,  name: 'Turkey Sausage Egg and Cheese',   price: 6.49  },
  { id: 4,  name: 'Steak Egg and Cheese',            price: 8.99  },
  { id: 5,  name: 'Chorizo Egg and Cheese',          price: 6.99  },
  { id: 6,  name: 'Ham Egg and Cheese',              price: 4.99  },
  { id: 7,  name: 'BLT',                             price: 4.99  },
  { id: 8,  name: 'Beef Sausage Egg and Cheese',     price: 6.49  },
  { id: 9,  name: 'Beef Bacon Egg and Cheese',       price: 6.99  },
  { id: 10, name: 'Egg and Cheese',                  price: 3.99  },
  { id: 11, name: 'Turkey Bacon Egg and Cheese',     price: 6.49  },
  { id: 12, name: 'Grilled Cheese',                  price: 3.99  },
  { id: 13, name: 'Sausage Egg and Cheese',          price: 4.99  },
  { id: 14, name: 'Taylor Ham Egg and Cheese',       price: 4.99  },
  { id: 20, name: 'NY Steak Platter',                price: 10.99 },
  { id: 21, name: 'NY Chicken and Steak Platter',    price: 12.99 },
  { id: 22, name: 'NY Shrimp Platter',               price: 11.99 },
  { id: 23, name: 'NY Chicken and Shrimp Platter',   price: 11.99 },
  { id: 24, name: 'Grilled Tilapia Platter',         price: 13.99 },
  { id: 25, name: 'Grilled Salmon Platter',          price: 13.99 },
  { id: 26, name: 'NY Falafel Platter',              price: 8.99  },
  { id: 27, name: 'NY Chicken Platter',              price: 8.99  },
];

const customers = {};
const orders = [];
const callSessions = {};
let kdsClients = [];

function broadcastKDS(data) {
  kdsClients = kdsClients.filter(c => c.readyState === WebSocket.OPEN);
  kdsClients.forEach(c => c.send(JSON.stringify(data)));
}

function fmt(n) { return '$' + n.toFixed(2); }

const wssKDS = new WebSocket.Server({ noServer: true });
const wssConv = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/conversation')) {
    wssConv.handleUpgrade(req, socket, head, ws => wssConv.emit('connection', ws, req));
  } else if (req.url === '/kds') {
    wssKDS.handleUpgrade(req, socket, head, ws => wssKDS.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wssKDS.on('connection', ws => {
  kdsClients.push(ws);
  ws.send(JSON.stringify({ type: 'init', orders }));
  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
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
          }
        }
      }
    } catch(e) {}
  });
});

wssConv.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const callSid = url.searchParams.get('callSid') || 'unknown';
  console.log(`[WS Connected] ${callSid}`);

  if (!callSessions[callSid]) {
    callSessions[callSid] = { callSid, phone: '', name: null, cart: [], history: [], step: 'get_name' };
  }
  const session = callSessions[callSid];

  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw);
      console.log(`[${callSid}] type=${msg.type}`);

      if (msg.type === 'setup') {
        session.phone = msg.from || '';
        if (customers[session.phone]) {
          session.name = customers[session.phone].name;
          session.step = 'ordering';
        }
        return;
      }

      if (msg.type === 'prompt') {
        const speech = (msg.voicePrompt || '').trim();
        if (!speech) return;
        console.log(`[${callSid}] Said: "${speech}"`);

        if (session.step === 'get_name') {
          session.name = speech;
          session.step = 'ordering';
          customers[session.phone] = { name: speech };
          ws.send(JSON.stringify({ type: 'text', token: `Nice to meet you ${speech}! What would you like to order? We have breakfast sandwiches and NY style platters.`, last: true }));
          return;
        }

        const reply = await getAIReply(session, speech);
        if (reply.done) {
          const order = placeOrder(session);
          const items = order.items.map(i => `${i.qty} ${i.name}`).join(', ');
          ws.send(JSON.stringify({ type: 'text', token: `Perfect! Order number ${order.num}. You ordered ${items}. Total is ${fmt(order.total)} with tax. Thank you for calling Outwater Grill!`, last: true }));
          setTimeout(() => delete callSessions[callSid], 5000);
        } else {
          ws.send(JSON.stringify({ type: 'text', token: reply.text, last: true }));
        }
      }
    } catch (err) {
      console.error(`[${callSid}] Error:`, err.message);
      console.error('Full error:', err);
      ws.send(JSON.stringify({ type: 'text', token: 'Sorry about that. What would you like to order?', last: true }));
    }
  });

  ws.on('close', () => console.log(`[${callSid}] closed`));
});

async function getAIReply(session, speech) {
  const cartText = session.cart.length
    ? session.cart.map(i => `${i.qty}x ${i.name}`).join(', ')
    : 'empty';

  const system = `You are the AI phone ordering assistant for Outwater Grill in Garfield NJ.
Keep responses SHORT - max 2 sentences. Be friendly.
Customer: ${session.name}
Cart: ${cartText}
Menu: ${MENU.map(i => `${i.name} ${fmt(i.price)}`).join(', ')}

Rules:
- Match customer speech to closest menu item
- Confirm: "Got it, added Bacon Egg and Cheese. Anything else?"
- When done/confirm/checkout: end response with [DONE]
- Tax 8%
- Always match something, never say not found`;

  session.history.push({ role: 'user', content: speech });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system,
    messages: session.history
  });

  const text = response.content[0].text;
  session.history.push({ role: 'assistant', content: text });
  if (session.history.length > 12) session.history = session.history.slice(-12);

  // Only add item if AI explicitly confirms the exact item name
  const aiLower = text.toLowerCase();
  if (/added|got it|adding|i have/.test(aiLower)) {
    MENU.forEach(item => {
      if (aiLower.includes(item.name.toLowerCase())) {
        if (!session.cart.find(c => c.id === item.id)) {
          session.cart.push({ ...item, qty: 1 });
          console.log('Added to cart: ' + item.name);
        }
      }
    });
  }
          console.log(`Added: ${item.name}`);
        }
      }
    }
  });

  return { text: text.replace('[DONE]', '').trim(), done: text.includes('[DONE]') };
}

function placeOrder(session) {
  const subtotal = session.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  const num = Math.floor(Math.random() * 9000) + 1000;
  const order = {
    id: '#' + num, num,
    customer: session.name || 'Customer',
    phone: session.phone,
    items: [...session.cart],
    subtotal, tax, total, status: 'new',
    timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  orders.push(order);
  broadcastKDS({ type: 'new_order', order });
  return order;
}

app.post('/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const phone = req.body.From || '';

  callSessions[callSid] = {
    callSid, phone,
    name: customers[phone]?.name || null,
    cart: [], history: [],
    step: customers[phone] ? 'ordering' : 'get_name'
  };

  const greeting = customers[phone]
    ? `Welcome back ${customers[phone].name}! What can I get for you today?`
    : 'Welcome to Outwater Grill! May I have your name please?';

  const wsUrl = `wss://outwater-grill-d64d7ae4fd7e.herokuapp.com/conversation?callSid=${callSid}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="${greeting}" />
  </Connect>
</Response>`;

  console.log(`Call from ${phone} | ${callSid}`);
  res.type('text/xml').send(twiml);
});

app.get('/', (req, res) => res.send('Outwater Grill is running!'));
app.get('/api/orders', (req, res) => res.json(orders));
app.get('/api/customers', (req, res) => res.json(Object.values(customers)));

app.post('/api/orders/:num/advance', (req, res) => {
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
  res.json(order);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Outwater Grill running on port ${PORT}`));
