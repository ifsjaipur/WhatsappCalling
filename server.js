const config = require('./src/config');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const { verifyWebhook, validateSignature, handleWebhookEvent } = require('./src/webhookHandler');
const whatsappApi = require('./src/whatsappApi');
const callManager = require('./src/callManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Raw body capture for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Webhook routes ──

app.get('/webhook', verifyWebhook);

app.post('/webhook', validateSignature, (req, res) => {
  handleWebhookEvent(req, res, callManager, io);
});

// Forwarded webhook from n8n (no Meta signature - n8n already validated)
app.post('/webhook/forward', (req, res) => {
  const field = req.body?.entry?.[0]?.changes?.[0]?.field;
  console.log(`[Webhook] Forwarded from n8n (field: ${field})`);
  handleWebhookEvent(req, res, callManager, io);
});

// ── API routes ──

app.post('/api/enable-calling', async (req, res) => {
  try {
    const result = await whatsappApi.enableCalling();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] Enable calling error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/disable-calling', async (req, res) => {
  try {
    const result = await whatsappApi.disableCalling();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] Disable calling error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/send-permission', async (req, res) => {
  try {
    const { phone, templateName } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const result = await whatsappApi.sendCallPermissionRequest(phone, templateName);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] Send permission error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/initiate-call', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    // Pick the first connected socket so SDP request goes to one client only
    const sockets = await io.fetchSockets();
    const socket = sockets[0] || null;
    const result = await callManager.startOutboundCall(phone, io, socket);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] Initiate call error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/accept-call', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    await callManager.acceptInboundCall(callId, io);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Accept call error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/reject-call', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    await callManager.rejectInboundCall(callId, io);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Reject call error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/end-call', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    await callManager.endCall(callId, io);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] End call error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.get('/api/permission-status/:phone', (req, res) => {
  const status = callManager.getPermissionStatus(req.params.phone);
  res.json(status);
});

app.get('/api/calls', (req, res) => {
  res.json(callManager.getAllCalls());
});

app.post('/api/reset-calls', (req, res) => {
  const count = callManager.resetCalls(io);
  res.json({ success: true, reset: count });
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

    const result = await whatsappApi.sendTextMessage(phone, message);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API] Send message error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ── Socket.IO ──

io.on('connection', (socket) => {
  console.log('[Socket.IO] Client connected:', socket.id);

  socket.on('browser-offer', async (data) => {
    try {
      await callManager.handleBrowserSdpOffer(data.callId, data.sdp, io);
    } catch (err) {
      console.error('[Socket.IO] browser-offer error:', err.message);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('browser-answer', async (data) => {
    try {
      await callManager.handleBrowserSdpAnswer(data.callId, data.sdp, io);
    } catch (err) {
      console.error('[Socket.IO] browser-answer error:', err.message);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('accept-call', async (data) => {
    try {
      await callManager.acceptInboundCall(data.callId, io, socket);
    } catch (err) {
      console.error('[Socket.IO] accept-call error:', err.message);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('reject-call', async (data) => {
    try {
      await callManager.rejectInboundCall(data.callId, io);
    } catch (err) {
      console.error('[Socket.IO] reject-call error:', err.message);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('end-call', async (data) => {
    try {
      await callManager.endCall(data.callId, io);
    } catch (err) {
      console.error('[Socket.IO] end-call error:', err.message);
      socket.emit('error', { message: err.message });
    }
  });

  // For browser-only mode: manually grant permission (testing)
  socket.on('grant-permission', (data) => {
    callManager.handlePermissionGranted(data.phone, io);
  });

  socket.on('disconnect', () => {
    console.log('[Socket.IO] Client disconnected:', socket.id);
  });
});

// ── Start ──

server.listen(config.PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`WhatsApp Calling Demo Server`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Server:    http://localhost:${config.PORT}`);
  console.log(`Webhook:   https://<your-domain>/webhook`);
  console.log(`Phone ID:  ${config.PHONE_NUMBER_ID}`);
  console.log(`API Ver:   ${config.GRAPH_API_VERSION}`);
  console.log(`WebRTC:    ${require('./src/webrtcBridge').isAvailable() ? 'Server-side (Node.js)' : 'Browser-only mode'}`);
  console.log(`${'='.repeat(50)}\n`);
});
