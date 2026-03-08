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

// ==================== IN-MEMORY STORE ====================
const customers = {};
const orders = [];
const callSessions = {};
let kdsClients = [];

// ==================== MENU ====================
const MENU = {
  Breakfast: [
    { id: 1,  name: 'Bacon, Egg and Cheese',        price: 4.99 },
    { id: 2,  name: 'Pastrami Egg and Cheese',       price: 8.99 },
    { id: 3,  name: 'Turkey Sausage Egg and Cheese', price: 6.49 },
    { id: 4,  name: 'Steak Egg and Cheese',          price: 8.99 },
    { id: 5,  name: 'Chorizo Egg and Cheese',        price: 6.99 },
    { id: 6,  name: 'Ham Egg and Cheese',            price: 4.99 },
    { id: 7,  name: 'BLT Bacon Lettuce Tomato',      price: 4.99 },
    { id: 8,  name: 'Beef Sausage Egg and Cheese',   price: 6.49 },
    { id: 9,  name: 'Beef Bacon Egg and Cheese',     price: 6.99 },
    { id: 10, name: 'Egg and Cheese',                price: 3.99 },
    { id: 11, name: 'Turkey Bacon Egg and Cheese',   price: 6.49 },
    { id: 12, name: 'Grilled Cheese',                price: 3.99 },
    { id: 13, name: 'Sausage Egg and Cheese',        price: 4.99 },
    { id: 14, name: 'Taylor Ham Egg and Cheese',     price: 4.99 },
  ],
  'NY Platters': [
    { id: 20, name: 'NY Steak Platter',          price: 10.99 },
    { id: 21, name: 'NY Chicken and Steak Platter', price: 12.99 },
    { id: 22, name: 'NY Shrimp Platter',         price: 11.99 },
    { id: 23, name: 'NY Chicken and Shrimp Platter', price: 11.99 },
    { id: 24, name: 'Grilled Tilapia Platter',   price: 13.99 },
    { id: 25, name: 'Grilled Salmon Platter',    price: 13.99 },
    { id: 26, name: 'NY Falafel Platter',        price: 8.99  },
    { id: 27, name: 'NY Chicken Platter',        price: 8.99  },
  ]
};

const ALL_ITEMS = Object.values(MENU).flat();

function getMenuText() {
  let text = '';
  for (const [category, items] of Object.entries(MENU)) {
    text += `\n${category}:\n`;
    items.forEach(i => { text += `  - ${i.name}: $${i.price.toFixed(2)}\n`; });
  }
  return text;
}

// ==================== KDS BROADCAST ====================
function broadcastKDS(data) {
  kdsClients = kdsClients.filter(c => c.readyState === WebSocket.OPEN);
  kdsClients.forEach(c => c.send(JSON.stringify(data)));
}

