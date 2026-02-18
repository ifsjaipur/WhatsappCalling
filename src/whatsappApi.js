const axios = require('axios');
const config = require('./config');

const api = axios.create({
  baseURL: config.GRAPH_API_BASE,
  headers: {
    'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function enableCalling() {
  const url = `/${config.PHONE_NUMBER_ID}/settings`;
  const body = {
    calling: {
      status: 'ENABLED'
    }
  };

  console.log('[API] Enabling calling...');
  const res = await api.post(url, body);
  console.log('[API] Enable calling response:', res.data);
  return res.data;
}

async function disableCalling() {
  const url = `/${config.PHONE_NUMBER_ID}/settings`;
  const body = {
    calling: {
      status: 'DISABLED'
    }
  };

  console.log('[API] Disabling calling...');
  const res = await api.post(url, body);
  console.log('[API] Disable calling response:', res.data);
  return res.data;
}

async function sendCallPermissionRequest(recipientPhone, templateName = 'call_permission') {
  const url = `/${config.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en_US' },
      components: []
    }
  };

  console.log(`[API] Sending call permission request to ${recipientPhone}...`);
  const res = await api.post(url, body);
  console.log('[API] Permission request response:', res.data);
  return res.data;
}

async function initiateOutboundCall(recipientPhone, sdpOffer) {
  const url = `/${config.PHONE_NUMBER_ID}/calls`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    action: 'connect',
    session: {
      sdp: sdpOffer,
      sdp_type: 'offer'
    }
  };

  console.log(`[API] Initiating outbound call to ${recipientPhone}...`);
  const res = await api.post(url, body);
  console.log('[API] Initiate call response:', res.data);
  return res.data;
}

async function answerCall(callId, action, sdpAnswer = null) {
  const url = `/${config.PHONE_NUMBER_ID}/calls`;
  const body = {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: action // 'pre_accept' or 'accept'
  };

  if (action === 'accept' && sdpAnswer) {
    body.session = {
      sdp: sdpAnswer,
      sdp_type: 'answer'
    };
  }

  console.log(`[API] Answering call ${callId} with action=${action}...`);
  const res = await api.post(url, body);
  console.log('[API] Answer call response:', res.data);
  return res.data;
}

async function terminateCall(callId) {
  const url = `/${config.PHONE_NUMBER_ID}/calls`;
  const body = {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: 'terminate'
  };

  console.log(`[API] Terminating call ${callId}...`);
  const res = await api.post(url, body);
  console.log('[API] Terminate call response:', res.data);
  return res.data;
}

async function sendTextMessage(recipientPhone, text) {
  const url = `/${config.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: recipientPhone,
    type: 'text',
    text: { body: text }
  };

  console.log(`[API] Sending text to ${recipientPhone}...`);
  const res = await api.post(url, body);
  return res.data;
}

module.exports = {
  enableCalling,
  disableCalling,
  sendCallPermissionRequest,
  initiateOutboundCall,
  answerCall,
  terminateCall,
  sendTextMessage
};
