require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuration
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || "").split(',');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
// 1.1 TELEGRAM INTEGRATION
// ==========================================
async function sendTelegramAlert(textMessage) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: textMessage });
        console.log(`[Sent] Telegram Alert to Admin Group`);
    } catch (error) {
        console.error("Telegram Error:", error.response ? error.response.data : error.message);
    }
}

async function callGeminiTelegram(text) {
    const systemPrompt = await buildSystemPrompt();
    const telegramPrompt = `${systemPrompt}\n\n[SYSTEM OVERRIDE]: You are currently talking to your own internal staff team in a private Telegram group. They are asking you a question about the dive shop, bookings, or your instructions. Answer them helpfully, clearly, and concisely. Do NOT try to sell them anything.\n\nCRITICAL INSTRUCTION: You have access to database tools (add_rule, delete_rule, list_rules, check_recent_bookings, unpause_customer, message_customer). If a staff member asks you to check bookings, add a rule, or message/unpause a customer, you MUST actually invoke the corresponding tool function! Do NOT just pretend or make up an answer.`;
    
    const payload = {
        system_instruction: { parts: [{ text: telegramPrompt }] },
        contents: [{ role: "user", parts: [{ text: text }] }],
        tools: [{
            function_declarations: [{
                name: "check_recent_bookings",
                description: "Look up recent bookings in the database to answer staff questions about sales, customers, or special requests.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        limit: { type: "INTEGER", description: "Number of recent bookings to fetch (e.g., 5, 10)" }
                    }
                }
            }, {
                name: "list_rules",
                description: "Fetch all current rules from the master database to see what instructions you are currently following. Use this to find the rule ID if you need to delete it."
            }, {
                name: "add_rule",
                description: "Add a new rule to the master database. This rule will immediately apply to all future customer interactions on WhatsApp.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        rule_text: { type: "STRING", description: "The exact rule text to add. E.g., 'URGENT: Do not accept any new Open Water bookings for August 15th, the boat is full.'" }
                    },
                    required: ["rule_text"]
                }
            }, {
                name: "delete_rule",
                description: "Delete an existing rule from the master database by matching a few words.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        rule_text_match: { type: "STRING", description: "A few words from the rule you want to delete. We will delete any rule containing these words." }
                    },
                    required: ["rule_text_match"]
                }
            }, {
                name: "unpause_customer",
                description: "Unpause the AI for a specific customer so it resumes automatically answering them.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        phone_number: { type: "STRING", description: "The customer's phone number without the '+' sign (e.g., 628123456789)" }
                    },
                    required: ["phone_number"]
                }
            }, {
                name: "message_customer",
                description: "Unpause a specific customer AND generate a WhatsApp reply based on the staff's instructions. You MUST use this tool if a staff member asks you to tell a customer something.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        phone_number: { type: "STRING", description: "The customer's phone number without the '+' sign" },
                        instruction: { type: "STRING", description: "The exact instruction of what you should say or do for the customer (e.g., 'tell them we can do 10% off'). You will automatically read their history and formulate the perfect response naturally." }
                    },
                    required: ["phone_number", "instruction"]
                }
            }]
        }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        if (response.data.candidates && response.data.candidates.length > 0) {
            const part = response.data.candidates[0].content.parts[0];
            
            if (part.functionCall) {
                const call = part.functionCall;
                let funcResCtx = null;

                if (call.name === 'check_recent_bookings') {
                    console.log(`[Telegram Tool] AI is running check_recent_bookings`);
                    const limit = call.args.limit || 10;
                    const { data, error } = await supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(limit);
                    funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { bookings: data || [] } } }] };
                } else if (call.name === 'list_rules') {
                    console.log(`[Telegram Tool] AI is running list_rules`);
                    const { data, error } = await supabase.from('rules').select('rule_text').order('created_at', { ascending: true });
                    funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { rules: data || [], error: error ? error.message : null } } }] };
                } else if (call.name === 'add_rule') {
                    console.log(`[Telegram Tool] AI is running add_rule with text: ${call.args.rule_text}`);
                    const { error } = await supabase.from('rules').insert([{ rule_text: call.args.rule_text }]);
                    if (error) console.error("[Supabase Error] add_rule failed:", error.message);
                    funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { status: error ? "failed" : "success", message: error ? error.message : "Rule added." } } }] };
                } else if (call.name === 'delete_rule') {
                    console.log(`[Telegram Tool] AI is running delete_rule for match: ${call.args.rule_text_match}`);
                    const { error } = await supabase.from('rules').delete().ilike('rule_text', `%${call.args.rule_text_match}%`);
                    if (error) console.error("[Supabase Error] delete_rule failed:", error.message);
                    funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { status: error ? "failed" : "success", message: error ? error.message : "Rule deleted." } } }] };
                } else if (call.name === 'unpause_customer') {
                    console.log(`[Telegram Tool] AI is running unpause_customer for: ${call.args.phone_number}`);
                    const { error } = await supabase.from('pause_state').delete().eq('phone_number', call.args.phone_number);
                    if (error) console.error("[Supabase Error] unpause_customer failed:", error.message);
                    funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { status: error ? "failed" : "success", message: error ? error.message : "Customer unpaused." } } }] };
                } else if (call.name === 'message_customer') {
                    console.log(`[Telegram Tool] AI is running message_customer for: ${call.args.phone_number}`);
                    
                    // Unpause them first
                    await supabase.from('pause_state').delete().eq('phone_number', call.args.phone_number);
                    
                    // Call the WhatsApp Gemini instance with the custom instruction injected
                    const extraContext = [{ role: 'user', parts: [{ text: `[ADMIN OVERRIDE INSTRUCTION: ${call.args.instruction}]` }] }];
                    const botReply = await callGemini(call.args.phone_number, extraContext);
                    
                    if (botReply) {
                        const delayMs = Math.min(2000 + (botReply.length * 30), 12000);
                        await sleep(delayMs);
                        await sendWhatsAppMessage(call.args.phone_number, botReply);
                        funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "success", generated_message: botReply } } }] };
                    } else {
                        funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "failed", message: "Failed to generate a reply." } } }] };
                    }
                }

                if (funcResCtx) {
                    const secondPayload = {
                        system_instruction: { parts: [{ text: telegramPrompt }] },
                        contents: [
                            { role: "user", parts: [{ text: text }] },
                            response.data.candidates[0].content, // the function call
                            funcResCtx // the function response
                        ]
                    };
                    
                    const res2 = await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
                        secondPayload
                    );
                    if (res2.data.candidates && res2.data.candidates.length > 0) {
                        return res2.data.candidates[0].content.parts[0].text;
                    }
                }
            }
            
            if (part.text) {
                return part.text;
            }
        }
    } catch (error) {
        console.error("Gemini Telegram Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return null;
}

app.post('/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body;
    if (update.message && update.message.text && update.message.chat) {
        const chatId = update.message.chat.id.toString();
        const text = update.message.text;

        if (chatId === TELEGRAM_CHAT_ID || update.message.chat.type === 'private') {
            const isMentioned = text.includes('@SelenaSanctumBot');
            const isPrivate = update.message.chat.type === 'private';
            
            if (isMentioned || isPrivate) {
                const cleanText = text.replace('@SelenaSanctumBot', '').trim();
                if (cleanText.length === 0) return;
                
                console.log(`[Telegram] Question from staff: ${cleanText}`);
                
                try {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
                        chat_id: chatId,
                        action: "typing"
                    });
                    
                    const reply = await callGeminiTelegram(cleanText);
                    if (reply) {
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                            chat_id: chatId,
                            text: reply
                        });
                    }
                } catch (e) {
                    console.error("Telegram webhook processing error", e);
                }
            }
        }
    }
});

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
// 1.5 KIOSK API (Web Interface)
// ==========================================
app.post('/kiosk-chat', async (req, res) => {
    const { text, language } = req.body;
    if (!text) return res.status(400).send("No text provided");
    
    try {
        console.log(`[Kiosk] Received text: ${text}`);
        const extraContext = [{ 
            role: 'user', 
            parts: [{ text: `[SYSTEM OVERRIDE: You are speaking to a physical person at the front desk kiosk. Keep answers short, conversational, and friendly. DO NOT use any emojis, emoticons, or action asterisks (like *smiles*), as they will be read awkwardly by the text-to-speech engine. Speak naturally with human intonation. They are speaking to you in this language: ${language || 'English'}. Reply in that language.]` }] 
        }];
        
        // Use a dedicated session ID for the Kiosk and force the Flash model for speed
        const botReply = await callGemini('KIOSK_DESK_1', extraContext.concat([{ role: 'user', parts: [{ text: text }] }]), "gemini-2.5-flash");
        return res.json({ reply: botReply || "Sorry, I am having trouble connecting to my brain right now." });
    } catch (e) {
        console.error("Kiosk Chat Error", e);
        return res.status(500).json({ reply: "Connection Error." });
    }
});

