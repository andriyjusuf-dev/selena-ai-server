require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
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
                
                const validTypes = ['text', 'image', 'audio', 'document'];
                if (validTypes.includes(messageObj.type)) {
                    let textBody = "";
                    let isMedia = false;
                    let mediaType = null;
                    let mediaId = null;
                    
                    if (messageObj.type === 'text') {
                        textBody = messageObj.text.body;
                    } else if (messageObj.type === 'image') {
                        isMedia = true;
                        mediaType = 'image';
                        mediaId = messageObj.image.id;
                        textBody = messageObj.image.caption || "";
                    } else if (messageObj.type === 'audio') {
                        isMedia = true;
                        mediaType = 'audio';
                        mediaId = messageObj.audio.id;
                        textBody = ""; // Voice notes have no caption
                    } else if (messageObj.type === 'document') {
                        isMedia = true;
                        mediaType = 'document';
                        mediaId = messageObj.document.id;
                        textBody = messageObj.document.caption || messageObj.document.filename || "";
                    }
                    
                    const isEcho = (change.field === 'smb_message_echoes' || change.field === 'message_echoes' || messageObj.from_me === true);
                    
                    if (isEcho) {
                        // Human is typing
                        let targetId = messageObj.to;
                        if (!targetId && value.contacts && value.contacts.length > 0) {
                            targetId = value.contacts[0].wa_id;
                        }
                        
                        // BUGFIX: Check if Selena actually sent this message just now.
                        // If she did, do NOT pause the AI!
                        const aiSent = targetId ? cacheGet(`ai_sent_${targetId}`) : false;
                        
                        if (!aiSent) {
                            let contextToSave = textBody;
                            if (isMedia) contextToSave = `[Human agent sent a ${mediaType}: ${textBody}]`;
                            
                            if (targetId) {
                                await pauseAI(targetId, contextToSave);
                            } else {
                                const lastTarget = cacheGet(`last_paused_target`);
                                if (lastTarget) {
                                    await appendHistory(lastTarget, "model", contextToSave);
                                } else {
                                    cacheSet(`orphan_echo`, contextToSave, 15);
                                }
                            }
                        }
                    } else {
                        // Customer or Admin is typing
                        const senderId = messageObj.from;
                        
                        // 1. Check for Admin Training Command
                        if (!isMedia && ADMIN_NUMBERS.includes(senderId) && (textBody.toLowerCase().startsWith('!learn') || textBody.toLowerCase().startsWith('!rule'))) {
                            await handleAdminCommand(senderId, textBody);
                            return;
                        }
                        
                        // 2. Normal Customer Message
                        const isPaused = await checkIsPaused(senderId);
                        
                        let contextToSave = textBody;
                        if (isMedia) {
                            console.log(`[Media Received] Analyzing ${mediaType} from ${senderId}...`);
                            const mediaData = await downloadMetaMedia(mediaId);
                            if (mediaData) {
                                const description = await analyzeMedia(mediaData.buffer, mediaData.mimeType, textBody, mediaType);
                                contextToSave = `[Customer sent a ${mediaType}: ${description}]`;
                            } else {
                                contextToSave = `[Customer sent a ${mediaType}, but it could not be downloaded] ${textBody}`;
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
        
        const buffer = Buffer.from(downloadRes.data, 'binary');
        const base64Data = buffer.toString('base64');
        return { buffer, base64Data, mimeType };
    } catch (error) {
        console.error("Meta Media Download Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

async function analyzeMedia(buffer, mimeType, caption, mediaType) {
    // 1. Parse Excel files directly
    if (mimeType.includes('spreadsheetml') || mimeType.includes('excel') || mimeType === 'text/csv') {
        try {
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            let allText = "";
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                allText += `\n--- Sheet: ${sheetName} ---\n`;
                allText += xlsx.utils.sheet_to_csv(sheet);
            });
            return `Parsed Spreadsheet Data:\n${allText.substring(0, 3000)}`;
        } catch (e) {
            return `Failed to parse spreadsheet: ${e.message}`;
        }
    }
    
    // 2. Parse Word Documents
    if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') {
        try {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return `Parsed Word Document:\n${result.value.substring(0, 3000)}`;
        } catch (e) {
            return `Failed to parse Word Document (Note: old .doc formats may not be supported. Ask for PDF): ${e.message}`;
        }
    }
    
    // 3. For natively supported Gemini formats (Audio, PDF, Images)
    let prompt = "";
    if (mediaType === 'audio') {
        prompt = "Please listen to this audio message from a customer and transcribe/summarize what they said in detail.";
    } else if (mediaType === 'image') {
        prompt = `Please describe this image in detail. The customer sent this to our dive shop. ${caption ? `They also included this caption: "${caption}"` : ''}`;
    } else if (mediaType === 'document') {
        prompt = `Please read this document sent by a customer and summarize its contents in detail. ${caption ? `Caption: "${caption}"` : ''}`;
    }

    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: buffer.toString('base64')
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
        console.error("Gemini Media Analysis Error:", error.response ? JSON.stringify(error.response.data) : error.message);
        return `[Customer sent a file of type ${mimeType}, but the AI could not natively read it. Ask them for a PDF or plain text summary.]`;
    }
    return "Media was sent, but it could not be analyzed.";
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

// ==========================================
// 6. AUTOMATIC FOLLOW-UPS (Cron Job)
// ==========================================
async function evaluateFollowup(history, followUpType) {
    const systemInstruction = `You are a sales assistant reviewing a customer conversation that has gone silent for ${followUpType} days. 
Does this customer need a sales follow-up? 
If the customer already rejected, booked, already completed their dive, or the conversation naturally concluded, reply ONLY with the exact word: NO
If they were in the middle of inquiring and we should try to close the sale, reply ONLY with the exact word: YES`;

    const payload = {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: history
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        if (response.data.candidates && response.data.candidates.length > 0) {
            const answer = response.data.candidates[0].content.parts[0].text.trim().toUpperCase();
            return answer.includes('YES');
        }
    } catch (error) {
        console.error("Gemini Followup Eval Error:", error.message);
    }
    return false; // Default to safe (don't spam)
}

async function runDailyFollowUps() {
    console.log("[Cron] Running daily follow-up checks...");
    
    // Only fetch messages from the last 10 days to stay well under the 1000 row limit
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    const { data: convos, error } = await supabase
        .from('conversations')
        .select('phone_number, message_text, created_at')
        .gte('created_at', tenDaysAgo.toISOString())
        .order('created_at', { ascending: false });
        
    if (error || !convos) return;

    // Group by phone number to find the LATEST message for each
    const latestMessages = new Map();
    for (const msg of convos) {
        if (!latestMessages.has(msg.phone_number)) {
            latestMessages.set(msg.phone_number, msg);
        }
    }

    const now = new Date();

    for (const [phone, lastMsg] of latestMessages.entries()) {
        const lastTime = new Date(lastMsg.created_at);
        const hoursSilent = (now - lastTime) / (1000 * 60 * 60);

        // Check 2-day follow up (between 48 and 72 hours)
        if (hoursSilent >= 48 && hoursSilent < 72) {
            if (lastMsg.message_text.includes("reconfirm your dive plan")) continue;

            const history = await getHistory(phone);
            const shouldFollowUp = await evaluateFollowup(history, 2);
            
            if (shouldFollowUp) {
                const text = "Hello! I wanted to reconfirm your dive plan? Let me know if you have any questions or if you're ready to book!";
                await sendWhatsAppMessage(phone, text);
                await appendHistory(phone, "model", text);
                console.log(`[Follow-up] Sent 2-day follow up to ${phone}`);
                
                // Wait 5 seconds between messages so Meta doesn't flag us for spam
                await sleep(5000); 
            }
        }
        
        // Check 7-day follow up (between 168 and 192 hours)
        else if (hoursSilent >= 168 && hoursSilent < 192) {
            if (lastMsg.message_text.includes("checking in one last time")) continue;

            const history = await getHistory(phone);
            const shouldFollowUp = await evaluateFollowup(history, 7);
            
            if (shouldFollowUp) {
                const text = "Hi there, just checking in one last time to see if you'd still like to dive with Sanctum! Let us know if we can help.";
                await sendWhatsAppMessage(phone, text);
                await appendHistory(phone, "model", text);
                console.log(`[Follow-up] Sent 7-day follow up to ${phone}`);
                
                await sleep(5000);
            }
        }
    }
}

// Run every day at 10:00 AM server time
cron.schedule('0 10 * * *', runDailyFollowUps);

app.listen(PORT, () => {
    console.log(`Sanctum AI Server is running on port ${PORT}`);
});
