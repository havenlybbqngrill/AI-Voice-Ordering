require('dotenv').config();
const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post('/voice/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Thank you for calling Outwater Grill! Say your order please.');
  twiml.record({ maxLength: 60, transcribeCallback: '/transcribe' });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/transcribe', (req, res) => {
  console.log('Order:', req.body.SpeechResult);
  res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
