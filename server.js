require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuration
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || "").split(',');

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// In-memory cache for cross-webhook stitching
const memoryCache = new Map();
function cacheSet(key, value, ttlSeconds = 15) {
    memoryCache.set(key, value);
    setTimeout(() => memoryCache.delete(key), ttlSeconds * 1000);
}
function cacheGet(key) { return memoryCache.get(key); }
function cacheDelete(key) { memoryCache.delete(key); }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// ==========================================
// 1. WEBHOOK VERIFICATION (GET)
// ==========================================
app.get('/whatsapp-webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).send("Forbidden");
});

// ==========================================
// 2. INCOMING MESSAGES (POST)
// ==========================================
app.post('/whatsapp-webhook', (req, res) => {
    // ALWAYS return 200 OK immediately to decouple and prevent Meta timeout
    res.status(200).send({ status: "success" });
    
    // Process async
    processWebhook(req.body).catch(console.error);
});

async function processWebhook(data) {
    if (data.object !== 'whatsapp_business_account') return;
    const entry = data.entry[0];
    
    for (let i = 0; i < entry.changes.length; i++) {
        const change = entry.changes[i];
        const value = change.value;
        
        // --- A. STATUSES WEBHOOK (Gives us Customer ID for human takeover) ---
        if (change.field === 'statuses' || value.statuses) {
            const statusList = value.statuses;
            if (statusList && statusList.length > 0) {
                const statusObj = statusList[0];
                if (statusObj.status === 'sent') {
                    const targetId = statusObj.recipient_id;
                    const aiSent = cacheGet(`ai_sent_${targetId}`);
                    
                    // If AI didn't send it, human did!
                    if (!aiSent && targetId) {
                        cacheSet(`last_paused_target`, targetId, 15);
                        const orphanedText = cacheGet(`orphan_echo`);
                        if (orphanedText) {
                            await pauseAI(targetId, orphanedText);
                            cacheDelete(`orphan_echo`);
                        } else {
                            const isPaused = await checkIsPaused(targetId);
                            if (!isPaused) {
                                await pauseAI(targetId, "[Human agent took over conversation]");
                            }
                        }
                    }
                }
            }
        }
        
        // --- B. MESSAGES / ECHOES WEBHOOK ---
        if (change.field === 'messages' || change.field === 'smb_message_echoes' || change.field === 'message_echoes') {
            const messageList = value.messages || value.message_echoes || value.smb_message_echoes;
            if (messageList && messageList.length > 0) {
                const messageObj = messageList[0];
                
                if (messageObj.type === 'text' || messageObj.type === 'image') {
                    let textBody = "";
                    let isImage = false;
                    
                    if (messageObj.type === 'text') {
                        textBody = messageObj.text.body;
                    } else if (messageObj.type === 'image') {
                        isImage = true;
                        textBody = messageObj.image.caption || "";
                    }
                    
                    const isEcho = (change.field === 'smb_message_echoes' || change.field === 'message_echoes' || messageObj.from_me === true);
                    
                    if (isEcho) {
                        // Human is typing
                        let targetId = messageObj.to;
                        if (!targetId && value.contacts && value.contacts.length > 0) {
                            targetId = value.contacts[0].wa_id;
                        }
                        
                        if (targetId) {
                            await pauseAI(targetId, isImage ? `[Human agent sent an image: ${textBody}]` : textBody);
                        } else {
                            const lastTarget = cacheGet(`last_paused_target`);
                            if (lastTarget) {
                                await appendHistory(lastTarget, "model", isImage ? `[Human agent sent an image: ${textBody}]` : textBody);
                            } else {
                                cacheSet(`orphan_echo`, isImage ? `[Human agent sent an image: ${textBody}]` : textBody, 15);
                            }
                        }
                    } else {
                        // Customer or Admin is typing
                        const senderId = messageObj.from;
                        
                        // 1. Check for Admin Training Command
                        if (!isImage && ADMIN_NUMBERS.includes(senderId) && (textBody.toLowerCase().startsWith('!learn') || textBody.toLowerCase().startsWith('!rule'))) {
                            await handleAdminCommand(senderId, textBody);
                            return;
                        }
                        
                        // 2. Normal Customer Message
                        const isPaused = await checkIsPaused(senderId);
                        
                        let contextToSave = textBody;
                        if (isImage) {
                            console.log(`[Image Received] Analyzing image from ${senderId}...`);
                            const mediaData = await downloadMetaMedia(messageObj.image.id);
                            if (mediaData) {
                                const description = await analyzeImage(mediaData.base64Data, mediaData.mimeType, textBody);
                                contextToSave = `[Customer sent an image: ${description}]`;
                            } else {
                                contextToSave = `[Customer sent an image, but it could not be downloaded] ${textBody}`;
                            }
                        }
                        
                        if (isPaused) {
                            await appendHistory(senderId, "user", contextToSave);
                        } else {
                            await appendHistory(senderId, "user", contextToSave);
                            const geminiReply = await callGemini(senderId);
                            if (geminiReply) {
                                // Realistic typing delay: 2s base + 30ms per char (Max 12 seconds)
                                const delayMs = Math.min(2000 + (geminiReply.length * 30), 12000);
                                console.log(`[Typing Delay] Waiting ${delayMs/1000} seconds...`);
                                await sleep(delayMs);
                                
                                await sendWhatsAppMessage(senderId, geminiReply);
                            }
                        }
                    }
                }
            }
        }
    }
}

