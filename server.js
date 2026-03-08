require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let orders = [];
let customers = {};
let sessions = {};
let orderNum = 1;
let wsClients = [];

const MENU = `
BREAKFAST SANDWICHES:
- Bacon Egg & Cheese $4.99
- Sausage Egg & Cheese $4.99
- Taylor Ham Egg & Cheese $4.99
- Ham Egg & Cheese $4.99
- Egg & Cheese $3.99
- Grilled Cheese $3.99
- BLT $4.99
- Turkey Bacon Egg & Cheese $6.49
- Beef Sausage Egg & Cheese $6.49
- Turkey Sausage Egg & Cheese $6.49
- Beef Bacon Egg & Cheese $6.99
- Chorizo Egg & Cheese $6.99
- Steak Egg & Cheese $8.99
- Pastrami Egg & Cheese $8.99

NY STYLE PLATTERS (served with rice & salad):
- Chicken Platter $8.99
- Falafel Platter $8.99
- Shrimp Platter $11.99
- Chicken & Shrimp Platter $11.99
- NY Style Steak Platter $10.99
- Chicken & Steak Platter $12.99
- Grilled Tilapia Platter $13.99
- Grilled Salmon Platter $13.99

BREAD OPTIONS (for sandwiches): Round Roll (default), Half Hero +$1.00, Bagel +$0.50, Everything Bagel +$0.50, Croissant +$0.99, White Bread, Wheat Bread
EGG OPTIONS: Fried (default), Scrambled, Over Easy, No Eggs
CHEESE OPTIONS: American (default), Mozzarella, Provolone, Swiss, No Cheese
`;

function broadcast(data) {
  wsClients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', ws => {
  wsClients.push(ws);
  ws.send(JSON.stringify({ type: 'init', orders }));

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'advance_order') {
        const order = orders.find(o => o.num === data.num);
        if (order) {
          const flow = ['new', 'prep', 'ready', 'done'];
          const idx = flow.indexOf(order.status);
          if (idx < flow.length - 1) order.status = flow[idx + 1];
          broadcast({ type: 'order_updated', order });
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    wsClients = wsClients.filter(c => c !== ws);
  });
});

// Health check
app.get('/', (req, res) => res.send('Outwater Grill Online'));

// Twilio incoming call
app.post('/voice/incoming', (req, res) => {
  const phone = req.body.From;
  const twiml = new twilio.twiml.VoiceResponse();

  sessions[phone] = { phone, items: [], history: [] };

  let greeting = 'Welcome to Outwater Grill!';
  if (customers[phone]) {
    greeting = `Welcome back, ${customers[phone].name}!`;
  }

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US'
  });

  gather.say({ voice: 'Polly.Joanna' },
    `${greeting} What would you like to order today? You can say things like: bacon egg and cheese on a roll, or chicken platter.`
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// Process speech
app.post('/voice/process', async (req, res) => {
  const phone = req.body.From;
  const speech = req.body.SpeechResult || '';

  if (!sessions[phone]) sessions[phone] = { phone, items: [], history: [] };
  const session = sessions[phone];

  session.history.push({ role: 'user', content: speech });

  try {
    const systemPrompt = `You are a friendly phone order taker for Outwater Grill restaurant. 
Menu: ${MENU}

Current order so far: ${JSON.stringify(session.items)}

Your job:
- Help customers order from the menu
- Ask about bread choice, egg style, cheese for sandwiches if not specified
- Confirm the order when customer says they're done
- Be brief and friendly (this is a phone call)

When customer confirms order is complete, end your response with:
<ORDER_COMPLETE>

When adding items, include them in your response like:
<ADD_ITEM>{"name":"Bacon Egg & Cheese","price":4.99,"mods":"scrambled eggs, everything bagel"}</ADD_ITEM>

Keep responses SHORT - 1-2 sentences max.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: session.history
    });

    const aiText = response.content[0].text;
    session.history.push({ role: 'assistant', content: aiText });

    // Parse any items added
    const itemMatches = aiText.matchAll(/<ADD_ITEM>(.*?)<\/ADD_ITEM>/gs);
    for (const match of itemMatches) {
      try {
        const item = JSON.parse(match[1]);
        session.items.push(item);
      } catch (e) {}
    }

    // Clean response for TTS
    const cleanText = aiText
      .replace(/<ADD_ITEM>.*?<\/ADD_ITEM>/gs, '')
      .replace(/<ORDER_COMPLETE>/g, '')
      .trim();

    const twiml = new twilio.twiml.VoiceResponse();

    if (aiText.includes('<ORDER_COMPLETE>') && session.items.length > 0) {
      // Save order
      const num = orderNum++;
      const total = session.items.reduce((sum, i) => sum + (i.price || 0), 0);
      const order = {
        num,
        phone,
        name: customers[phone]?.name || 'Phone Customer',
        items: session.items,
        total: (total * 1.08).toFixed(2),
        status: 'new',
        time: new Date().toLocaleTimeString()
      };

      orders.push(order);
      broadcast({ type: 'new_order', order });

      twiml.say({ voice: 'Polly.Joanna' },
        `${cleanText} Your order number is ${num}. We'll have it ready soon! Goodbye!`
      );

      delete sessions[phone];
    } else {
      const gather = twiml.gather({
        input: 'speech',
        action: '/voice/process',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US'
      });
      gather.say({ voice: 'Polly.Joanna' }, cleanText || 'What else can I get for you?');
    }

    res.type('text/xml');
    res.send(twiml.toString());

  } catch (err) {
    console.error('AI Error:', err);
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice/process',
      method: 'POST',
      speechTimeout: 'auto'
    });
    gather.say({ voice: 'Polly.Joanna' }, 'Sorry, I did not catch that. What would you like to order?');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// REST API
app.get('/api/orders', (req, res) => res.json(orders));
app.get('/api/customers', (req, res) => res.json(Object.values(customers)));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Outwater Grill server running on port ${PORT}`));
