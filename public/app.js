const socket = io();

let currentCallId = null;
let localStream = null;
let peerConnection = null;
let callTimer = null;
let callStartTime = null;

// ── Socket.IO Connection Status ──

socket.on('connect', () => {
  const el = document.getElementById('connectionStatus');
  el.textContent = 'Connected';
  el.className = 'connection-status connected';
  log('Socket.IO connected', 'info');
});

socket.on('disconnect', () => {
  const el = document.getElementById('connectionStatus');
  el.textContent = 'Disconnected';
  el.className = 'connection-status disconnected';
  log('Socket.IO disconnected', 'error');
});

// ── Socket.IO Call Events ──

socket.on('permission-granted', (data) => {
  log(`Permission granted for ${data.phone} (expires: ${data.expiresAt})`, 'event');
  showStatus('permissionStatus', `Permission granted! Valid until ${new Date(data.expiresAt).toLocaleString()}`, 'success');
});

socket.on('call-ringing', (data) => {
  log(`Call ${data.callId} ringing at ${data.phone}`, 'event');
  showStatus('callStatus', 'Ringing...', 'warning');
  currentCallId = data.callId;
});

socket.on('call-accepted', (data) => {
  log(`Call ${data.callId} accepted by ${data.phone}`, 'event');
  showStatus('callStatus', 'Call accepted, establishing audio...', 'info');
});

socket.on('call-connected', (data) => {
  log(`Call ${data.callId} connected!`, 'event');
  showStatus('callStatus', 'Call connected - audio active', 'active');
  document.getElementById('callControls').style.display = 'flex';
  document.getElementById('inboundCard').style.display = 'none';
  startCallTimer();
});

socket.on('call-rejected', (data) => {
  log(`Call ${data.callId} rejected`, 'error');
  showStatus('callStatus', 'Call rejected by user', 'error');
  cleanupCall();
});

socket.on('call-ended', (data) => {
  log(`Call ${data.callId} ended`, 'event');
  showStatus('callStatus', 'Call ended', 'info');
  document.getElementById('inboundCard').style.display = 'none';
  cleanupCall();
});

socket.on('call-incoming', (data) => {
  log(`Incoming call from ${data.from} (${data.callId})`, 'event');
  currentCallId = data.callId;
  document.getElementById('inboundCard').style.display = 'block';
  document.getElementById('inboundInfo').innerHTML =
    `<div class="status-bar warning">Incoming call from <strong>${data.from}</strong></div>`;
  // Play a simple ringtone beep to get attention
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 440;
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) { /* ignore audio context errors */ }
});

socket.on('call-status', (data) => {
  log(`Call ${data.callId} status: ${data.status}`, 'info');
});

// Browser-only mode: server asks browser to generate SDP offer
socket.on('generate-sdp-offer', async (data) => {
  log(`Generating SDP offer for call ${data.callId}...`, 'api');
  currentCallId = data.callId;

  try {
    await setupBrowserWebRTC();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Wait for ICE gathering
    await waitForIceGathering(peerConnection);

    socket.emit('browser-offer', {
      callId: data.callId,
      sdp: peerConnection.localDescription.sdp
    });
    log('SDP offer sent to server', 'api');
  } catch (err) {
    log(`Error generating SDP: ${err.message}`, 'error');
  }
});

// Browser-only mode: SDP answer from WhatsApp
socket.on('sdp-answer-from-whatsapp', async (data) => {
  log(`Received SDP answer from WhatsApp for call ${data.callId}`, 'event');
  try {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: data.sdp })
      );
      log('Remote SDP answer set - audio should be active', 'event');
    }
  } catch (err) {
    log(`Error setting SDP answer: ${err.message}`, 'error');
  }
});

// Server WebRTC mode: server asks browser to set up audio bridge
socket.on('setup-browser-audio', async (data) => {
  log(`Setting up browser audio for call ${data.callId}...`, 'api');
  try {
    await setupBrowserWebRTC();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    await waitForIceGathering(peerConnection);

    socket.emit('browser-offer', {
      callId: data.callId,
      sdp: peerConnection.localDescription.sdp
    });
  } catch (err) {
    log(`Error setting up browser audio: ${err.message}`, 'error');
  }
});

// Server sends SDP answer for browser peer
socket.on('browser-sdp-answer', async (data) => {
  try {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: data.sdp })
      );
      log('Browser audio bridge established', 'event');
    }
  } catch (err) {
    log(`Error with browser SDP answer: ${err.message}`, 'error');
  }
});

