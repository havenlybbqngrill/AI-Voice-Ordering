require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ==================== IN-MEMORY STORE ====================
const customers = [
  {
    id: 'c1', name: 'Jaydeep', phone: '+19735550101', orders: 12, spent: 89.50,
    favorites: [
      { id: 1, name: 'Bacon, Egg & Cheese', price: 4.99, count: 8 },
      { id: 2, name: 'Pastrami Egg & Cheese', price: 8.99, count: 5 },
      { id: 20, name: 'NY Style Platter Steak', price: 10.99, count: 4 },
      { id: 10, name: 'Egg & Cheese', price: 3.99, count: 3 },
      { id: 13, name: 'Sausage Egg & Cheese', price: 4.99, count: 2 }
    ]
  }
];

const orders = [];
const callSessions = {}; // active call state keyed by CallSid

// ==================== MENU ====================
const MENU = {
  Breakfast: [
    { id: 1,  name: 'Bacon, Egg & Cheese',        price: 4.99,  emoji: '🥓' },
    { id: 2,  name: 'Pastrami Egg & Cheese',       price: 8.99,  emoji: '🥩' },
    { id: 3,  name: 'Turkey Sausage Egg & Cheese', price: 6.49,  emoji: '🦃' },
    { id: 4,  name: 'Steak Egg & Cheese',          price: 8.99,  emoji: '🥩' },
    { id: 5,  name: 'Chorizo Egg & Cheese',        price: 6.99,  emoji: '🌶️' },
    { id: 6,  name: 'Ham Egg & Cheese',            price: 4.99,  emoji: '🍖' },
    { id: 7,  name: 'BLT - Bacon Lettuce Tomato',  price: 4.99,  emoji: '🥬' },
    { id: 8,  name: 'Beef Sausage Egg & Cheese',   price: 6.49,  emoji: '🍔' },
    { id: 9,  name: 'Beef Bacon Egg & Cheese',     price: 6.99,  emoji: '🥓' },
    { id: 10, name: 'Egg & Cheese',                price: 3.99,  emoji: '🍳' },
    { id: 11, name: 'Turkey Bacon Egg & Cheese',   price: 6.49,  emoji: '🦃' },
    { id: 12, name: 'Grilled Cheese',              price: 3.99,  emoji: '🧀' },
  { id: 15, name: 'Kimchi Egg & Cheese',         price: 5.99,  emoji: '🥬' },
    { id: 13, name: 'Sausage Egg & Cheese',        price: 4.99,  emoji: '🌭' },
    { id: 14, name: 'Taylor Ham Egg & Cheese',     price: 4.99,  emoji: '🍖' },
  ],
  'NY Platters': [
    { id: 20, name: 'NY Style Platter Steak',             price: 10.99, emoji: '🥩' },
    { id: 21, name: 'NY Style Platter Chicken & Steak',   price: 12.99, emoji: '🍗' },
    { id: 22, name: 'NY Style Platter Shrimp',            price: 11.99, emoji: '🍤' },
    { id: 23, name: 'NY Style Platter Chicken & Shrimp',  price: 11.99, emoji: '🍗' },
    { id: 24, name: 'Grilled Tilapia Platter',            price: 13.99, emoji: '🐟' },
    { id: 25, name: 'Grilled Salmon Platter',             price: 13.99, emoji: '🐟' },
    { id: 26, name: 'NY Style Platter Falafel',           price: 8.99,  emoji: '🧆' },
    { id: 27, name: 'NY Style Platter Chicken',           price: 8.99,  emoji: '🍗' },
  ]
};

const ALL_ITEMS = Object.values(MENU).flat();

function getMenuText() {
  return ALL_ITEMS.map(i => `ID:${i.id} "${i.name}" $${i.price.toFixed(2)}`).join('\n');
}

// ==================== CUSTOMER HELPERS ====================
function findCustomer(phone) {
  const clean = phone.replace(/\D/g, '');
  return customers.find(c => c.phone.replace(/\D/g, '') === clean);
}

function getFavoritesText(customer) {
  if (!customer.favorites.length) return '';
  const top5 = customer.favorites.slice(0, 5);
  return top5.map((f, i) => `${i + 1}. ${f.name} - $${f.price.toFixed(2)}`).join(', ');
}

function getOrCreateSession(callSid, callerPhone) {
  if (!callSessions[callSid]) {
    const customer = findCustomer(callerPhone);
    callSessions[callSid] = {
      callSid,
      callerPhone,
      customer: customer || null,
      cart: [],
      history: [],
      step: customer ? 'ordering' : 'get_name',
      tempName: null
    };
  }
  return callSessions[callSid];
}