// ==========================================
// 3. DATABASE MEMORY LOGIC
// ==========================================
async function getHistory(senderId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('role, message_text')
        .eq('phone_number', senderId)
        .order('created_at', { ascending: false })
        .limit(20);
        
    if (error) {
        console.error("Supabase Error (getHistory):", error);
        return [];
    }
    
    // Reverse so oldest is first
    return data.reverse().map(row => ({
        role: row.role,
        parts: [{ text: row.message_text }]
    }));
}

async function appendHistory(senderId, role, text) {
    await supabase.from('conversations').insert([
        { phone_number: senderId, role: role, message_text: text }
    ]);
}

async function checkIsPaused(senderId) {
    const { data } = await supabase
        .from('pause_state')
        .select('paused_until')
        .eq('phone_number', senderId)
        .single();
        
    if (data && data.paused_until) {
        const pausedUntil = new Date(data.paused_until);
        if (pausedUntil > new Date()) {
            return true;
        }
    }
    return false;
}

async function pauseAI(senderId, humanMessage) {
    // Pause for 1 hour
    const pausedUntil = new Date();
    pausedUntil.setHours(pausedUntil.getHours() + 1);
    
    await supabase.from('pause_state').upsert({
        phone_number: senderId,
        paused_until: pausedUntil.toISOString()
    });
    
    await appendHistory(senderId, "model", humanMessage);
    console.log(`[Auto-Pause] Paused AI for ${senderId}. Saved human context.`);
}

async function handleAdminCommand(adminId, commandText) {
    const rule = commandText.replace(/^!(learn|rule)\s*/i, '');
    await supabase.from('rules').insert([
        { rule_text: rule }
    ]);
    await sendWhatsAppMessage(adminId, `✅ Rule successfully added to Selena's brain:\n"${rule}"`);
    console.log(`[Admin Command] Added rule: ${rule}`);
}

async function buildSystemPrompt() {
    const { data, error } = await supabase
        .from('rules')
        .select('rule_text')
        .order('created_at', { ascending: true });
        
    let basePrompt = `You are Selena, professional customer service agent for Sanctum Dive.\nIMPORTANT: Use minimal, relevant, and nice emoticons. Do not overuse them. Keep your replies concise, friendly, and conversational. Do NOT send massive walls of text unless absolutely necessary to answer a complex question.\n\n`;
    
    if (data && data.length > 0) {
        basePrompt += "--- GUIDEBOOK & RULES ---\n";
        data.forEach((r, idx) => {
            basePrompt += `${idx + 1}. ${r.rule_text}\n`;
        });
        basePrompt += "-------------------------\n";
    }
    
    return basePrompt;
}

// ==========================================
// 4. GEMINI API LOGIC
// ==========================================
async function callGemini(senderId) {
    const history = await getHistory(senderId);
    const systemPrompt = await buildSystemPrompt();
    
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        
        if (response.data.candidates && response.data.candidates.length > 0) {
            const botReply = response.data.candidates[0].content.parts[0].text;
            await appendHistory(senderId, "model", botReply);
            return botReply;
        }
    } catch (error) {
        console.error("Gemini Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return null;
}

// ==========================================
// 5. META WHATSAPP API & MEDIA
// ==========================================
async function downloadMetaMedia(mediaId) {
    try {
        // 1. Get media URL
        const metaRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
        });
        const mediaUrl = metaRes.data.url;
        const mimeType = metaRes.data.mime_type;
        
        // 2. Download binary data
        const downloadRes = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` },
            responseType: 'arraybuffer'
        });
        
        const base64Data = Buffer.from(downloadRes.data, 'binary').toString('base64');
        return { base64Data, mimeType };
    } catch (error) {
        console.error("Meta Media Download Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

async function analyzeImage(base64Data, mimeType, caption) {
    const payload = {
        contents: [{
            parts: [
                { text: `Please describe this image in detail. The customer sent this to our dive shop. ${caption ? `They also included this caption: "${caption}"` : ''}` },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Data
                    }
                }
            ]
        }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        
        if (response.data.candidates && response.data.candidates.length > 0) {
            return response.data.candidates[0].content.parts[0].text;
        }
    } catch (error) {
        console.error("Gemini Image Analysis Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return "An image was sent, but it could not be analyzed.";
}

async function sendWhatsAppMessage(recipientPhone, textMessage) {
    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;
    
    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "text",
        text: { preview_url: false, body: textMessage }
    };

    try {
        cacheSet(`ai_sent_${recipientPhone}`, "true", 15);
        await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
        });
        console.log(`[Sent] Message to ${recipientPhone}`);
    } catch (error) {
        console.error("WhatsApp Send Error:", error.response ? error.response.data : error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Sanctum AI Server is running on port ${PORT}`);
});