app.post('/kiosk-translate', async (req, res) => {
    const { text, targetLanguage } = req.body;
    if (!text || !targetLanguage) return res.status(400).send("Missing text or language");
    
    const payload = {
        system_instruction: { parts: [{ text: `You are a professional scuba diving translator. Translate the following text into ${targetLanguage}. ONLY reply with the translated text, absolutely no other commentary.` }] },
        contents: [{ role: "user", parts: [{ text: text }] }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        if (response.data.candidates && response.data.candidates.length > 0) {
            const translation = response.data.candidates[0].content.parts[0].text;
            return res.json({ translation });
        }
    } catch (error) {
        console.error("Translation Error", error);
    }
    return res.status(500).json({ translation: "Translation failed." });
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
    // Pause for 30 minutes
    const pausedUntil = new Date();
    pausedUntil.setMinutes(pausedUntil.getMinutes() + 30);
    
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

async function buildSystemPrompt(isEmail = false) {
    const { data, error } = await supabase
        .from('rules')
        .select('rule_text')
        .order('created_at', { ascending: true });
        
    const currentDate = new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let basePrompt = `You are Selena, professional customer service agent for Sanctum Dive.\n[SYSTEM CLOCK: The current date and time is ${currentDate}].\n\nIMPORTANT: Use minimal, relevant, and nice emoticons. Do not overuse them. Keep your replies concise, friendly, and conversational. Do NOT send massive walls of text unless absolutely necessary to answer a complex question.\n\n`;
    
    if (isEmail) {
        basePrompt += `[EMAIL MODE]: You are replying to an EMAIL. Format your response professionally like an email with a proper greeting and sign-off.\n`;
        basePrompt += `[AUTOMATED PAYMENT RECEIPTS (e.g. Tab Travel)]:\n`;
        basePrompt += `If this email is an automated payment receipt or booking confirmation from a system:\n`;
        basePrompt += `1. You MUST use 'manage_sheet_booking' (SEARCH) to check if the customer is already on the sheet.\n`;
        basePrompt += `2. If they are already booked on that date, do nothing.\n`;
        basePrompt += `3. If they are NOT in the sheet, use 'manage_sheet_booking' (ADD) to record them.\n`;
        basePrompt += `4. CRITICAL: Once you are done updating the sheet, you MUST output ONLY the exact word: IGNORE. Do not write a draft reply to an automated system!\n\n`;
        
        basePrompt += `[SPAM FILTERING]: If the email is marketing spam, a vendor newsletter, or irrelevant, output ONLY the exact word: IGNORE. Do not draft a reply for these.\n\n`;
    }
    
    // Core Tools Instruction
    basePrompt += `CRITICAL INSTRUCTION: Whenever a customer confirms a booking (via deposit screenshot) OR insists on paying on site, you MUST use the 'manage_sheet_booking' tool to record them.\n`;
    basePrompt += `PREVENT DOUBLE BOOKING: Before you use the 'ADD' action, you MUST ALWAYS use the 'SEARCH' action first to check if the customer's name is already on the sheet. If they are already booked for that date, DO NOT call 'ADD' again!\n`;
    basePrompt += `SHEET BOOKING RULES for 'manage_sheet_booking':\n`;
    basePrompt += `- Put all people in a group in ONE string. Format each person: [Name] [Product] [Deposit Status]. Separate with commas. End with 'specreq: [request]'.\n`;
    basePrompt += `- Products: Try Dive = TD, Fun Dive = FD [License] (e.g. FD OW), Dive Courses = [Product]C (e.g. OWC, AOWC, RESCC, EFRC, DMC).\n`;
    basePrompt += `- Deposit: Paid Deposit = DPO. No Deposit = ?\n`;
    basePrompt += `- Example: "Adrian TD DPO, James FD OW DPO, Sabrina RESCC DPO, specreq: dive together"\n`;
    basePrompt += `- If a customer asks to verify their booking, use the 'SEARCH' action to look up their name in the sheet.\n\n`;
    
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
async function handleBookingNotification(args, senderId) {
    const now = new Date();
    const baliHour = (now.getUTCHours() + 8) % 24;
    
    console.log(`[Booking] Detected booking. Bali Hour: ${baliHour}`);
    
    // Save to Database
    try {
        await supabase.from('bookings').insert([{
            customer_phone: senderId,
            customer_name: args.customer_name,
            status: args.status,
            dive_date: args.dive_date,
            pax: args.pax,
            dive_type: args.dive_type,
            special_requests: args.special_requests || "None"
        }]);
    } catch (e) {
        console.error("Failed to save booking:", e.message);
    }
    
    const msg = `🔔 *NEW BOOKING ALERT*\n\nStatus: ${args.status}\nCustomer: ${args.customer_name} (+${senderId})\nDate: ${args.dive_date}\nPax: ${args.pax}\nType: ${args.dive_type}\nSpecial Requests: ${args.special_requests || "None"}`;
    
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        await sendTelegramAlert(msg);
    } else {
        for (const adminPhone of ADMIN_NUMBERS) {
            if (adminPhone.trim().length > 0) {
                await sendWhatsAppMessage(adminPhone.trim(), msg);
                await sleep(500); // prevent rate limits
            }
        }
    }
    console.log(`[Booking] Alert sent to Admins.`);
}

async function callGemini(senderId, extraContext = [], model = "gemini-2.5-pro", isEmail = false) {
    let history = await getHistory(senderId);
    if (extraContext.length > 0) {
        history = history.concat(extraContext);
    }
    const systemPrompt = await buildSystemPrompt(isEmail);
    
    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history,
        tools: [{
            function_declarations: [{
                name: "record_booking",
                description: "Call this immediately when a customer confirms a booking. Determine if it is fully confirmed (deposit screenshot verified) or not confirmed (insists on coming without deposit).",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        status: { type: "STRING", description: "Either '✅ FULLY CONFIRMED' or '❓ NOT CONFIRMED (No Deposit)'" },
                        customer_name: { type: "STRING", description: "Name of the customer" },
                        dive_date: { type: "STRING", description: "Date of the dive" },
                        pax: { type: "INTEGER", description: "Number of people" },
                        dive_type: { type: "STRING", description: "What course or trip they are booking" },
                        special_requests: { type: "STRING", description: "Any special requests, dietary restrictions (e.g., vegan), or notes (e.g., diving with partner, wants to dive deep). Put 'None' if not applicable." }
                    },
                    required: ["status", "customer_name", "dive_date", "pax", "dive_type", "special_requests"]
                }
            }, {
                name: "manage_sheet_booking",
                description: "Call this immediately when a customer confirms, reschedules, or cancels a booking, OR to search/verify an existing booking. This edits/reads the live Google Sheet schedule. You must format new_text exactly as instructed in SHEET BOOKING RULES.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: { type: "STRING", description: "Must be 'ADD', 'UPDATE', 'REMOVE', or 'SEARCH'" },
                        target_date: { type: "STRING", description: "The date of the booking in YYYY-MM-DD format (e.g. 2026-07-02). Required for ADD and UPDATE." },
                        new_text: { type: "STRING", description: "The formatted string to write into the cell. Required for ADD and UPDATE. Must follow SHEET BOOKING RULES formatting." },
                        old_date: { type: "STRING", description: "The old date of the booking in YYYY-MM-DD format. Required for UPDATE and REMOVE." },
                        old_text_match: { type: "STRING", description: "A substring of the old cell text to find and clear. Required for UPDATE and REMOVE (e.g. 'Adrian TD DPO')." },
                        search_query: { type: "STRING", description: "Customer name or string to search for across the sheet. Required for SEARCH." }
                    },
                    required: ["action"]
                }
            }]
        }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        
        if (response.data.candidates && response.data.candidates.length > 0) {
            const parts = response.data.candidates[0].content.parts;
            const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
            const textPart = parts.find(p => p.text);
            let firstTurnText = textPart ? textPart.text : null;
            
            if (functionCalls.length > 0) {
                const funcCallCtx = response.data.candidates[0].content;
                const funcResParts = [];
                
                for (const call of functionCalls) {
                    if (call.name === 'record_booking') {
                        await handleBookingNotification(call.args, senderId);
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: "success" } } });
                    } else if (call.name === 'manage_sheet_booking') {
                        console.log(`[Google Sheets] Executing manage_sheet_booking: ${call.args.action}`);
                        let sheetStatus = "error";
                        let sheetMessage = "GOOGLE_SHEET_API_URL not configured in backend.";
                        
                        if (process.env.GOOGLE_SHEET_API_URL) {
                            try {
                                const sheetRes = await axios.post(process.env.GOOGLE_SHEET_API_URL, call.args);
                                sheetStatus = "success";
                                sheetMessage = sheetRes.data.status || "Completed";
                                
                                // Send Telegram Alert
                                if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                                    const alertMsg = `📋 *SHEET UPDATE ALARM*\n\nAction: ${call.args.action}\nDate: ${call.args.target_date}\nText: ${call.args.new_text || 'N/A'}\n\nStatus: ${sheetMessage}`;
                                    await sendTelegramAlert(alertMsg);
                                }
                            } catch (err) {
                                console.error("[Google Sheets API Error]", err.message);
                                sheetMessage = err.message;
                            }
                        }
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: sheetStatus, message: sheetMessage } } });
                    }
                }
                
                const funcResCtx = { role: "function", parts: funcResParts };
                const recursiveReply = await callGemini(senderId, [...extraContext, funcCallCtx, funcResCtx], model, isEmail);
                
                if (firstTurnText && !recursiveReply) {
                    await appendHistory(senderId, "model", firstTurnText);
                    return firstTurnText;
                } else if (firstTurnText && recursiveReply) {
                    const combined = firstTurnText + "\n" + recursiveReply;
                    // The recursive call already appended itself, so we need to be careful with history here.
                    // Actually, the recursive call appended `recursiveReply`. If we want to return combined, we should fix history.
                    // To keep it simple: just return the recursive reply, but if it's empty, return the first turn text.
                    return recursiveReply;
                }
                return recursiveReply;
            }
            
            if (firstTurnText) {
                await appendHistory(senderId, "model", firstTurnText);
                return firstTurnText;
            }
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