// ==================== AI PROCESSING ====================
async function processOrderWithAI(session, userSpeech) {
  const customer = session.customer;
  const favText = customer ? getFavoritesText(customer) : '';
  const cartText = session.cart.length
    ? session.cart.map(i => `${i.qty}x ${i.name} ($${(i.price * i.qty).toFixed(2)})`).join(', ')
    : 'empty';

  const systemPrompt = `You are the friendly AI phone ordering assistant for Outwater Grill, a fast-food restaurant in Garfield, NJ.
You are speaking to a customer on the phone. Keep responses SHORT (1-3 sentences max) and natural for phone conversation.
Customer name: ${customer ? customer.name : 'unknown'}
${favText ? `Their top 5 favorites: ${favText}` : ''}
Current cart: ${cartText}

Menu items available:
${getMenuText()}

VOICE RECOGNITION RULES (very important):
- Speech-to-text is imperfect. Make your BEST GUESS at what they ordered based on the menu.
- "bacon and cheese" = "Bacon, Egg & Cheese" (id:1)
- "chicken" alone = "NY Style Platter Chicken" (id:27)
- "steak" alone = "NY Style Platter Steak" (id:20)
- "taylor ham" or "pork roll" = "Taylor Ham Egg & Cheese" (id:14)
- "sausage" alone = "Sausage Egg & Cheese" (id:13)
- "egg and cheese" = "Egg & Cheese" (id:10)
- "grilled cheese" = "Grilled Cheese" (id:12)
- "salmon" = "Grilled Salmon Platter" (id:25)
- "tilapia" = "Grilled Tilapia Platter" (id:24)
- "shrimp" = "NY Style Platter Shrimp" (id:22)
- "falafel" = "NY Style Platter Falafel" (id:26)
- If unsure, pick the CLOSEST match and confirm it: "I got you a Bacon Egg and Cheese, is that right?"
- NEVER say item not found. Always try to match something.
- If they say something totally unrelated to food, gently redirect: "We have breakfast sandwiches and NY platters, what can I get you?"
- If they say a number (like "give me number 1"), match to their favorites list
- Keep responses brief and conversational
- When they want to checkout/confirm, say "Great! Let me confirm your order." and include <CONFIRM> tag
- When order is complete and confirmed, include <ORDER_COMPLETE> tag
- When adding items, include <ADD_ITEMS>[{"id":1,"qty":1,"note":""}]</ADD_ITEMS> tag
- If they want to remove items, include <REMOVE_ITEM>item name</REMOVE_ITEM>
- Always be warm and fast-food casual
- Tax is 8%, mention total with tax when confirming`;

  const messages = [
    ...session.history,
    { role: 'user', content: userSpeech }
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: systemPrompt,
    messages
  });

  const aiText = response.content[0].text;

  // Parse commands
  const addMatch = aiText.match(/<ADD_ITEMS>(.*?)<\/ADD_ITEMS>/s);
  const isConfirm = aiText.includes('<CONFIRM>');
  const isComplete = aiText.includes('<ORDER_COMPLETE>');
  const removeMatch = aiText.match(/<REMOVE_ITEM>(.*?)<\/REMOVE_ITEM>/);

  // Clean spoken text
  const spokenText = aiText
    .replace(/<ADD_ITEMS>.*?<\/ADD_ITEMS>/s, '')
    .replace(/<CONFIRM>/g, '')
    .replace(/<ORDER_COMPLETE>/g, '')
    .replace(/<REMOVE_ITEM>.*?<\/REMOVE_ITEM>/g, '')
    .trim();

  // Process item additions
  if (addMatch) {
    try {
      const items = JSON.parse(addMatch[1]);
      items.forEach(orderItem => {
        const menuItem = ALL_ITEMS.find(m => m.id === orderItem.id);
        if (menuItem) {
          const existing = session.cart.find(c => c.id === menuItem.id);
          if (existing) existing.qty += (orderItem.qty || 1);
          else session.cart.push({ ...menuItem, qty: orderItem.qty || 1, note: orderItem.note || '' });
        }
      });
    } catch (e) { console.error('Parse error:', e); }
  }

  // Process removals
  if (removeMatch) {
    const removeName = removeMatch[1].toLowerCase();
    session.cart = session.cart.filter(c => !c.name.toLowerCase().includes(removeName));
  }

  // Update conversation history
  session.history.push({ role: 'user', content: userSpeech });
  session.history.push({ role: 'assistant', content: aiText });

  // Keep history manageable
  if (session.history.length > 20) session.history = session.history.slice(-20);

  return { spokenText, isConfirm, isComplete };
}

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
    customer: session.customer ? session.customer.name : session.tempName || 'Phone Customer',
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

  // Update customer history
  if (session.customer) {
    session.customer.orders++;
    session.customer.spent += subtotal;
    session.cart.forEach(cartItem => {
      const fav = session.customer.favorites.find(f => f.id === cartItem.id);
      if (fav) fav.count += cartItem.qty;
      else session.customer.favorites.push({ id: cartItem.id, name: cartItem.name, price: cartItem.price, count: cartItem.qty });
    });
    session.customer.favorites.sort((a, b) => b.count - a.count);
  }

  // Broadcast to KDS via WebSocket
  broadcastKDS({ type: 'new_order', order });

  return order;
}

