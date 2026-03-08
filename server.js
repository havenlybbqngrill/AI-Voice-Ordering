require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static('public'));

let orders = [];
let clients = [];

wss.on('connection', ws => {
  clients.push(ws);
  ws.send(JSON.stringify({ type: 'init', orders }));
  ws.on('close', () => {
    clients = clients.filter(c => c !== ws);
  });
});

app.get('/api/customers', (req, res) => {
  res.json([]);
});

app.post('/voice/incoming', (req, res) => {
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Welcome to Outwater Grill</Say></Response>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