// Inbound call: SDP offer from WhatsApp forwarded to browser
socket.on('inbound-sdp-offer', async (data) => {
  log(`Setting up audio for inbound call ${data.callId}...`, 'api');
  try {
    await setupBrowserWebRTC();
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp: data.sdp })
    );
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await waitForIceGathering(peerConnection);

    socket.emit('browser-answer', {
      callId: data.callId,
      sdp: peerConnection.localDescription.sdp
    });
  } catch (err) {
    log(`Error handling inbound SDP: ${err.message}`, 'error');
  }
});

socket.on('webhook-event', (data) => {
  log(`Webhook: ${data.type} - ${JSON.stringify(data.data).substring(0, 100)}`, 'info');
});

socket.on('calls-reset', (data) => {
  log(`${data.count} stuck call(s) reset`, 'event');
  showStatus('callStatus', 'Calls reset. You can make a new call.', 'success');
  document.getElementById('btnCall').disabled = false;
});

socket.on('error', (data) => {
  log(`Server error: ${data.message}`, 'error');
});

// ── WebRTC Setup ──

async function setupBrowserWebRTC() {
  // Get microphone
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  log('Microphone access granted', 'info');

  // Create peer connection
  peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });

  // Add local audio tracks
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Handle remote audio
  peerConnection.ontrack = (event) => {
    log('Remote audio track received', 'event');
    document.getElementById('remoteAudio').srcObject = event.streams[0];
  };

  peerConnection.oniceconnectionstatechange = () => {
    log(`ICE state: ${peerConnection.iceConnectionState}`, 'info');
  };

  peerConnection.onconnectionstatechange = () => {
    log(`Connection state: ${peerConnection.connectionState}`, 'info');
  };
}

function waitForIceGathering(pc, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();

    const timeout = setTimeout(() => {
      log('ICE gathering timed out, using current candidates', 'info');
      resolve();
    }, timeoutMs);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    };
  });
}

// ── API Calls ──

async function enableCalling() {
  const btn = document.getElementById('btnEnableCalling');
  btn.disabled = true;
  log('Enabling calling...', 'api');

  try {
    const res = await fetch('/api/enable-calling', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showStatus('enableStatus', 'Calling enabled successfully!', 'success');
      log('Calling enabled', 'event');
    } else {
      showStatus('enableStatus', `Error: ${JSON.stringify(data.error)}`, 'error');
      log(`Enable calling error: ${JSON.stringify(data.error)}`, 'error');
    }
  } catch (err) {
    showStatus('enableStatus', `Error: ${err.message}`, 'error');
    log(`Enable calling error: ${err.message}`, 'error');
  }

  btn.disabled = false;
}

async function disableCalling() {
  try {
    const res = await fetch('/api/disable-calling', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showStatus('enableStatus', 'Calling disabled', 'info');
      log('Calling disabled', 'event');
    } else {
      showStatus('enableStatus', `Error: ${JSON.stringify(data.error)}`, 'error');
    }
  } catch (err) {
    showStatus('enableStatus', `Error: ${err.message}`, 'error');
  }
}

async function sendPermission() {
  const phone = document.getElementById('permissionPhone').value.trim();
  const template = document.getElementById('templateName').value.trim() || undefined;

  if (!phone) {
    showStatus('permissionStatus', 'Please enter a phone number', 'warning');
    return;
  }

  log(`Sending permission request to ${phone}...`, 'api');

  try {
    const res = await fetch('/api/send-permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, templateName: template })
    });
    const data = await res.json();
    if (data.success) {
      showStatus('permissionStatus', `Permission request sent to ${phone}. Waiting for user to accept...`, 'info');
      log(`Permission request sent to ${phone}`, 'event');
    } else {
      showStatus('permissionStatus', `Error: ${JSON.stringify(data.error)}`, 'error');
      log(`Permission request error: ${JSON.stringify(data.error)}`, 'error');
    }
  } catch (err) {
    showStatus('permissionStatus', `Error: ${err.message}`, 'error');
  }
}

async function checkPermission() {
  const phone = document.getElementById('checkPermPhone').value.trim();
  if (!phone) {
    showStatus('checkPermStatus', 'Please enter a phone number', 'warning');
    return;
  }

  try {
    const res = await fetch(`/api/permission-status/${phone}`);
    const data = await res.json();
    if (data.granted) {
      showStatus('checkPermStatus',
        `Permission GRANTED. Expires: ${data.expiresAt} (${data.remainingHours}h remaining)`, 'success');
    } else if (data.expired) {
      showStatus('checkPermStatus', 'Permission EXPIRED. Send a new request.', 'warning');
    } else {
      showStatus('checkPermStatus', 'No permission. Send a request first.', 'info');
    }
  } catch (err) {
    showStatus('checkPermStatus', `Error: ${err.message}`, 'error');
  }
}