// ==================== WEBSOCKET (KDS) ====================
function broadcastKDS(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', ws => {
  console.log('KDS client connected');
  // Send current orders on connect
  ws.send(JSON.stringify({ type: 'init', orders }));

  ws.on('message', msg => {
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
  });
});

// ==================== TWILIO VOICE ROUTES ====================

// Initial call answer
app.post('/voice/incoming', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || '';
  const session = getOrCreateSession(callSid, callerPhone);
  const twiml = new VoiceResponse();

  if (session.customer) {
    const favText = getFavoritesText(session.customer);
    const greeting = `Welcome back to Outwater Grill, ${session.customer.name}! ` +
      (favText ? `Your top favorites are: ${favText}. What can I get for you today?` : `What can I get for you today?`);
    twiml.say({ voice: 'Polly.Joanna' }, greeting);
  } else {
    twiml.say({ voice: 'Polly.Joanna' },
      'Thank you for calling Outwater Grill in Garfield! I\'m your AI ordering assistant. May I have your name please?'
    );
  }

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    timeout: 8
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Process speech input
app.post('/voice/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || '';
  const speechResult = req.body.SpeechResult || '';
  const session = getOrCreateSession(callSid, callerPhone);
  const twiml = new VoiceResponse();

  console.log(`[${callSid}] Customer said: "${speechResult}"`);

  if (!speechResult) {
    twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, I didn\'t catch that. Could you please repeat?');
    twiml.gather({
      input: 'speech',
      action: '/voice/process',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      timeout: 8
    });
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Handle get_name step
  if (session.step === 'get_name') {
    session.tempName = speechResult;
    session.step = 'ordering';
    twiml.say({ voice: 'Polly.Joanna' },
      `Nice to meet you, ${speechResult}! What would you like to order today? We have breakfast sandwiches, NY style platters, and more.`
    );
    twiml.gather({
      input: 'speech',
      action: '/voice/process',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      timeout: 8
    });
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    const { spokenText, isConfirm, isComplete } = await processOrderWithAI(session, speechResult);

    if (isComplete || isConfirm) {
      // Place the order
      const order = placeOrder(session);
      if (order) {
        const itemList = order.items.map(i => `${i.qty} ${i.name}`).join(', ');
        const confirmMsg = `Perfect! Your order is confirmed. Order number ${order.num}. ` +
          `You ordered: ${itemList}. Total is $${order.total.toFixed(2)} including tax. ` +
          `We'll text you when it's ready for pickup. Thank you for calling Outwater Grill!`;
        twiml.say({ voice: 'Polly.Joanna' }, confirmMsg);
        // Clean up session
        delete callSessions[callSid];
      } else {
        twiml.say({ voice: 'Polly.Joanna' }, 'It looks like your cart is empty. What would you like to order?');
        twiml.gather({
          input: 'speech',
          action: '/voice/process',
          method: 'POST',
          speechTimeout: 'auto',
          language: 'en-US',
          timeout: 8
        });
      }
    } else {
      twiml.say({ voice: 'Polly.Joanna' }, spokenText);
      twiml.gather({
        input: 'speech',
        action: '/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US',
        timeout: 10
      });
    }
  } catch (error) {
    console.error('AI error:', error);
    twiml.say({ voice: 'Polly.Joanna' },
      'I\'m having a little trouble. Please hold and a team member will assist you.'
    );
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ==================== REST API FOR KDS/DASHBOARD ====================
app.get('/api/orders', (req, res) => res.json(orders));
app.get('/api/customers', (req, res) => res.json(customers));

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
  console.log(`🍔 Outwater Grill ordering system running on port ${PORT}`);
  console.log(`📞 Twilio webhook: POST /voice/incoming`);
  console.log(`📺 KDS Dashboard: http://localhost:${PORT}`);
});