async function sendWhatsAppTemplate(recipientPhone, templateName, languageCode = "en") {
    const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;
    
    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "template",
        template: {
            name: templateName,
            language: { code: languageCode }
        }
    };

    try {
        cacheSet(`ai_sent_${recipientPhone}`, "true", 15);
        await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` }
        });
        console.log(`[Sent] Template ${templateName} to ${recipientPhone}`);
    } catch (error) {
        console.error("WhatsApp Template Send Error:", error.response ? JSON.stringify(error.response.data) : error.message);
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
            if (lastMsg.message_text.includes("reconfirm your dive plan") || lastMsg.message_text.includes("[Sent 2-Day Follow-Up Template]")) continue;

            const history = await getHistory(phone);
            const shouldFollowUp = await evaluateFollowup(history, 2);
            
            if (shouldFollowUp) {
                await sendWhatsAppTemplate(phone, "sales_followup", "en");
                await appendHistory(phone, "model", "[Sent 2-Day Follow-Up Template]");
                console.log(`[Follow-up] Sent 2-day follow up to ${phone}`);
                
                // Wait 5 seconds between messages so Meta doesn't flag us for spam
                await sleep(5000); 
            }
        }
        
        // Check 7-day follow up (between 168 and 192 hours)
        else if (hoursSilent >= 168 && hoursSilent < 192) {
            if (lastMsg.message_text.includes("checking in one last time") || lastMsg.message_text.includes("[Sent 7-Day Follow-Up Template]")) continue;

            const history = await getHistory(phone);
            const shouldFollowUp = await evaluateFollowup(history, 7);
            
            if (shouldFollowUp) {
                await sendWhatsAppTemplate(phone, "sales_followup", "en");
                await appendHistory(phone, "model", "[Sent 7-Day Follow-Up Template]");
                console.log(`[Follow-up] Sent 7-day follow up to ${phone}`);
                
                await sleep(5000);
            }
        }
    }
}

// ==========================================
// 7. GMAIL WEBHOOK API
// ==========================================
app.post('/gmail-webhook', async (req, res) => {
    try {
        const { threadId, messageId, senderEmail, subject, body, attachments } = req.body;
        
        console.log(`[Gmail] Received email from ${senderEmail}: ${subject}`);
        
        const senderEmailLower = senderEmail.toLowerCase();
        const subjectLower = subject.toLowerCase();
        
        // HARD-CODED SPAM & SYSTEM FILTER (Bypasses AI completely)
        if (senderEmailLower.includes('no-reply') || senderEmailLower.includes('noreply')) {
            console.log(`[Gmail] HARD BLOCKED automated/vendor email: ${senderEmail}`);
            return res.json({ action: "IGNORED" });
        }
        
        let contextToSave = `[Customer Email Subject: ${subject}]\n\n${body}`;
        
        // Handle Email Attachments (like payment screenshots)
        if (attachments && attachments.length > 0) {
            for (const att of attachments) {
                try {
                    const buffer = Buffer.from(att.base64, 'base64');
                    const mediaType = att.mimeType.startsWith('image') ? 'image' : 'document';
                    const description = await analyzeMedia(buffer, att.mimeType, att.name, mediaType);
                    contextToSave += `\n\n[Customer attached a file (${att.name}): ${description}]`;
                    console.log(`[Gmail Media] Successfully analyzed attachment: ${att.name}`);
                } catch (err) {
                    console.error(`[Gmail Media] Failed to process attachment ${att.name}:`, err.message);
                }
            }
        }
        
        // 1. Check Pause State
        const isPaused = await checkIsPaused(senderEmail);
        
        if (isPaused) {
            await appendHistory(senderEmail, "user", contextToSave);
            return res.json({ action: "PAUSED" });
        }
        
        // 2. Append history and call Gemini
        await appendHistory(senderEmail, "user", contextToSave);
        const aiReply = await callGemini(senderEmail, [], "gemini-2.5-pro", true);
        
        if (aiReply) {
            if (aiReply.trim().toUpperCase() === "IGNORE") {
                console.log(`[Gmail] Ignored spam/promo from ${senderEmail}`);
                return res.json({ action: "IGNORED" });
            }
            
            // It's a real reply, tell Apps Script to create a draft
            console.log(`[Gmail] Creating draft for ${senderEmail}`);
            return res.json({ action: "DRAFT_CREATED", replyText: aiReply });
        }
        
        res.json({ action: "ERROR" });
    } catch (error) {
        console.error("Gmail Webhook Error:", error);
        res.json({ action: "ERROR" });
    }
});

// Run every day at 10:00 AM server time
cron.schedule('0 10 * * *', runDailyFollowUps);

app.listen(PORT, () => {
    console.log(`Sanctum AI Server is running on port ${PORT}`);
});