// ==================== KDS WEBSOCKET ====================
// Separate WebSocket server on path /kds
const wssKDS = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;
  if (pathname === '/kds') {
    wssKDS.handleUpgrade(request, socket, head, ws => {
      wssKDS.emit('connection', ws, request);
    });
  } else if (pathname === '/conversation') {
    wssConversation.handleUpgrade(request, socket, head, ws => {
      wssConversation.emit('connection', ws, request);
    });
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

// ==================== CONVERSATION WEBSOCKET (ConversationRelay) ====================
const wssConversation = new WebSocket.Server({ noServer: true });

wssConversation.on('connection', (ws, req) => {
  const urlParams = new URL(req.url, 'http://localhost');
  const callSid = urlParams.searchParams.get('callSid') || 'unknown';
  
  console.log(`[ConversationRelay] Connected: ${callSid}`);

  const session = callSessions[callSid] || {
    callSid,
    callerPhone: '',
    customerName: null,
    cart: [],
    history: [],
    step: 'get_name'
  };
  callSessions[callSid] = session;

  ws.on('message', async (data) => {
    try {
      const event = JSON.parse(data);
      console.log(`[${callSid}] Event:`, event.type, event.voicePrompt || '');

      if (event.type === 'setup') {
        session.callerPhone = event.from || '';
        // Check if returning customer
        const existing = customers[session.callerPhone];
        if (existing) {
          session.customerName = existing.name;
          session.step = 'ordering';
        }
        return;
      }

      if (event.type === 'prompt') {
        const userSpeech = event.voicePrompt || '';
        if (!userSpeech.trim()) return;

        console.log(`[${callSid}] Customer said: "${userSpeech}"`);

        // Handle name collection
        if (session.step === 'get_name') {
          session.customerName = userSpeech.trim();
          session.step = 'ordering';
          customers[session.callerPhone] = { name: session.customerName, cart: [] };
          
          const response = {
            type: 'text',
            token: `Nice to meet you, ${session.customerName}! Welcome to Outwater Grill. We have breakfast sandwiches like Bacon Egg and Cheese, and NY Style Platters like Steak or Chicken. What would you like to order?`,
            last: true
          };
          ws.send(JSON.stringify(response));
          return;
        }

        // Process order with AI
        const aiResponse = await getAIResponse(session, userSpeech);
        
        // Check if order is complete
        if (aiResponse.orderComplete && session.cart.length > 0) {
          const order = placeOrder(session);
          const confirmText = `Perfect! Your order number is ${order.num}. You ordered ${order.items.map(i => `${i.qty} ${i.name}`).join(', ')}. Your total is $${order.total.toFixed(2)} including tax. We'll see you soon at Outwater Grill!`;
          ws.send(JSON.stringify({ type: 'text', token: confirmText, last: true }));
          delete callSessions[callSid];
          return;
        }

        ws.send(JSON.stringify({ type: 'text', token: aiResponse.text, last: true }));
      }

      if (event.type === 'interrupt') {
        console.log(`[${callSid}] Customer interrupted`);
      }

      if (event.type === 'error') {
        console.error(`[${callSid}] Error:`, event.description);
      }

    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[${callSid}] Disconnected`);
  });
});

// ==================== AI RESPONSE ====================
async function getAIResponse(session, userSpeech) {
  const cartText = session.cart.length
    ? session.cart.map(i => `${i.qty}x ${i.name} ($${(i.price * i.qty).toFixed(2)})`).join(', ')
    : 'empty';

  const systemPrompt = `You are the friendly AI phone ordering assistant for Outwater Grill restaurant in Garfield, NJ.
Keep responses SHORT and natural for phone conversation - 1-2 sentences max.
Customer name: ${session.customerName || 'unknown'}
Current cart: ${cartText}

FULL MENU:${getMenuText()}

RULES:
- Match what customer says to menu items as best you can
- "bacon and cheese" or "bacon egg cheese" = Bacon, Egg and Cheese ($4.99)
- "chicken" alone = NY Chicken Platter ($8.99)  
- "steak" alone = NY Steak Platter ($10.99)
- "taylor ham" or "pork roll" = Taylor Ham Egg and Cheese ($4.99)
- "sausage" = Sausage Egg and Cheese ($4.99)
- Always confirm what you added: "Got it, I added a Bacon Egg and Cheese. Anything else?"
- When they say done/that's it/confirm/checkout: respond with ORDER_COMPLETE and summarize their order
- Tax is 8%
- Be warm, fast, and friendly
- If cart is empty when they try to checkout, ask what they want

When order is complete and customer confirms, end your response with the exact text: [ORDER_COMPLETE]`;

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

  // Update history
  session.history.push({ role: 'user', content: userSpeech });
  session.history.push({ role: 'assistant', content: aiText });
  if (session.history.length > 16) session.history = session.history.slice(-16);

  // Parse items from AI response - look for menu item names mentioned
  updateCartFromResponse(session, userSpeech, aiText);

  const orderComplete = aiText.includes('[ORDER_COMPLETE]');
  const cleanText = aiText.replace('[ORDER_COMPLETE]', '').trim();

  return { text: cleanText, orderComplete };
}

// ==================== CART PARSING ====================
function updateCartFromResponse(session, userSpeech, aiText) {
  const combined = (userSpeech + ' ' + aiText).toLowerCase();
  
  ALL_ITEMS.forEach(item => {
    const name = item.name.toLowerCase();
    const words = name.split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => combined.includes(w)).length;
    
    if (matches >= 2 || combined.includes(name)) {
      // Check if AI confirmed adding it (not removing)
      if (!aiText.toLowerCase().includes('removed') && 
          !aiText.toLowerCase().includes('taking off')) {
        const existing = session.cart.find(c => c.id === item.id);
        if (!existing) {
          // Only add if not already in cart and AI seems to be confirming it
          if (aiText.toLowerCase().includes('added') || 
              aiText.toLowerCase().includes('got it') ||
              aiText.toLowerCase().includes('sure') ||
              aiText.toLowerCase().includes(item.name.toLowerCase().split(' ')[0])) {
            if (!existing) {
              session.cart.push({ ...item, qty: 1, note: '' });
              console.log(`Added to cart: ${item.name}`);
            }
          }
        }
      }
    }
  });
}

// ==================== ORDER PLACEMENT ====================
function placeOrder(session) {
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
  console.log(`Order placed: #${orderNum} for ${order.customer}`);
  return order;
}

// ==================== TWILIO WEBHOOK ====================
app.post('/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid || 'test';
  const callerPhone = req.body.From || '';
  const host = req.headers.host;

  // Initialize session
  callSessions[callSid] = {
    callSid,
    callerPhone,
    customerName: customers[callerPhone]?.name || null,
    cart: [],
    history: [],
    step: customers[callerPhone] ? 'ordering' : 'get_name'
  };

  const isReturning = !!customers[callerPhone];
  const welcomeGreeting = isReturning
    ? `Welcome back to Outwater Grill, ${customers[callerPhone].name}! What can I get for you today?`
    : `Thank you for calling Outwater Grill in Garfield! I'm your AI ordering assistant. May I have your name please?`;

  const wsUrl = `wss://outwater-grill-d64d7ae4fd7e.herokuapp.com/conversation?callSid=${callSid}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="${welcomeGreeting}" voice="Polly.Joanna" />
  </Connect>
</Response>`;

  console.log(`Incoming call from ${callerPhone}, CallSid: ${callSid}`);
  res.type('text/xml').send(twiml);
});

// ==================== REST API ====================
app.get('/', (req, res) => res.send('Outwater Grill Voice Ordering is running!'));
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

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍔 Outwater Grill running on port ${PORT}`);
});