function manualGrantPermission() {
  const phone = document.getElementById('checkPermPhone').value.trim();
  if (!phone) {
    showStatus('checkPermStatus', 'Please enter a phone number', 'warning');
    return;
  }
  socket.emit('grant-permission', { phone });
  showStatus('checkPermStatus', `Permission manually granted for ${phone} (testing only)`, 'success');
  log(`Manual permission grant for ${phone}`, 'info');
}

async function initiateCall() {
  const phone = document.getElementById('callPhone').value.trim();
  if (!phone) {
    showStatus('callStatus', 'Please enter a phone number', 'warning');
    return;
  }

  document.getElementById('btnCall').disabled = true;
  log(`Initiating call to ${phone}...`, 'api');
  showStatus('callStatus', 'Initiating call...', 'info');

  try {
    const res = await fetch('/api/initiate-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.success) {
      currentCallId = data.data.callId;
      log(`Call initiated: ${currentCallId}`, 'event');
      if (data.data.mode === 'browser-only') {
        showStatus('callStatus', 'Browser-only mode: generating SDP...', 'info');
      }
    } else {
      const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
      // If stuck call, show reset option
      if (errMsg.includes('already in progress')) {
        showStatus('callStatus', `${errMsg} <button onclick="resetCalls()" style="margin-left:8px;padding:2px 10px;cursor:pointer;">Reset &amp; Retry</button>`, 'error');
      } else {
        showStatus('callStatus', `Error: ${errMsg}`, 'error');
      }
      log(`Call error: ${errMsg}`, 'error');
      document.getElementById('btnCall').disabled = false;
    }
  } catch (err) {
    showStatus('callStatus', `Error: ${err.message}`, 'error');
    document.getElementById('btnCall').disabled = false;
  }
}

async function endCall() {
  if (!currentCallId) return;

  log(`Ending call ${currentCallId}...`, 'api');
  try {
    await fetch('/api/end-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: currentCallId })
    });
  } catch (err) {
    log(`End call error: ${err.message}`, 'error');
  }

  cleanupCall();
}

function acceptInboundCall() {
  if (!currentCallId) return;
  log(`Accepting call ${currentCallId}...`, 'api');
  showStatus('callStatus', 'Accepting incoming call...', 'info');
  socket.emit('accept-call', { callId: currentCallId });
  document.getElementById('inboundCard').style.display = 'none';
}

function rejectInboundCall() {
  if (!currentCallId) return;
  log(`Rejecting call ${currentCallId}...`, 'api');
  socket.emit('reject-call', { callId: currentCallId });
  document.getElementById('inboundCard').style.display = 'none';
  cleanupCall();
}

async function resetCalls() {
  log('Resetting stuck calls...', 'api');
  try {
    const res = await fetch('/api/reset-calls', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      log(`Reset ${data.reset} call(s)`, 'event');
      cleanupCall();
    }
  } catch (err) {
    log(`Reset error: ${err.message}`, 'error');
  }
}

async function sendMessage() {
  const phone = document.getElementById('msgPhone').value.trim();
  const message = document.getElementById('msgText').value.trim();

  if (!phone || !message) {
    showStatus('msgStatus', 'Please enter phone and message', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message })
    });
    const data = await res.json();
    if (data.success) {
      showStatus('msgStatus', 'Message sent!', 'success');
      log(`Message sent to ${phone}`, 'event');
    } else {
      showStatus('msgStatus', `Error: ${JSON.stringify(data.error)}`, 'error');
    }
  } catch (err) {
    showStatus('msgStatus', `Error: ${err.message}`, 'error');
  }
}

// ── Helpers ──

function cleanupCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }

  currentCallId = null;
  document.getElementById('callControls').style.display = 'none';
  document.getElementById('btnCall').disabled = false;
  document.getElementById('callDuration').textContent = '';
  document.getElementById('remoteAudio').srcObject = null;
}

function startCallTimer() {
  callStartTime = Date.now();
  callTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const sec = String(elapsed % 60).padStart(2, '0');
    document.getElementById('callDuration').textContent = `${min}:${sec}`;
  }, 1000);
}

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.innerHTML = `<div class="status-bar ${type}">${message}</div>`;
}

function log(message, type = 'info') {
  const logEl = document.getElementById('eventLog');
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="time">[${time}]</span> ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  document.getElementById('eventLog').innerHTML = '';
}

// Auto-populate phone fields from each other
document.getElementById('permissionPhone').addEventListener('input', (e) => {
  document.getElementById('callPhone').value = e.target.value;
  document.getElementById('checkPermPhone').value = e.target.value;
  document.getElementById('msgPhone').value = e.target.value;
});
