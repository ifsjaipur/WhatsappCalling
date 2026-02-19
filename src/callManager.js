const whatsappApi = require('./whatsappApi');
const webrtcBridge = require('./webrtcBridge');

// In-memory call state
const calls = new Map();       // callId -> CallState
const permissions = new Map(); // phone -> { grantedAt, expiresAt }

function getCallState(callId) {
  return calls.get(callId);
}

function getAllCalls() {
  return Array.from(calls.entries()).map(([id, state]) => ({
    callId: id,
    status: state.status,
    direction: state.direction,
    phone: state.recipientPhone,
    createdAt: state.createdAt
  }));
}

function getPermissionStatus(phone) {
  const perm = permissions.get(phone);
  if (!perm) return { granted: false };

  const now = Date.now();
  if (now > perm.expiresAt) {
    permissions.delete(phone);
    return { granted: false, expired: true };
  }

  return {
    granted: true,
    grantedAt: new Date(perm.grantedAt).toISOString(),
    expiresAt: new Date(perm.expiresAt).toISOString(),
    remainingHours: Math.round((perm.expiresAt - now) / 3600000)
  };
}

function handlePermissionGranted(phone, io) {
  const grantedAt = Date.now();
  const expiresAt = grantedAt + (72 * 60 * 60 * 1000); // 72 hours

  permissions.set(phone, { grantedAt, expiresAt });

  console.log(`[CallManager] Permission granted for ${phone}, expires in 72 hours`);

  io.emit('permission-granted', {
    phone,
    grantedAt: new Date(grantedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  });
}

async function startOutboundCall(phone, io, socket) {
  // Check permission
  const permStatus = getPermissionStatus(phone);
  if (!permStatus.granted) {
    throw new Error(
      permStatus.expired
        ? 'Call permission has expired. Send a new permission request.'
        : 'No call permission for this number. Send a permission request first.'
    );
  }

  // Block if there's already an active outbound call (auto-expire stale ones)
  const STALE_TIMEOUT = 30 * 1000; // 30 seconds
  for (const [id, s] of calls) {
    if (s.direction === 'outbound' && ['awaiting_browser_sdp', 'ringing', 'accepted', 'connected'].includes(s.status)) {
      const age = Date.now() - new Date(s.createdAt).getTime();
      if (s.status === 'awaiting_browser_sdp' && age > STALE_TIMEOUT) {
        console.log(`[CallManager] Auto-expiring stale call ${id} (stuck in ${s.status} for ${Math.round(age/1000)}s)`);
        s.status = 'expired';
        cleanup(id);
        continue;
      }
      throw new Error(`An outbound call is already in progress (${id}, status: ${s.status})`);
    }
  }

  if (webrtcBridge.isAvailable()) {
    return startOutboundCallWithServerWebRTC(phone, io);
  } else {
    return startOutboundCallBrowserOnly(phone, io, socket);
  }
}

async function startOutboundCallWithServerWebRTC(phone, io) {
  // Create WebRTC peer connection for WhatsApp side
  const whatsappPeer = webrtcBridge.createPeerConnection('wa-outbound');

  // Generate SDP offer
  const sdpOffer = await webrtcBridge.createOfferSdp(whatsappPeer);

  // Send to WhatsApp via Graph API
  const result = await whatsappApi.initiateOutboundCall(phone, sdpOffer);
  // API returns { calls: [{ id: "wacid..." }], success: true }
  const callId = result.calls?.[0]?.id || result.call_id || result.id || `call_${Date.now()}`;

  const state = {
    callId,
    direction: 'outbound',
    recipientPhone: phone,
    status: 'ringing',
    whatsappPeer,
    browserPeer: null,
    createdAt: new Date()
  };

  calls.set(callId, state);

  io.emit('call-ringing', { callId, phone });
  console.log(`[CallManager] Outbound call ${callId} initiated to ${phone}`);

  return { callId, status: 'ringing' };
}

async function startOutboundCallBrowserOnly(phone, io, socket) {
  const callId = `call_${Date.now()}`;

  const state = {
    callId,
    direction: 'outbound',
    recipientPhone: phone,
    status: 'awaiting_browser_sdp',
    socketId: socket?.id || null,
    whatsappPeer: null,
    browserPeer: null,
    createdAt: new Date()
  };

  calls.set(callId, state);

  // Send ONLY to the socket that initiated the call, not all clients
  if (socket) {
    socket.emit('generate-sdp-offer', { callId, phone });
  } else {
    io.emit('generate-sdp-offer', { callId, phone });
  }
  console.log(`[CallManager] Browser-only mode: waiting for browser SDP for call ${callId} (socket: ${socket?.id || 'broadcast'})`);

  return { callId, status: 'awaiting_browser_sdp', mode: 'browser-only' };
}

async function handleBrowserSdpOffer(callId, sdpOffer, io) {
  const state = calls.get(callId);
  if (!state) {
    console.warn(`[CallManager] No call state for ${callId}`);
    return;
  }

  // Prevent double call initiation
  if (state.status === 'ringing' || state.status === 'connected') {
    console.warn(`[CallManager] Call ${callId} already in progress (${state.status}), ignoring duplicate SDP offer`);
    return;
  }

  try {
    // Browser provided SDP offer - forward to WhatsApp
    console.log(`[CallManager] Sending SDP offer to WhatsApp API for ${state.recipientPhone}...`);
    const result = await whatsappApi.initiateOutboundCall(state.recipientPhone, sdpOffer);
    // API returns { calls: [{ id: "wacid..." }], success: true }
    const waCallId = result.calls?.[0]?.id || result.call_id || result.id || callId;
    state.callId = waCallId;
    state.status = 'ringing';
    console.log(`[CallManager] WhatsApp call ID mapped: ${callId} -> ${waCallId}`);

    // Update map with new callId if different
    if (state.callId !== callId) {
      calls.delete(callId);
      calls.set(state.callId, state);
    }

    io.emit('call-ringing', { callId: state.callId, phone: state.recipientPhone });
    console.log(`[CallManager] Browser SDP forwarded, call ${state.callId} ringing`);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error(`[CallManager] WhatsApp API error for call ${callId}: ${errMsg}`, err.response?.data || '');
    state.status = 'failed';
    cleanup(callId);
    io.emit('call-error', { callId, error: errMsg });
  }
}

async function handleOutboundSdpAnswer(callId, sdpAnswer, io) {
  let state = calls.get(callId);

  // Fallback: if callId not found, search by active outbound call
  if (!state) {
    console.log(`[CallManager] Exact callId not found, searching active outbound calls...`);
    for (const [id, s] of calls) {
      if (s.direction === 'outbound' && (s.status === 'ringing' || s.status === 'accepted')) {
        console.log(`[CallManager] Found matching outbound call: ${id}`);
        state = s;
        // Update the map with the correct callId
        calls.delete(id);
        state.callId = callId;
        calls.set(callId, state);
        break;
      }
    }
  }

  if (!state) {
    console.warn(`[CallManager] No call state for outbound SDP answer: ${callId}`);
    return;
  }

  console.log(`[CallManager] Received SDP answer for outbound call ${callId}`);
  state.status = 'connected';

  // Target SDP events to the specific socket that started the call
  const targetEmit = state.socketId ? (event, data) => {
    io.to(state.socketId).emit(event, data);
  } : (event, data) => {
    io.emit(event, data);
  };

  if (state.whatsappPeer) {
    // Server WebRTC mode - set remote description
    await webrtcBridge.setRemoteAnswer(state.whatsappPeer, sdpAnswer);
    console.log(`[CallManager] WebRTC connected to WhatsApp for call ${callId}`);

    // Signal browser to set up audio
    targetEmit('setup-browser-audio', { callId });
  } else {
    // Browser-only mode - forward SDP answer to browser
    targetEmit('sdp-answer-from-whatsapp', { callId, sdp: sdpAnswer });
  }

  // Broadcast call-connected to all clients (status update)
  io.emit('call-connected', { callId, phone: state.recipientPhone });
}

function handleOutboundStatus(callId, statusValue, io) {
  let state = calls.get(callId);

  // Fallback: search by active outbound call
  if (!state) {
    for (const [, s] of calls) {
      if (s.direction === 'outbound' && ['ringing', 'accepted', 'awaiting_browser_sdp'].includes(s.status)) {
        state = s;
        break;
      }
    }
  }

  if (!state) {
    console.warn(`[CallManager] No call state for status: ${callId}`);
    return;
  }

  console.log(`[CallManager] Call ${callId} status: ${statusValue}`);

  switch (statusValue) {
    case 'ringing':
      state.status = 'ringing';
      io.emit('call-ringing', { callId, phone: state.recipientPhone });
      break;
    case 'accepted':
      state.status = 'accepted';
      io.emit('call-accepted', { callId, phone: state.recipientPhone });
      break;
    case 'rejected':
      state.status = 'rejected';
      io.emit('call-rejected', { callId, phone: state.recipientPhone });
      cleanup(callId);
      break;
    default:
      io.emit('call-status', { callId, status: statusValue });
  }
}

async function handleInboundCall(callId, from, sdpOffer, io) {
  console.log(`[CallManager] Inbound call ${callId} from ${from}`);

  const state = {
    callId,
    direction: 'inbound',
    recipientPhone: from,
    status: 'incoming',
    whatsappSdpOffer: sdpOffer,
    whatsappPeer: null,
    browserPeer: null,
    createdAt: new Date()
  };

  calls.set(callId, state);

  io.emit('call-incoming', { callId, from, timestamp: new Date().toISOString() });
}

async function acceptInboundCall(callId, io, socket) {
  const state = calls.get(callId);
  if (!state || state.direction !== 'inbound') {
    throw new Error('No inbound call to accept');
  }

  state.status = 'accepting';
  const emit = socket ? socket.emit.bind(socket) : io.emit.bind(io);

  if (webrtcBridge.isAvailable()) {
    // Server WebRTC mode
    const whatsappPeer = webrtcBridge.createPeerConnection('wa-inbound');
    state.whatsappPeer = whatsappPeer;

    // Create SDP answer from the WhatsApp SDP offer
    let sdpAnswer = await webrtcBridge.createAnswerSdp(whatsappPeer, state.whatsappSdpOffer);
    sdpAnswer = webrtcBridge.filterSdpForWhatsApp(sdpAnswer);

    // Step 1: Send pre_accept with SDP answer
    await whatsappApi.answerCall(callId, 'pre_accept', sdpAnswer);
    state.status = 'pre_accepted';

    // Step 2: Send accept with SDP answer
    await whatsappApi.answerCall(callId, 'accept', sdpAnswer);
    state.status = 'connected';

    emit('setup-browser-audio', { callId });
    io.emit('call-connected', { callId, phone: state.recipientPhone });
  } else {
    // Browser-only mode - forward SDP offer to browser for SDP answer generation
    // Browser will generate the answer, then handleBrowserSdpAnswer will send pre_accept + accept
    emit('inbound-sdp-offer', { callId, sdp: state.whatsappSdpOffer });
  }
}

async function handleBrowserSdpAnswer(callId, sdpAnswer, io) {
  const state = calls.get(callId);
  if (!state) return;

  if (state.direction === 'inbound' && !webrtcBridge.isAvailable()) {
    // Browser-only mode: browser generated answer for inbound call
    const filteredSdp = webrtcBridge.filterSdpForWhatsApp(sdpAnswer);

    // Step 1: pre_accept with SDP answer (establishes media connection)
    await whatsappApi.answerCall(callId, 'pre_accept', filteredSdp);
    state.status = 'pre_accepted';
    console.log(`[CallManager] Inbound call ${callId} pre_accepted`);

    // Step 2: accept with SDP answer (formally answers the call)
    await whatsappApi.answerCall(callId, 'accept', filteredSdp);
    state.status = 'connected';
    console.log(`[CallManager] Inbound call ${callId} accepted and connected`);

    io.emit('call-connected', { callId, phone: state.recipientPhone });
  } else if (state.whatsappPeer) {
    // Server mode: browser answer for the browser-facing peer connection
    const browserPeer = state.browserPeer;
    if (browserPeer) {
      await webrtcBridge.setRemoteAnswer(browserPeer, sdpAnswer);
    }
  }
}

function handleTerminate(callId, io) {
  const state = calls.get(callId);
  if (!state) {
    console.log(`[CallManager] Terminate for unknown call ${callId}`);
    return;
  }

  console.log(`[CallManager] Call ${callId} terminated`);
  state.status = 'terminated';
  io.emit('call-ended', { callId, phone: state.recipientPhone });
  cleanup(callId);
}

async function rejectInboundCall(callId, io) {
  const state = calls.get(callId);
  if (!state || state.direction !== 'inbound') {
    throw new Error('No inbound call to reject');
  }

  try {
    await whatsappApi.rejectCall(callId);
  } catch (e) {
    console.warn(`[CallManager] Error rejecting call: ${e.message}`);
  }

  state.status = 'rejected';
  io.emit('call-ended', { callId, phone: state.recipientPhone });
  cleanup(callId);
}

async function endCall(callId, io) {
  const state = calls.get(callId);
  if (!state) throw new Error('No active call');

  try {
    await whatsappApi.terminateCall(callId);
  } catch (e) {
    console.warn(`[CallManager] Error terminating call: ${e.message}`);
  }

  state.status = 'terminated';
  io.emit('call-ended', { callId });
  cleanup(callId);
}

function cleanup(callId) {
  const state = calls.get(callId);
  if (!state) return;

  if (state.whatsappPeer) {
    try { state.whatsappPeer.close(); } catch (e) { /* ignore */ }
  }
  if (state.browserPeer) {
    try { state.browserPeer.close(); } catch (e) { /* ignore */ }
  }

  // Keep in map for 5 minutes for status queries, then remove
  setTimeout(() => calls.delete(callId), 5 * 60 * 1000);
}

function resetCalls(io) {
  let count = 0;
  for (const [id, s] of calls) {
    if (['awaiting_browser_sdp', 'ringing', 'accepted', 'incoming'].includes(s.status)) {
      s.status = 'reset';
      cleanup(id);
      count++;
    }
  }
  if (io) io.emit('calls-reset', { count });
  console.log(`[CallManager] Reset ${count} stuck call(s)`);
  return count;
}

module.exports = {
  getCallState,
  getAllCalls,
  getPermissionStatus,
  handlePermissionGranted,
  startOutboundCall,
  handleBrowserSdpOffer,
  handleOutboundSdpAnswer,
  handleOutboundStatus,
  handleInboundCall,
  acceptInboundCall,
  rejectInboundCall,
  handleBrowserSdpAnswer,
  handleTerminate,
  endCall,
  resetCalls
};
