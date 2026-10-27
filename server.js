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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;

// Configuration
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_IG_VERIFY_TOKEN = process.env.META_IG_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_IG_ACCESS_TOKEN = process.env.META_IG_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_IG_USER_ID = process.env.META_IG_USER_ID;
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || "").split(',');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const KETUT_TELEGRAM_HANDLE = process.env.KETUT_TELEGRAM_HANDLE || '@ketutdarmaja';

// Cloudbeds PMS Live Integration (Sanctum Hotel Nusa Penida)
const CLOUDBEDS_API_KEY = process.env.CLOUDBEDS_API_KEY;
if (!CLOUDBEDS_API_KEY) {
    console.warn("⚠️ WARNING: CLOUDBEDS_API_KEY is not set in environment variables. Hotel integration requires CLOUDBEDS_API_KEY.");
}
const CLOUDBEDS_PROPERTY_ID = process.env.CLOUDBEDS_PROPERTY_ID || "284597444944000";
const CLOUDBEDS_DELUXE_ROOM_TYPE_ID = process.env.CLOUDBEDS_DELUXE_ROOM_TYPE_ID || "284674448941249";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// NEW: Qwen Cloud API Configuration
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const QWEN_API_URL = process.env.QWEN_API_URL || 'https://maas.qwencloudapi.com/compatible-mode/v1/chat/completions';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3.8-flash';

// Set Default AI to DeepSeek
let ACTIVE_AI = process.env.DEFAULT_AI_PROVIDER || 'deepseek';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("🚨 FATAL ERROR: SUPABASE_URL or SUPABASE_SERVICE_KEY is missing in Render Environment Variables!");
    process.exit(1);
}
if (ACTIVE_AI === 'qwen' && !QWEN_API_KEY) {
    console.error("⚠️ WARNING: Qwen is active but QWEN_API_KEY is missing.");
}

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

async function sendErrorTelegramAlert(textMessage) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const chatId = process.env.PERSONAL_TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID;
    if (!chatId) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: textMessage });
    } catch (error) {
        console.error("Telegram Error:", error.response ? error.response.data : error.message);
    }
}

// ==========================================
// 1.2 GLOBAL ERROR MONITORING (RENDER LOGS)
// ==========================================
process.on('uncaughtException', async (err) => {
    console.log("[Global Error] Uncaught Exception:", err.message);
    await sendErrorTelegramAlert(`🚨 *CRITICAL SERVER CRASH (Render)*\n\n\`${err.message}\`\n\nRestarting...`);
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.log("[Global Error] Unhandled Rejection at:", promise, "reason:", reason);
    const msg = reason instanceof Error ? reason.message : JSON.stringify(reason);
    await sendErrorTelegramAlert(`⚠️ *Unhandled Promise Rejection (Render)*\n\n\`${msg}\``);
});

const originalConsoleError = console.error;
console.error = function (...args) {
    const errorStr = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    if (!errorStr.includes('Telegram Error:')) {
        sendErrorTelegramAlert(`🔥 *Render Server Error Log*\n\n\`${errorStr.substring(0, 800)}\``).catch(() => { });
    }
    originalConsoleError.apply(console, args);
};

// ==========================================
// 1.3 CLOUDBEDS & HOTEL SYNCHRONIZATION
// ==========================================
function normalizeHotelDates(target_dates, startDate, endDate) {
    let sDate = startDate;
    let eDate = endDate;
    let datesArr = Array.isArray(target_dates) ? [...target_dates] : [];

    if (datesArr.length > 0) {
        datesArr.sort();
        if (!sDate) sDate = datesArr[0];
        if (!eDate) {
            const last = new Date(datesArr[datesArr.length - 1] + "T00:00:00Z");
            last.setUTCDate(last.getUTCDate() + 1);
            eDate = last.toISOString().split("T")[0];
        }
    } else if (sDate && eDate) {
        let cur = new Date(sDate + "T00:00:00Z");
        const end = new Date(eDate + "T00:00:00Z");
        while (cur < end) {
            datesArr.push(cur.toISOString().split("T")[0]);
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
    }
    return { startDate: sDate, endDate: eDate, target_dates: datesArr };
}

async function handleHotelBooking(args, funcName = "manage_hotel_booking", callerSource = "AI") {
    const action = (funcName === "search_hotel_booking" ? "SEARCH" : (args.action || "SEARCH")).toUpperCase();
    console.log(`[Hotel Manager] Executing ${action} by ${callerSource} | Args:`, JSON.stringify(args));

    try {
        // 1. CHECK CAPACITY / AVAILABILITY (Cloudbeds Live Inventory)
        if (action === 'CHECK_CAPACITY' || action === 'CHECK_AVAILABILITY' || action === 'CAPACITY') {
            const { startDate, endDate } = normalizeHotelDates(args.target_dates, args.startDate || args.start_date, args.endDate || args.end_date);
            if (!startDate || !endDate) {
                return "Please provide check-in and check-out dates to check room availability.";
            }

            const availRes = await axios.get("https://api.cloudbeds.com/api/v1.1/getAvailableRoomTypes", {
                headers: { "x-api-key": CLOUDBEDS_API_KEY },
                params: {
                    propertyID: CLOUDBEDS_PROPERTY_ID,
                    startDate: startDate,
                    endDate: endDate
                }
            });

            const rooms = availRes.data.data?.[0]?.propertyRooms || [];
            // Filter strictly for Deluxe Room Garden View (8 units live, dorms excluded)
            const deluxe = rooms.find(r => r.roomTypeID == CLOUDBEDS_DELUXE_ROOM_TYPE_ID || (r.roomTypeName && r.roomTypeName.toLowerCase().includes("deluxe")));
            const availableUnits = deluxe ? (Number(deluxe.roomsAvailable) || 0) : 0;
            const nights = Math.max(1, target_dates.length);
            const totalRate = deluxe?.roomRate ? Number(deluxe.roomRate) : null;
            const avgNightlyRate = totalRate ? Math.round(totalRate / nights) : null;

            if (availableUnits > 0) {
                let pricingInfo = totalRate 
                    ? `Live PMS Rate: IDR ${totalRate.toLocaleString()} total (~IDR ${avgNightlyRate.toLocaleString()}/night for ${nights} night${nights > 1 ? 's' : ''}). (Seasonal/OTA fluctuating rate; custom/manual direct rates can also be offered).`
                    : `Seasonal dynamic pricing applies.`;
                return `✅ Deluxe Room Garden View: ${availableUnits} room(s) available for check-in ${startDate} to check-out ${endDate} (${nights} night${nights > 1 ? 's' : ''}). ${pricingInfo} Room features: King Bed + Daybed lounge sofa, up to 3 guests.`;
            } else {
                return `❌ Deluxe Room Garden View is FULLY BOOKED for check-in ${startDate} to check-out ${endDate}. Please suggest alternate dates.`;
            }
        }

        // 2. SEARCH BOOKINGS / GUEST LOOKUP (Cloudbeds + Google Sheet)
        if (action === 'SEARCH') {
            const query = (args.search_query || args.guest_name || args.old_guest_match || "").trim().toLowerCase();
            let matches = [];

            try {
                const cbRes = await axios.get("https://api.cloudbeds.com/api/v1.1/getReservations", {
                    headers: { "x-api-key": CLOUDBEDS_API_KEY },
                    params: { propertyID: CLOUDBEDS_PROPERTY_ID, limit: 100 }
                });
                if (cbRes.data && cbRes.data.data) {
                    const found = cbRes.data.data.filter(r => {
                        const name = (r.guestName || "").toLowerCase();
                        const id = (r.reservationID || "").toLowerCase();
                        return !query || name.includes(query) || id.includes(query);
                    });
                    matches = found.slice(0, 10).map(r => `• ${r.guestName} [CB#${r.reservationID}] (${r.startDate} to ${r.endDate}) - Status: ${r.status}`);
                }
            } catch (err) {
                console.error("[Cloudbeds Search Error]", err.message);
            }

            let sheetInfo = "";
            if (process.env.HOTEL_SHEET_API_URL) {
                try {
                    const sRes = await axios.post(process.env.HOTEL_SHEET_API_URL, {
                        action: 'SEARCH',
                        search_query: args.search_query || args.guest_name || query,
                        target_month: args.target_month
                    });
                    sheetInfo = (typeof sRes.data === 'string' && sRes.data.includes('<html')) ? "" : (sRes.data.message || sRes.data.status || "");
                } catch (e) {
                    console.error("[Hotel Sheet Search Error]", e.message);
                }
            }

            if (matches.length === 0 && !sheetInfo) {
                return `No hotel reservations found matching "${query || 'query'}".`;
            }

            let responseText = matches.length > 0 ? `Cloudbeds PMS Bookings:\n${matches.join("\n")}` : "";
            if (sheetInfo) {
                responseText += (responseText ? "\n\n" : "") + `Google Sheet Calendar:\n${sheetInfo}`;
            }
            return responseText;
        }

        // 3. ADD NEW RESERVATION (Cloudbeds -> Google Sheet -> Telegram)
        if (action === 'ADD') {
            const isStaffTelegram = callerSource && callerSource.includes("TELEGRAM");
            const depositConfirmed = args.deposit_paid === true || args.deposit_confirmed === true || isStaffTelegram;

            if (!depositConfirmed) {
                console.warn(`[Hotel Booking Guardrail] Blocked room reservation for "${args.guest_name}" - No online deposit confirmation.`);
                return "❌ BOOKING REJECTED: Hotel rooms can ONLY be reserved after the customer has paid the deposit online. Please send the payment link/instructions and obtain online deposit confirmation before booking.";
            }

            const fullName = (args.guest_name || args.customer_name || "Guest").trim();
            const nameParts = fullName.split(" ");
            const firstName = nameParts[0] || "Guest";
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "Sanctum";
            const guestEmail = args.guest_email || args.email || "booking@sanctumnusapenida.com";
            const guestPhone = args.guest_phone || args.phone_number || "+6282359213114";
            const quantity = Number(args.rooms_count || args.quantity || 1);
            const pax = Number(args.pax || args.adults || (quantity * 2));
            const customRate = args.custom_rate || args.rate || args.price || null;

            const { startDate, endDate, target_dates } = normalizeHotelDates(args.target_dates, args.startDate || args.start_date, args.endDate || args.end_date);
            const nights = Math.max(1, target_dates.length);

            if (!startDate || !endDate) {
                return "Failed: Missing check-in and check-out dates for hotel booking.";
            }

            const postData = new URLSearchParams();
            postData.append("propertyID", CLOUDBEDS_PROPERTY_ID);
            postData.append("startDate", startDate);
            postData.append("endDate", endDate);
            postData.append("guestFirstName", firstName);
            postData.append("guestLastName", lastName);
            postData.append("guestEmail", guestEmail);
            postData.append("guestPhone", guestPhone);
            postData.append("guestCountry", "ID");
            postData.append("paymentMethod", "cash");
            postData.append("adults", pax);
            postData.append("children", 0);
            postData.append("rooms[0][roomTypeID]", CLOUDBEDS_DELUXE_ROOM_TYPE_ID);
            postData.append("rooms[0][quantity]", quantity);
            postData.append("adults[0][roomTypeID]", CLOUDBEDS_DELUXE_ROOM_TYPE_ID);
            postData.append("adults[0][quantity]", pax);
            postData.append("children[0][roomTypeID]", CLOUDBEDS_DELUXE_ROOM_TYPE_ID);
            postData.append("children[0][quantity]", 0);

            console.log(`[Cloudbeds] Posting reservation for ${fullName} (${startDate} to ${endDate})...`);
            const cbRes = await axios.post("https://api.cloudbeds.com/api/v1.1/postReservation", postData.toString(), {
                headers: {
                    "x-api-key": CLOUDBEDS_API_KEY,
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            });

            if (!cbRes.data || !cbRes.data.success) {
                const errMsg = cbRes.data?.message || "Failed to book room in Cloudbeds";
                console.error("[Cloudbeds Booking Failed]", errMsg);
                return `Booking Failed in Cloudbeds: ${errMsg}`;
            }

            const reservationID = cbRes.data.data?.reservationID || cbRes.data.reservationID || "CONFIRMED";
            console.log(`[Cloudbeds Booking Success] ID: ${reservationID}`);

            // Synchronize with Google Sheet
            let sheetStatus = "N/A";
            if (process.env.HOTEL_SHEET_API_URL) {
                try {
                    const rateTag = customRate ? ` | Rate: ${customRate}` : "";
                    const sheetPayload = {
                        action: 'ADD',
                        target_dates: target_dates,
                        guest_name: `${fullName} [CB#${reservationID}${rateTag}]`
                    };
                    const sheetRes = await axios.post(process.env.HOTEL_SHEET_API_URL, sheetPayload);
                    sheetStatus = (typeof sheetRes.data === 'string' && sheetRes.data.includes('<html')) ? "AppsScript HTML" : (sheetRes.data.message || sheetRes.data.status || "Synced");
                } catch (sErr) {
                    console.error("[Hotel Sheet Sync Error]", sErr.message);
                    sheetStatus = `Sync Error: ${sErr.message}`;
                }
            }

            // Telegram notification tagging Ketut
            if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                const rateLine = customRate 
                    ? `💰 Rate: *${customRate}* (Manual / Direct Sale)\n` 
                    : `💰 Rate: Live Cloudbeds PMS Seasonal Rate\n`;
                const alertMsg = `🏨 *NEW HOTEL RESERVATION (${callerSource})*\n` +
                    `🛎️ **Attention: ${KETUT_TELEGRAM_HANDLE}**\n\n` +
                    `👤 Guest: *${fullName}*\n` +
                    `📅 Dates: *${startDate}* to *${endDate}* (${nights} night${nights > 1 ? 's' : ''})\n` +
                    `🛏️ Room: Deluxe Room Garden View (${quantity} room${quantity > 1 ? 's' : ''})\n` +
                    `👥 Guests: ${pax} pax\n` +
                    rateLine +
                    `💳 Deposit: ${isStaffTelegram ? 'Staff / Ketut Admin Override' : 'Verified Online Deposit ✅'}\n` +
                    `🆔 Cloudbeds ID: \`${reservationID}\`\n` +
                    `📊 Google Sheet: ${sheetStatus}\n\n` +
                    `✅ Room blocked across Booking.com & OTAs!`;
                await sendTelegramAlert(alertMsg);
            }

            const rateConfirmation = customRate ? ` at ${customRate} (Manual Rate)` : "";
            return `✅ Successfully booked Deluxe Room Garden View for ${fullName} (${startDate} to ${endDate}, ${nights} nights)${rateConfirmation}. Cloudbeds Reservation ID: ${reservationID}. Google Sheet synchronized.`;
        }

        // 4. REMOVE / CANCEL RESERVATION (Cloudbeds -> Google Sheet -> Telegram)
        if (action === 'REMOVE' || action === 'CANCEL') {
            let resId = args.reservation_id || args.reservationID;
            const targetName = (args.old_guest_match || args.guest_name || "").trim().toLowerCase();

            // Find reservation in Cloudbeds if no ID provided
            if (!resId && targetName) {
                try {
                    const listRes = await axios.get("https://api.cloudbeds.com/api/v1.1/getReservations", {
                        headers: { "x-api-key": CLOUDBEDS_API_KEY },
                        params: { propertyID: CLOUDBEDS_PROPERTY_ID, status: "confirmed", limit: 100 }
                    });
                    const found = (listRes.data?.data || []).find(r => (r.guestName || "").toLowerCase().includes(targetName));
                    if (found) {
                        resId = found.reservationID;
                    }
                } catch (lErr) {
                    console.error("[Cloudbeds Lookup for Cancel Error]", lErr.message);
                }
            }

            let cbStatus = "No matching active Cloudbeds reservation found";
            if (resId) {
                const cancelData = new URLSearchParams();
                cancelData.append("propertyID", CLOUDBEDS_PROPERTY_ID);
                cancelData.append("reservationID", resId);
                cancelData.append("status", "canceled");

                const cbCancelRes = await axios.put("https://api.cloudbeds.com/api/v1.1/putReservation", cancelData.toString(), {
                    headers: {
                        "x-api-key": CLOUDBEDS_API_KEY,
                        "Content-Type": "application/x-www-form-urlencoded"
                    }
                });
                cbStatus = cbCancelRes.data.success ? `Cancelled [CB#${resId}]` : (cbCancelRes.data.message || "Failed");
            }

            // Sync removal to Google Sheet
            let sheetStatus = "N/A";
            if (process.env.HOTEL_SHEET_API_URL) {
                try {
                    const sheetPayload = {
                        action: 'REMOVE',
                        target_dates: args.target_dates || [],
                        old_guest_match: args.old_guest_match || args.guest_name
                    };
                    const sheetRes = await axios.post(process.env.HOTEL_SHEET_API_URL, sheetPayload);
                    sheetStatus = (typeof sheetRes.data === 'string' && sheetRes.data.includes('<html')) ? "AppsScript HTML" : (sheetRes.data.message || sheetRes.data.status || "Removed from sheet");
                } catch (sErr) {
                    sheetStatus = `Sheet remove error: ${sErr.message}`;
                }
            }

            // Telegram notification tagging Ketut
            if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                const alertMsg = `🏨 *HOTEL RESERVATION CANCELLATION (${callerSource})*\n` +
                    `🛎️ **Attention: ${KETUT_TELEGRAM_HANDLE}**\n\n` +
                    `👤 Guest: *${args.guest_name || args.old_guest_match || 'N/A'}*\n` +
                    `🆔 Cloudbeds: ${cbStatus}\n` +
                    `📊 Google Sheet: ${sheetStatus}\n\n` +
                    `⚠️ Room returned to live inventory.`;
                await sendTelegramAlert(alertMsg);
            }

            return `Cancellation processed: Cloudbeds: ${cbStatus} | Google Sheet: ${sheetStatus}`;
        }

        // 5. UPDATE RESERVATION
        if (action === 'UPDATE') {
            let sheetStatus = "N/A";
            if (process.env.HOTEL_SHEET_API_URL) {
                try {
                    const sheetRes = await axios.post(process.env.HOTEL_SHEET_API_URL, args);
                    sheetStatus = sheetRes.data?.message || sheetRes.data?.status || "Updated in sheet";
                } catch (err) {
                    sheetStatus = err.message;
                }
            }

            if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                await sendTelegramAlert(
                    `🏨 *HOTEL RESERVATION UPDATE (${callerSource})*\n` +
                    `🛎️ **Attention: ${KETUT_TELEGRAM_HANDLE}**\n\n` +
                    `Action: UPDATE\n` +
                    `Guest: ${args.guest_name || args.old_guest_match || 'N/A'}\n` +
                    `Dates: ${(args.target_dates || []).join(', ')}\n` +
                    `Status: ${sheetStatus}`
                );
            }
            return `Hotel reservation updated: ${sheetStatus}`;
        }

        return `Unsupported hotel action: ${action}`;
    } catch (e) {
        console.error(`[Hotel Booking Exception]`, e.response ? e.response.data : e.message);
        return `Hotel processing error: ${e.response ? JSON.stringify(e.response.data) : e.message}`;
    }
}

async function executeTelegramTool(funcName, args) {
    if (funcName === 'check_recent_bookings') {
        console.log(`[Telegram Tool] AI is running check_recent_bookings`);
        const limit = args.limit || 10;
        const { data, error } = await supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(limit);
        return { bookings: data || [] };
    } else if (funcName === 'list_rules') {
        console.log(`[Telegram Tool] AI is running list_rules`);
        const { data, error } = await supabase.from('rules').select('rule_text').order('id', { ascending: true });
        return { rules: data || [], error: error ? error.message : null };
    } else if (funcName === 'add_rule') {
        console.log(`[Telegram Tool] AI is running add_rule with text: ${args.rule_text}`);
        const { error } = await supabase.from('rules').insert([{ rule_text: args.rule_text }]);
        if (error) console.error("[Supabase Error] add_rule failed:", error.message);
        return { status: error ? "failed" : "success", message: error ? error.message : "Rule added." };
    } else if (funcName === 'delete_rule') {
        console.log(`[Telegram Tool] AI is running delete_rule for match: ${args.rule_text_match}`);
        const { error } = await supabase.from('rules').delete().ilike('rule_text', `%${args.rule_text_match}%`);
        if (error) console.error("[Supabase Error] delete_rule failed:", error.message);
        return { status: error ? "failed" : "success", message: error ? error.message : "Rule deleted." };
    } else if (funcName === 'pause_customer') {
        console.log(`[Telegram Tool] AI is running pause_customer for: ${args.phone_number} duration: ${args.duration_minutes}m`);
        const strId = args.phone_number ? args.phone_number.toString().trim() : '';
        const cleanId = strId.replace(/\D/g, '');
        const pausedUntil = new Date();
        pausedUntil.setMinutes(pausedUntil.getMinutes() + (args.duration_minutes || 60));

        const records = [{ phone_number: strId, paused_until: pausedUntil.toISOString() }];
        if (cleanId && cleanId !== strId) {
            records.push({ phone_number: cleanId, paused_until: pausedUntil.toISOString() });
        }

        const { error } = await supabase.from('pause_state').upsert(records, { onConflict: 'phone_number' });

        if (error) console.error("[Supabase Error] pause_customer failed:", error.message);
        return { status: error ? "failed" : "success", message: error ? error.message : `Customer paused for ${args.duration_minutes || 60} minutes.` };
    } else if (funcName === 'unpause_customer') {
        console.log(`[Telegram Tool] AI is running unpause_customer for: ${args.phone_number}`);
        const strId = args.phone_number ? args.phone_number.toString().trim() : '';
        const cleanId = strId.replace(/\D/g, '');
        const idsToDelete = [strId];
        if (cleanId && cleanId !== strId) idsToDelete.push(cleanId);

        const { error } = await supabase.from('pause_state').delete().in('phone_number', idsToDelete);
        if (error) console.error("[Supabase Error] unpause_customer failed:", error.message);
        return { status: error ? "failed" : "success", message: error ? error.message : "Customer unpaused." };
    } else if (funcName === 'message_customer') {
        console.log(`[Telegram Tool] AI is running message_customer for: ${args.phone_number}`);
        const strId = args.phone_number ? args.phone_number.toString().trim() : '';
        const cleanId = strId.replace(/\D/g, '');
        const idsToDelete = [strId];
        if (cleanId && cleanId !== strId) idsToDelete.push(cleanId);
        await supabase.from('pause_state').delete().in('phone_number', idsToDelete);
        let botReply;
        if (ACTIVE_AI === 'qwen') {
            const qwenContext = [{ role: 'user', content: `[ADMIN OVERRIDE INSTRUCTION: ${args.instruction}]` }];
            botReply = await callQwen(args.phone_number, null, qwenContext);
            if (!botReply) botReply = await callDeepSeek(args.phone_number, null, qwenContext);
            if (!botReply) botReply = await callGemini(args.phone_number, [{ role: 'user', parts: [{ text: `[ADMIN OVERRIDE INSTRUCTION: ${args.instruction}]` }] }]);
        } else if (ACTIVE_AI === 'deepseek') {
            const deepseekContext = [{ role: 'user', content: `[ADMIN OVERRIDE INSTRUCTION: ${args.instruction}]` }];
            botReply = await callDeepSeek(args.phone_number, null, deepseekContext);
            if (!botReply) botReply = await callQwen(args.phone_number, null, deepseekContext);
            if (!botReply) botReply = await callGemini(args.phone_number, [{ role: 'user', parts: [{ text: `[ADMIN OVERRIDE INSTRUCTION: ${args.instruction}]` }] }]);
        } else {
            const extraContext = [{ role: 'user', parts: [{ text: `[ADMIN OVERRIDE INSTRUCTION: ${args.instruction}]` }] }];
            botReply = await callGemini(args.phone_number, extraContext);
        }
        if (botReply) {
            const delayMs = Math.min(2000 + (botReply.length * 30), 12000);
            await sleep(delayMs);
            await sendWhatsAppMessage(args.phone_number, botReply);
            return { status: "success", generated_message: botReply };
        } else {
            return { status: "failed", message: "Failed to generate a reply." };
        }
    } else if (funcName === 'search_sheet_booking') {
        console.log(`[Telegram Tool] AI is running search_sheet_booking for: ${args.search_query}`);
        let sheetStatus = "error";
        let sheetMessage = "GOOGLE_SHEET_API_URL not configured in backend.";
        if (process.env.GOOGLE_SHEET_API_URL) {
            try {
                const sheetRes = await axios.post(process.env.GOOGLE_SHEET_API_URL, { action: 'SEARCH', search_query: args.search_query, target_month: args.target_month });
                sheetStatus = "success";
                sheetMessage = (typeof sheetRes.data === 'string' && sheetRes.data.includes('<html')) ? "Google Apps Script error." : (sheetRes.data.status || "Completed");
            } catch (err) {
                sheetMessage = err.message;
            }
        }
        return { status: sheetStatus, message: sheetMessage };
    } else if (funcName === 'manage_hotel_booking' || funcName === 'search_hotel_booking') {
        console.log(`[Telegram Tool] AI is running ${funcName} for staff:`, JSON.stringify(args));
        const hotelResult = await handleHotelBooking(args, funcName, "TELEGRAM (Staff/Ketut)");
        return { status: "success", result: hotelResult };
    }
    return { status: "error", message: "Unknown tool function." };
}

// NEW QWEN TELEGRAM FUNCTION
async function callQwenTelegram(text) {
    const systemPrompt = await buildSystemPrompt(false);
    const telegramPrompt = `${systemPrompt}\n\n[SYSTEM OVERRIDE]: You are currently talking to your own internal staff team in a private Telegram group. They are asking you a question about the dive shop, bookings, or your instructions. Answer them helpfully, clearly, and concisely. Do NOT try to sell them anything.\n\nCRITICAL INSTRUCTION: You have access to database tools (add_rule, delete_rule, list_rules, check_recent_bookings, pause_customer, unpause_customer, message_customer). If a staff member asks you to check bookings, add a rule, or message/pause/unpause a customer, you MUST actually invoke the corresponding tool function! Do NOT just pretend or make up an answer.\n\nHOTEL & ROOM MANAGEMENT (KETUT / STAFF OVERRIDE):
You have direct access to live Cloudbeds PMS and Google Sheet for hotel operations:
- 'manage_hotel_booking': Use action='CHECK_CAPACITY' (dates) to check room availability, action='ADD' to book a room, action='REMOVE' or 'CANCEL' to cancel a booking, or 'UPDATE'.
- 'search_hotel_booking': Use to find a guest or reservation.
Note: Currently only 8 Deluxe Room Garden View rooms are active (Dorm is inactive for now).
Ketut Darmaja (@ketutdarmaja) is the Hotel Manager. If Ketut or any staff asks you to check availability, make a booking, cancel a booking, or check guest details, you MUST invoke 'manage_hotel_booking' or 'search_hotel_booking' directly! Do NOT pretend or make up an answer.`;

    const qwenTelegramTools = [
        { type: "function", function: { name: "check_recent_bookings", description: "Look up recent bookings in the database.", parameters: { type: "object", properties: { limit: { type: "integer" } } } } },
        { type: "function", function: { name: "list_rules", description: "Fetch all current rules from the master database.", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "add_rule", description: "Add a new rule to the master database.", parameters: { type: "object", properties: { rule_text: { type: "string" } }, required: ["rule_text"] } } },
        { type: "function", function: { name: "delete_rule", description: "Delete an existing rule.", parameters: { type: "object", properties: { rule_text_match: { type: "string" } }, required: ["rule_text_match"] } } },
        { type: "function", function: { name: "pause_customer", description: "Pause the AI for a specific customer for a given number of minutes.", parameters: { type: "object", properties: { phone_number: { type: "string" }, duration_minutes: { type: "integer" } }, required: ["phone_number", "duration_minutes"] } } },
        { type: "function", function: { name: "unpause_customer", description: "Unpause the AI for a specific customer.", parameters: { type: "object", properties: { phone_number: { type: "string" } }, required: ["phone_number"] } } },
        { type: "function", function: { name: "message_customer", description: "Message a customer.", parameters: { type: "object", properties: { phone_number: { type: "string" }, instruction: { type: "string" } }, required: ["phone_number", "instruction"] } } },
        { type: "function", function: { name: "search_sheet_booking", description: "Search the live Google Sheet schedule.", parameters: { type: "object", properties: { search_query: { type: "string" }, target_month: { type: "string" } }, required: ["search_query"] } } },
        { type: "function", function: { name: "manage_hotel_booking", description: "Manage hotel rooms in Cloudbeds PMS & Google Sheet. Actions: 'CHECK_CAPACITY' (check room availability), 'ADD' (book room), 'REMOVE' or 'CANCEL' (cancel booking), 'SEARCH', 'UPDATE'. Only 8 Deluxe Garden View rooms are active (dorm inactive).", parameters: { type: "object", properties: { action: { type: "string", description: "Must be 'CHECK_CAPACITY', 'ADD', 'REMOVE', 'CANCEL', 'SEARCH', or 'UPDATE'" }, target_dates: { type: "array", items: { type: "string" }, description: "Array of stay dates in YYYY-MM-DD format (e.g. ['2026-11-10', '2026-11-11'])" }, startDate: { type: "string", description: "Check-in date (YYYY-MM-DD)" }, endDate: { type: "string", description: "Check-out date (YYYY-MM-DD)" }, guest_name: { type: "string", description: "Full guest name" }, guest_phone: { type: "string", description: "Guest phone number" }, guest_email: { type: "string", description: "Guest email address" }, rooms_count: { type: "integer", description: "Number of rooms (default 1)" }, pax: { type: "integer", description: "Number of guests" },
                custom_rate: { type: "string", description: "Optional manual / negotiated price for direct sale, e.g. 'IDR 600,000/night'" },
                deposit_paid: { type: "boolean", description: "REQUIRED for customer chats: Must be true indicating customer paid the online deposit. Strictly forbidden to execute ADD if false or unpaid." }, reservation_id: { type: "string", description: "Cloudbeds reservation ID for cancellation or lookup" }, old_guest_match: { type: "string", description: "Substring of guest name to cancel or update" }, search_query: { type: "string", description: "Guest name to search" } }, required: ["action"] } } },
        { type: "function", function: { name: "search_hotel_booking", description: "Search live hotel reservations and guests in Cloudbeds and Google Sheet.", parameters: { type: "object", properties: { search_query: { type: "string", description: "Guest name or reservation ID to search" }, target_month: { type: "string", description: "Optional target month" } }, required: ["search_query"] } } }
    ];

    let messages = [
        { role: 'system', content: telegramPrompt },
        { role: 'user', content: text }
    ];

    try {
        let response = await axios.post(QWEN_API_URL, {
            model: QWEN_MODEL, messages: messages, tools: qwenTelegramTools, temperature: 0.7
        }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${QWEN_API_KEY}` } });

        if (response.data.choices && response.data.choices.length > 0) {
            let message = response.data.choices[0].message;

            while (message.tool_calls && message.tool_calls.length > 0) {
                messages.push(message);

                for (const toolCall of message.tool_calls) {
                    const funcName = toolCall.function.name;
                    let args = {};
                    try { args = JSON.parse(toolCall.function.arguments || '{}'); }
                    catch (e) { console.error(`[Qwen JSON Error] ${funcName}:`, e.message); }
                    const toolResult = await executeTelegramTool(funcName, args);
                    messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
                }

                response = await axios.post(QWEN_API_URL, {
                    model: QWEN_MODEL, messages: messages, tools: qwenTelegramTools, temperature: 0.7
                }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${QWEN_API_KEY}` } });

                message = response.data.choices[0].message;
            }
            if (message.content) return message.content;
        }
    } catch (e) {
        console.error("Qwen Telegram Error:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
    return null;
}

async function callDeepSeekTelegram(text) {
    const systemPrompt = await buildSystemPrompt(false);
    const telegramPrompt = `${systemPrompt}\n\n[SYSTEM OVERRIDE]: You are currently talking to your own internal staff team in a private Telegram group. They are asking you a question about the dive shop, bookings, or your instructions. Answer them helpfully, clearly, and concisely. Do NOT try to sell them anything.\n\nCRITICAL INSTRUCTION: You have access to database tools (add_rule, delete_rule, list_rules, check_recent_bookings, pause_customer, unpause_customer, message_customer). If a staff member asks you to check bookings, add a rule, or message/pause/unpause a customer, you MUST actually invoke the corresponding tool function! Do NOT just pretend or make up an answer.\n\nHOTEL & ROOM MANAGEMENT (KETUT / STAFF OVERRIDE):
You have direct access to live Cloudbeds PMS and Google Sheet for hotel operations:
- 'manage_hotel_booking': Use action='CHECK_CAPACITY' (dates) to check room availability, action='ADD' to book a room, action='REMOVE' or 'CANCEL' to cancel a booking, or 'UPDATE'.
- 'search_hotel_booking': Use to find a guest or reservation.
Note: Currently only 8 Deluxe Room Garden View rooms are active (Dorm is inactive for now).
Ketut Darmaja (@ketutdarmaja) is the Hotel Manager. If Ketut or any staff asks you to check availability, make a booking, cancel a booking, or check guest details, you MUST invoke 'manage_hotel_booking' or 'search_hotel_booking' directly! Do NOT pretend or make up an answer.`;

    const deepseekTelegramTools = [
        { type: "function", function: { name: "check_recent_bookings", description: "Look up recent bookings in the database.", parameters: { type: "object", properties: { limit: { type: "integer" } } } } },
        { type: "function", function: { name: "list_rules", description: "Fetch all current rules from the master database.", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "add_rule", description: "Add a new rule to the master database.", parameters: { type: "object", properties: { rule_text: { type: "string" } }, required: ["rule_text"] } } },
        { type: "function", function: { name: "delete_rule", description: "Delete an existing rule.", parameters: { type: "object", properties: { rule_text_match: { type: "string" } }, required: ["rule_text_match"] } } },
        { type: "function", function: { name: "pause_customer", description: "Pause the AI for a specific customer for a given number of minutes.", parameters: { type: "object", properties: { phone_number: { type: "string" }, duration_minutes: { type: "integer" } }, required: ["phone_number", "duration_minutes"] } } },
        { type: "function", function: { name: "unpause_customer", description: "Unpause the AI for a specific customer.", parameters: { type: "object", properties: { phone_number: { type: "string" } }, required: ["phone_number"] } } },
        { type: "function", function: { name: "message_customer", description: "Message a customer.", parameters: { type: "object", properties: { phone_number: { type: "string" }, instruction: { type: "string" } }, required: ["phone_number", "instruction"] } } },
        { type: "function", function: { name: "search_sheet_booking", description: "Search the live Google Sheet schedule.", parameters: { type: "object", properties: { search_query: { type: "string" }, target_month: { type: "string" } }, required: ["search_query"] } } },
        { type: "function", function: { name: "manage_hotel_booking", description: "Manage hotel rooms in Cloudbeds PMS & Google Sheet. Actions: 'CHECK_CAPACITY' (check room availability), 'ADD' (book room), 'REMOVE' or 'CANCEL' (cancel booking), 'SEARCH', 'UPDATE'. Only 8 Deluxe Garden View rooms are active (dorm inactive).", parameters: { type: "object", properties: { action: { type: "string", description: "Must be 'CHECK_CAPACITY', 'ADD', 'REMOVE', 'CANCEL', 'SEARCH', or 'UPDATE'" }, target_dates: { type: "array", items: { type: "string" }, description: "Array of stay dates in YYYY-MM-DD format (e.g. ['2026-11-10', '2026-11-11'])" }, startDate: { type: "string", description: "Check-in date (YYYY-MM-DD)" }, endDate: { type: "string", description: "Check-out date (YYYY-MM-DD)" }, guest_name: { type: "string", description: "Full guest name" }, guest_phone: { type: "string", description: "Guest phone number" }, guest_email: { type: "string", description: "Guest email address" }, rooms_count: { type: "integer", description: "Number of rooms (default 1)" }, pax: { type: "integer", description: "Number of guests" },
                custom_rate: { type: "string", description: "Optional manual / negotiated price for direct sale, e.g. 'IDR 600,000/night'" },
                deposit_paid: { type: "boolean", description: "REQUIRED for customer chats: Must be true indicating customer paid the online deposit. Strictly forbidden to execute ADD if false or unpaid." }, reservation_id: { type: "string", description: "Cloudbeds reservation ID for cancellation or lookup" }, old_guest_match: { type: "string", description: "Substring of guest name to cancel or update" }, search_query: { type: "string", description: "Guest name to search" } }, required: ["action"] } } },
        { type: "function", function: { name: "search_hotel_booking", description: "Search live hotel reservations and guests in Cloudbeds and Google Sheet.", parameters: { type: "object", properties: { search_query: { type: "string", description: "Guest name or reservation ID to search" }, target_month: { type: "string", description: "Optional target month" } }, required: ["search_query"] } } }
    ];

    let messages = [
        { role: 'system', content: telegramPrompt },
        { role: 'user', content: text }
    ];

    try {
        let response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-flash', messages: messages, tools: deepseekTelegramTools, temperature: 0.7
        }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });

        if (response.data.choices && response.data.choices.length > 0) {
            let message = response.data.choices[0].message;

            while (message.tool_calls && message.tool_calls.length > 0) {
                messages.push(message);

                for (const toolCall of message.tool_calls) {
                    const funcName = toolCall.function.name;
                    let args = {};
                    try {
                        args = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        console.error(`[DeepSeek JSON Error] ${funcName}:`, e.message);
                    }
                    const toolResult = await executeTelegramTool(funcName, args);
                    messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
                }

                response = await axios.post('https://api.deepseek.com/chat/completions', {
                    model: 'deepseek-flash', messages: messages, tools: deepseekTelegramTools, temperature: 0.7
                }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });

                message = response.data.choices[0].message;
            }

            if (message.content) {
                return message.content;
            }
        }
    } catch (e) {
        console.error("DeepSeek Telegram Error:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
    return null;
}

async function callGeminiTelegram(text) {
    const systemPrompt = await buildSystemPrompt();
    const telegramPrompt = `${systemPrompt}\n\n[SYSTEM OVERRIDE]: You are currently talking to your own internal staff team in a private Telegram group. They are asking you a question about the dive shop, bookings, or your instructions. Answer them helpfully, clearly, and concisely. Do NOT try to sell them anything.\n\nCRITICAL INSTRUCTION: You have access to database tools (add_rule, delete_rule, list_rules, check_recent_bookings, pause_customer, unpause_customer, message_customer). If a staff member asks you to check bookings, add a rule, or message/pause/unpause a customer, you MUST actually invoke the corresponding tool function! Do NOT just pretend or make up an answer.\n\nHOTEL & ROOM MANAGEMENT (KETUT / STAFF OVERRIDE):
You have direct access to live Cloudbeds PMS and Google Sheet for hotel operations:
- 'manage_hotel_booking': Use action='CHECK_CAPACITY' (dates) to check room availability, action='ADD' to book a room, action='REMOVE' or 'CANCEL' to cancel a booking, or 'UPDATE'.
- 'search_hotel_booking': Use to find a guest or reservation.
Note: Currently only 8 Deluxe Room Garden View rooms are active (Dorm is inactive for now).
Ketut Darmaja (@ketutdarmaja) is the Hotel Manager. If Ketut or any staff asks you to check availability, make a booking, cancel a booking, or check guest details, you MUST invoke 'manage_hotel_booking' or 'search_hotel_booking' directly! Do NOT pretend or make up an answer.`;

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
                name: "pause_customer",
                description: "Pause the AI for a specific customer for a given number of minutes.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        phone_number: { type: "STRING", description: "The customer's phone number without the '+' sign (e.g., 628123456789)" },
                        duration_minutes: { type: "INTEGER", description: "The number of minutes to pause the AI for (e.g., 60, 1440)." }
                    },
                    required: ["phone_number", "duration_minutes"]
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
            }, {
                name: "search_sheet_booking",
                description: "Search the live Google Sheet schedule for a customer's booking. ALWAYS use this if staff asks to check the sheet.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        search_query: { type: "STRING", description: "Customer name or string to search for across the sheet." }
                    },
                    required: ["search_query"]
                }
            }, {
                name: "manage_hotel_booking",
                description: "Manage hotel rooms in Cloudbeds PMS & Google Sheet. Actions: 'CHECK_CAPACITY' (check room availability), 'ADD' (book room), 'REMOVE' or 'CANCEL' (cancel booking), 'SEARCH', 'UPDATE'. Only 8 Deluxe Garden View rooms are active (dorm inactive).",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        action: { type: "STRING", description: "Must be 'CHECK_CAPACITY', 'ADD', 'REMOVE', 'CANCEL', 'SEARCH', or 'UPDATE'" },
                        target_dates: { type: "ARRAY", items: { type: "STRING" }, description: "Array of stay dates in YYYY-MM-DD format (e.g. ['2026-11-10', '2026-11-11'])" },
                        startDate: { type: "STRING", description: "Check-in date (YYYY-MM-DD)" },
                        endDate: { type: "STRING", description: "Check-out date (YYYY-MM-DD)" },
                        guest_name: { type: "STRING", description: "Full guest name" },
                        guest_phone: { type: "STRING", description: "Guest phone number" },
                        guest_email: { type: "STRING", description: "Guest email address" },
                        rooms_count: { type: "INTEGER", description: "Number of rooms (default 1)" },
                        pax: { type: "INTEGER", description: "Number of guests" },
                custom_rate: { type: "STRING", description: "Optional manual / negotiated price for direct sale, e.g. 'IDR 600,000/night'" },
                deposit_paid: { type: "BOOLEAN", description: "REQUIRED for customer chats: Must be true indicating customer paid the online deposit. Strictly forbidden to execute ADD if false or unpaid." },
                        reservation_id: { type: "STRING", description: "Cloudbeds reservation ID for cancellation or lookup" },
                        old_guest_match: { type: "STRING", description: "Substring of guest name to cancel or update" },
                        search_query: { type: "STRING", description: "Guest name to search" }
                    },
                    required: ["action"]
                }
            }, {
                name: "search_hotel_booking",
                description: "Search live hotel reservations and guests in Cloudbeds and Google Sheet.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        search_query: { type: "STRING", description: "Guest name or reservation ID to search" },
                        target_month: { type: "STRING", description: "Optional target month" }
                    },
                    required: ["search_query"]
                }
            }]
        }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        if (response.data.candidates && response.data.candidates.length > 0) {
            const part = response.data.candidates[0].content.parts[0];

            if (part.functionCall) {
                const call = part.functionCall;
                let funcResCtx = null;

                const toolResult = await executeTelegramTool(call.name, call.args || {});
                funcResCtx = { role: "function", parts: [{ functionResponse: { name: call.name, response: toolResult } }] };

                if (funcResCtx) {
                    const secondPayload = {
                        system_instruction: { parts: [{ text: telegramPrompt }] },
                        contents: [
                            { role: "user", parts: [{ text: text }] },
                            response.data.candidates[0].content,
                            funcResCtx
                        ]
                    };

                    const res2 = await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

        // SECURITY FIX: Only allow the authorized group chat OR the authorized personal admin chat
        const allowedPrivateChat = process.env.PERSONAL_TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID;
        if (chatId === TELEGRAM_CHAT_ID || chatId === allowedPrivateChat) {
            const isMentioned = text.includes('@SelenaSanctumBot');
            const isPrivate = update.message.chat.type === 'private';

            if (isMentioned || isPrivate) {
                const cleanText = text.replace('@SelenaSanctumBot', '').trim();
                if (cleanText.length === 0) return;

                if (cleanText.toLowerCase().startsWith('!switch_ai ')) {
                    const newAi = cleanText.split(' ')[1].toLowerCase();
                    if (newAi === 'qwen' || newAi === 'gemini' || newAi === 'deepseek') {
                        ACTIVE_AI = newAi;
                        await sendTelegramAlert(`✅ 🧠 AI Brain switched to **${newAi.toUpperCase()}** successfully for WhatsApp traffic.`);
                    } else {
                        await sendTelegramAlert(`❌ Unknown AI provider. Use '!switch_ai qwen', '!switch_ai deepseek', or '!switch_ai gemini'`);
                    }
                    return;
                }

                if (cleanText.toLowerCase() === '!status') {
                    await sendTelegramAlert(`🤖 Current AI Engine running: ${ACTIVE_AI.toUpperCase()}`);
                    return;
                }

                console.log(`[Telegram] Question from staff: ${cleanText}`);

                try {
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
                        chat_id: chatId,
                        action: "typing"
                    });

                    let reply = "";
                    if (ACTIVE_AI === 'qwen') {
                        reply = await callQwenTelegram(cleanText);
                    } else if (ACTIVE_AI === 'deepseek') {
                        reply = await callDeepSeekTelegram(cleanText);
                    } else {
                        reply = await callGeminiTelegram(cleanText);
                    }

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

app.get('/instagram-webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_IG_VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).send("Forbidden");
});

// ==========================================
// 1.5 KIOSK & QWEN TEST API (Web Interface)
// ==========================================
app.post('/qwen-test', async (req, res) => {
    // SECURITY FIX: Prevent unauthorized users from burning your API credits
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${META_VERIFY_TOKEN}`) {
        return res.status(403).json({ error: "Forbidden: Invalid or missing token" });
    }

    try {
        const { messages, temperature } = req.body;

        const qwenRes = await axios.post(QWEN_API_URL, {
            model: QWEN_MODEL,
            messages: messages || [],
            temperature: temperature || 0.7
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${QWEN_API_KEY}`
            }
        });

        return res.json(qwenRes.data);
    } catch (e) {
        console.error("Qwen Test Proxy Error", e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.post('/kiosk-chat', async (req, res) => {
    const { text, language } = req.body;
    if (!text) return res.status(400).send("No text provided");

    try {
        console.log(`[Kiosk] Received text: ${text}`);
        const extraContext = [{
            role: 'user',
            parts: [{ text: `[SYSTEM OVERRIDE: You are speaking to a physical person at the front desk kiosk. Keep answers short, conversational, and friendly. DO NOT use any emojis, emoticons, or action asterisks (like *smiles*), as they will be read awkwardly by the text-to-speech engine. Speak naturally with human intonation. They are speaking to you in this language: ${language || 'English'}. Reply in that language. If the customer wants to speak with a human, or if they ask a question you cannot answer, organically tell them to WhatsApp our Human Agent at +6281285325669.]` }]
        }];

        const botReply = await callGemini('KIOSK_DESK_1', extraContext.concat([{ role: 'user', parts: [{ text: text }] }]), "gemini-3.1-flash-lite");
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
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
    res.status(200).send({ status: "success" });
    processWebhook(req.body).catch(console.error);
});

app.post('/instagram-webhook', (req, res) => {
    res.status(200).send({ status: "success" });
    processInstagramWebhook(req.body).catch(console.error);
});

async function processWebhook(data) {
    if (data.object !== 'whatsapp_business_account') return;
    const entry = data.entry[0];

    for (let i = 0; i < entry.changes.length; i++) {
        const change = entry.changes[i];
        const value = change.value;
        await sleep(1500);

        if (change.field === 'statuses' || value.statuses) {
            const statusList = value.statuses;
            if (statusList && statusList.length > 0) {
                const statusObj = statusList[0];
                if (statusObj.status === 'failed') {
                    console.error(`[WhatsApp Delivery FAILED] To: ${statusObj.recipient_id}, Message ID: ${statusObj.id}, Errors:`, JSON.stringify(statusObj.errors || statusObj));
                }
                if (statusObj.status === 'sent') {
                    const msgId = statusObj.id;
                    const rawRecipient = statusObj.recipient_id ? statusObj.recipient_id.toString() : null;
                    const cleanRecipient = rawRecipient ? rawRecipient.replace(/\D/g, '') : null;
                    const aiSent = cacheGet(msgId) || 
                                   (rawRecipient ? cacheGet(`ai_sent_${rawRecipient}`) : false) || 
                                   (cleanRecipient ? cacheGet(`ai_sent_${cleanRecipient}`) : false);

                    if (!aiSent && rawRecipient) {
                        cacheSet(`last_paused_target`, rawRecipient, 15);
                        const orphanedText = cacheGet(`orphan_echo`);
                        if (orphanedText) {
                            await pauseAI(rawRecipient, orphanedText);
                            cacheDelete(`orphan_echo`);
                        } else {
                            const isPaused = await checkIsPaused(rawRecipient);
                            if (!isPaused) {
                                await pauseAI(rawRecipient, "[Human agent took over conversation]");
                            }
                        }
                    }
                }
            }
        }

        if (change.field === 'messages' || change.field === 'smb_message_echoes' || change.field === 'message_echoes') {
            const messageList = value.messages || value.message_echoes || value.smb_message_echoes;
            if (messageList && messageList.length > 0) {
                const messageObj = messageList[0];

                const validTypes = ['text', 'image', 'audio', 'document', 'system', 'unsupported'];
                if (validTypes.includes(messageObj.type)) {
                    let textBody = "";
                    let isMedia = false;
                    let mediaType = null;
                    let mediaId = null;
                    let mimeType = null;

                    if (messageObj.type === 'text') {
                        textBody = messageObj.text.body;
                    } else if (messageObj.type === 'image') {
                        isMedia = true;
                        mediaType = 'image';
                        mediaId = messageObj.image.id;
                        mimeType = messageObj.image.mime_type;
                        textBody = messageObj.image.caption || "";
                    } else if (messageObj.type === 'audio') {
                        isMedia = true;
                        mediaType = 'audio';
                        mediaId = messageObj.audio.id;
                        mimeType = messageObj.audio.mime_type;
                        textBody = "";
                    } else if (messageObj.type === 'document') {
                        isMedia = true;
                        mediaType = 'document';
                        mediaId = messageObj.document.id;
                        mimeType = messageObj.document.mime_type;
                        textBody = messageObj.document.caption || messageObj.document.filename || "";
                    } else if (messageObj.type === 'system' || messageObj.type === 'unsupported') {
                        textBody = "[SYSTEM SIGNAL: Customer attempted to start a voice/video call or sent an unsupported attachment. You cannot accept voice calls. Politely greet them, mention you are the chat agent (Selena), and ask how you can help them over text instead.]";
                    }

                    const isEcho = (change.field === 'smb_message_echoes' || change.field === 'message_echoes' || messageObj.from_me === true);

                    if (isEcho) {
                        const msgId = messageObj.id;
                        let targetId = messageObj.to;
                        if (!targetId && value.contacts && value.contacts.length > 0) {
                            targetId = value.contacts[0].wa_id || value.contacts[0].user_id || value.contacts[0].id;
                        }
                        const rawTarget = targetId ? targetId.toString() : null;
                        const cleanTarget = rawTarget ? rawTarget.replace(/\D/g, '') : null;

                        const aiSent = cacheGet(msgId) || 
                                       (rawTarget ? cacheGet(`ai_sent_${rawTarget}`) : false) || 
                                       (cleanTarget ? cacheGet(`ai_sent_${cleanTarget}`) : false);

                        if (!aiSent) {
                            let contextToSave = textBody;
                            if (isMedia) contextToSave = `[Human agent sent a ${mediaType}: ${textBody}]`;

                            if (rawTarget) {
                                await pauseAI(rawTarget, contextToSave);
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
                        let senderId = messageObj.from || messageObj.from_user_id || messageObj.user_id;
                        if (!senderId && value.contacts && value.contacts.length > 0) {
                            senderId = value.contacts[0].wa_id || value.contacts[0].user_id || value.contacts[0].id;
                        }
                        if (!senderId) {
                            console.error("[Warning] Could not extract customer ID! Ignoring. Message:", JSON.stringify(messageObj), "Full Value:", JSON.stringify(value));
                            return;
                        }

                        if (!isMedia && ADMIN_NUMBERS.includes(senderId) && (textBody.toLowerCase().startsWith('!learn') || textBody.toLowerCase().startsWith('!rule'))) {
                            await handleAdminCommand(senderId, textBody);
                            return;
                        }

                        if (process.env.AI_PAUSED === 'true') {
                            console.log(`[System] AI_PAUSED is active. Ignoring message from ${senderId}.`);
                            return;
                        }

                        if (process.env.NIGHT_MODE_ONLY === 'true') {
                            const now = new Date();
                            const baliFormatter = new Intl.DateTimeFormat('en-US', {
                                timeZone: 'Asia/Makassar',
                                hour: '2-digit',
                                hour12: false
                            });
                            const currentHour = parseInt(baliFormatter.format(now));
                            if (currentHour >= 9 && currentHour < 18) {
                                console.log(`[System] Night Mode Active (Bali time). Current hour is ${currentHour}. Ignoring message from ${senderId}.`);
                                return;
                            }
                        }

                        const isPaused = await checkIsPaused(senderId);

                        let contextToSave = textBody;
                        if (isMedia) {
                            console.log(`[Media Received] Analyzing ${mediaType} from ${senderId}...`);
                            const mediaData = await downloadMedia(mediaId, mimeType, senderId);
                            if (mediaData) {
                                const description = await analyzeMedia(mediaData.buffer, mediaData.mimeType, textBody, mediaType);
                                contextToSave = `[Customer sent a ${mediaType}: ${description}]`;
                            } else {
                                contextToSave = `[Customer sent a ${mediaType}, but it could not be downloaded] ${textBody}`;
                            }
                        }

                        if (isPaused) {
                            console.log(`[Auto-Pause] Customer ${senderId} is currently paused. Skipping AI reply.`);
                            await appendHistory(senderId, "user", contextToSave);
                        } else {
                            await appendHistory(senderId, "user", contextToSave);

                            let geminiReply;
                            if (ACTIVE_AI === 'deepseek') {
                                geminiReply = await callDeepSeek(senderId, null, [], 0, false, 'whatsapp');
                                if (!geminiReply) {
                                    console.error(`[AI Fallback] DeepSeek failed. Falling back to Qwen...`);
                                    geminiReply = await callQwen(senderId, null, [], 0, false, 'whatsapp');
                                    if (!geminiReply) {
                                        console.error(`[AI Fallback] Qwen failed to respond for ${senderId}. Falling back to Gemini...`);
                                        geminiReply = await callGemini(senderId, [], "gemini-3.8-flash", false, 0, 'whatsapp');
                                    }
                                }
                            } else if (ACTIVE_AI === 'qwen') {
                                geminiReply = await callQwen(senderId, null, [], 0, false, 'whatsapp');
                                if (!geminiReply) {
                                    console.error(`[AI Fallback] Qwen failed. Falling back to DeepSeek...`);
                                    geminiReply = await callDeepSeek(senderId, null, [], 0, false, 'whatsapp');
                                    if (!geminiReply) {
                                        console.error(`[AI Fallback] DeepSeek failed to respond for ${senderId}. Falling back to Gemini...`);
                                        geminiReply = await callGemini(senderId, [], "gemini-3.8-flash", false, 0, 'whatsapp');
                                    }
                                }
                            } else {
                                geminiReply = await callGemini(senderId, [], "gemini-3.8-flash", false, 0, 'whatsapp');
                            }

                            if (geminiReply) {
                                if (geminiReply.match(/IGNORE/i)) return;
                                const delayMs = Math.min(2000 + (geminiReply.length * 30), 12000);
                                console.log(`[Typing Delay] Waiting ${delayMs / 1000} seconds...`);
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

async function processInstagramWebhook(data) {
    if (data.object !== 'instagram') return;
    const entry = data.entry[0];

    if (entry.messaging) {
        for (let i = 0; i < entry.messaging.length; i++) {
            await handleInstagramMessagingEvent(entry.messaging[i]);
        }
    }

    if (entry.changes) {
        for (let i = 0; i < entry.changes.length; i++) {
            const change = entry.changes[i];
            if (change.field === 'comments') {
                await handleInstagramCommentEvent(change.value);
            }
        }
    }
}

async function handleInstagramMessagingEvent(messagingEvent) {
    const senderId = messagingEvent.sender.id;
    const recipientId = messagingEvent.recipient.id;

    if (messagingEvent.message) {
        const messageObj = messagingEvent.message;

        if (messageObj.is_echo) {
            const aiSent = cacheGet(`ai_sent_${recipientId}`);
            if (!aiSent) {
                const contextToSave = messageObj.text || "[Human sent media/attachment]";
                await pauseAI(recipientId, contextToSave);
            }
            return;
        }

        const textBody = messageObj.text || "";

        if (ADMIN_NUMBERS.includes(senderId) && (textBody.toLowerCase().startsWith('!learn') || textBody.toLowerCase().startsWith('!rule'))) {
            await handleAdminCommand(senderId, textBody);
            return;
        }

        const isPaused = await checkIsPaused(senderId);
        let contextToSave = textBody;

        let isStoryAction = false;
        if (messageObj.story && messageObj.story.mention) isStoryAction = true;
        if (messageObj.reply_to && messageObj.reply_to.story && !textBody.trim()) isStoryAction = true;
        if (messageObj.attachments && messageObj.attachments.length > 0) {
            const att = messageObj.attachments[0];
            if (att.type === 'share' || att.type === 'story_mention' || att.type === 'ig_reel') {
                if (!textBody.trim()) isStoryAction = true;
            }
        }

        if (isStoryAction) {
            contextToSave = "[User mentioned or shared our story/post] " + textBody;
            if (!isPaused) {
                console.log(`[Story Action] from ${senderId}`);
                await appendHistory(senderId, "user", contextToSave);

                let aiReply;
                if (ACTIVE_AI === 'deepseek') {
                    const extraContext = [{ role: "user", content: "Someone just mentioned us in their Instagram story! Reply warmly, thank them for the mention, and be enthusiastic with a nice emoji. Keep it very short (one sentence). Do NOT try to sell anything or offer any bookings. Just say thank you!" }];
                    aiReply = await callDeepSeek(senderId, null, extraContext, 0, false, 'instagram');
                    if (!aiReply) aiReply = await callQwen(senderId, null, extraContext, 0, false, 'instagram');
                    if (!aiReply) {
                        const geminiCtx = [{ role: "user", parts: [{ text: "Someone just mentioned us in their Instagram story! Reply warmly, thank them for the mention, and be enthusiastic with a nice emoji. Keep it very short (one sentence). Do NOT try to sell anything or offer any bookings. Just say thank you!" }] }];
                        aiReply = await callGemini(senderId, geminiCtx, "gemini-3.8-flash", false, 0, 'instagram');
                    }
                } else if (ACTIVE_AI === 'qwen') {
                    const extraContext = [{ role: "user", content: "Someone just mentioned us in their Instagram story! Reply warmly, thank them for the mention, and be enthusiastic with a nice emoji. Keep it very short (one sentence). Do NOT try to sell anything or offer any bookings. Just say thank you!" }];
                    aiReply = await callQwen(senderId, null, extraContext, 0, false, 'instagram');
                    if (!aiReply) aiReply = await callDeepSeek(senderId, null, extraContext, 0, false, 'instagram');
                    if (!aiReply) {
                        const geminiCtx = [{ role: "user", parts: [{ text: "Someone just mentioned us in their Instagram story! Reply warmly, thank them for the mention, and be enthusiastic with a nice emoji. Keep it very short (one sentence). Do NOT try to sell anything or offer any bookings. Just say thank you!" }] }];
                        aiReply = await callGemini(senderId, geminiCtx, "gemini-3.8-flash", false, 0, 'instagram');
                    }
                } else {
                    const geminiCtx = [{ role: "user", parts: [{ text: "Someone just mentioned us in their Instagram story! Reply warmly, thank them for the mention, and be enthusiastic with a nice emoji. Keep it very short (one sentence). Do NOT try to sell anything or offer any bookings. Just say thank you!" }] }];
                    aiReply = await callGemini(senderId, geminiCtx, "gemini-3.8-flash", false, 0, 'instagram');
                }

                if (aiReply) {
                    await sleep(3000);
                    await sendInstagramDM(senderId, aiReply);
                }
                return;
            }
        }

        if (messageObj.attachments && messageObj.attachments.length > 0) {
            const attachment = messageObj.attachments[0];
            if (attachment.type === 'image') {
                const imageUrl = attachment.payload.url;
                const mediaData = await downloadIGMedia(imageUrl);
                if (mediaData) {
                    const description = await analyzeMedia(mediaData.buffer, mediaData.mimeType, textBody, "image");
                    contextToSave = `[Customer sent an image: ${description}]`;
                } else {
                    contextToSave = `[Customer sent an image, but it could not be downloaded] ${textBody}`;
                }
            } else {
                contextToSave = `[Customer sent an attachment of type: ${attachment.type}] ${textBody}`;
            }
        }

        if (isPaused) {
            await appendHistory(senderId, "user", contextToSave);
        } else {
            await appendHistory(senderId, "user", contextToSave);

            let aiReply;
            if (ACTIVE_AI === 'deepseek') {
                aiReply = await callDeepSeek(senderId, null, [], 0, false, 'instagram');
                if (!aiReply) aiReply = await callQwen(senderId, null, [], 0, false, 'instagram');
                if (!aiReply) aiReply = await callGemini(senderId, [], "gemini-3.8-flash", false, 0, 'instagram');
            } else if (ACTIVE_AI === 'qwen') {
                aiReply = await callQwen(senderId, null, [], 0, false, 'instagram');
                if (!aiReply) aiReply = await callDeepSeek(senderId, null, [], 0, false, 'instagram');
                if (!aiReply) aiReply = await callGemini(senderId, [], "gemini-3.8-flash", false, 0, 'instagram');
            } else {
                aiReply = await callGemini(senderId, [], "gemini-3.8-flash", false, 0, 'instagram');
            }

            if (aiReply) {
                if (aiReply.match(/IGNORE/i)) return;
                const delayMs = Math.min(2000 + (aiReply.length * 30), 12000);
                await sleep(delayMs);
                await sendInstagramDM(senderId, aiReply);
            }
        }
    }
}

async function handleInstagramCommentEvent(commentValue) {
    const commentId = commentValue.id;
    const fromId = commentValue.from.id;
    const text = commentValue.text;

    if (fromId === META_IG_USER_ID) return;
    if (commentValue.hidden || commentValue.deleted) return;

    console.log(`[New Comment] from ${fromId}: ${text}`);
    const aiReply = await generateCommentReply(text);
    if (aiReply) {
        await sleep(4000);
        await replyToInstagramComment(commentId, aiReply);
    }
}

async function generateCommentReply(commentText) {
    const systemPrompt = `You are the friendly owner of an Instagram page. A user just commented on your post. Generate a short, positive, and appreciative reply to their comment. Keep it under 2 sentences, use nice emojis. If their comment is negative or toxic, reply with a calm, polite message or a simple acknowledgment.`;

    if (ACTIVE_AI === 'qwen') {
        try {
            const response = await axios.post(QWEN_API_URL, {
                model: QWEN_MODEL,
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `User's Comment: "${commentText}"` }]
            }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${QWEN_API_KEY}` } });
            if (response.data.choices && response.data.choices.length > 0) return response.data.choices[0].message.content;
        } catch (error) { console.error("Qwen Comment Reply Error:", error.message); }
    } else if (ACTIVE_AI === 'deepseek') {
        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-flash',
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `User's Comment: "${commentText}"` }]
            }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });

            if (response.data.choices && response.data.choices.length > 0) {
                return response.data.choices[0].message.content;
            }
        } catch (error) { console.error("DeepSeek Comment Reply Error:", error.message); }
    } else {
        try {
            const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: "user", parts: [{ text: `User's Comment: "${commentText}"` }] }]
            });
            if (response.data.candidates && response.data.candidates.length > 0) {
                return response.data.candidates[0].content.parts[0].text;
            }
        } catch (error) { console.error("Gemini Comment Reply Error:", error.message); }
    }
    return null;
}

// ==========================================
// 3. DATABASE MEMORY LOGIC
// ==========================================
async function getDeepSeekHistory(senderId) {
    if (!senderId) return [];
    const strId = senderId.toString().trim();
    const cleanId = strId.replace(/\D/g, '');
    const idsToFetch = [strId];
    if (cleanId && cleanId !== strId) {
        idsToFetch.push(cleanId);
    }

    const { data, error } = await supabase
        .from('conversations')
        .select('role, message_text')
        .in('phone_number', idsToFetch)
        .order('created_at', { ascending: false })
        .limit(10);
    if (error) return [];
    return data.reverse().map(row => ({
        role: row.role === 'model' ? 'assistant' : row.role,
        content: row.message_text
    }));
}

async function getHistory(senderId) {
    if (!senderId) return [];
    const strId = senderId.toString().trim();
    const cleanId = strId.replace(/\D/g, '');
    const idsToFetch = [strId];
    if (cleanId && cleanId !== strId) {
        idsToFetch.push(cleanId);
    }

    const { data, error } = await supabase
        .from('conversations')
        .select('role, message_text')
        .in('phone_number', idsToFetch)
        .order('created_at', { ascending: false })
        .limit(10);

    if (error) {
        console.error("Supabase Error (getHistory):", error);
        return [];
    }

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
    if (!senderId) return false;
    const strId = senderId.toString().trim();
    const cleanId = strId.replace(/\D/g, '');
    const idsToCheck = [strId];
    if (cleanId && cleanId !== strId) {
        idsToCheck.push(cleanId);
    }

    const { data, error } = await supabase
        .from('pause_state')
        .select('paused_until')
        .in('phone_number', idsToCheck)
        .order('paused_until', { ascending: false })
        .limit(1);

    if (error) console.error("Pause Check Error:", error.message);

    if (data && data.length > 0 && data[0].paused_until) {
        const pausedUntil = new Date(data[0].paused_until);
        if (pausedUntil > new Date()) {
            return true;
        }
    }
    return false;
}

async function pauseAI(senderId, humanMessage) {
    if (!senderId) return;
    const strId = senderId.toString().trim();
    const cleanId = strId.replace(/\D/g, '');
    const pausedUntil = new Date();
    pausedUntil.setMinutes(pausedUntil.getMinutes() + 3);

    const records = [{ phone_number: strId, paused_until: pausedUntil.toISOString() }];
    if (cleanId && cleanId !== strId) {
        records.push({ phone_number: cleanId, paused_until: pausedUntil.toISOString() });
    }

    await supabase.from('pause_state').upsert(records, { onConflict: 'phone_number' });

    await appendHistory(strId, "model", humanMessage);
    console.log(`[Auto-Pause] Paused AI for ${strId} for 3 minutes. Saved human context.`);
}

async function handleAdminCommand(adminId, commandText) {
    const rule = commandText.replace(/^!(learn|rule)\s*/i, '');
    await supabase.from('rules').insert([
        { rule_text: rule }
    ]);
    await sendWhatsAppMessage(adminId, `✅ Rule successfully added to Selena's brain:\n"${rule}"`);
    console.log(`[Admin Command] Added rule: ${rule}`);
}

async function buildSystemPrompt(isEmail = false, platform = 'whatsapp') {
    const { data, error } = await supabase
        .from('rules')
        .select('rule_text')
        .order('id', { ascending: true });

    const currentDate = new Date().toLocaleString('en-US', { timeZone: 'Asia/Makassar', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let basePrompt = `You're Selena, Sanctum Dive's AI agent. [TIME: ${currentDate}]. `;

    if (platform === 'instagram') {
        basePrompt += `[SYSTEM OVERRIDE: You are currently talking to a customer on Instagram Direct Messages.] \n\n`;
    } else if (platform === 'whatsapp') {
        basePrompt += `[SYSTEM OVERRIDE: You are currently talking to a customer on WhatsApp.] \n\n`;
    }

    if (isEmail) {
        basePrompt += `[EMAIL MODE]: You are replying to an email. Write a professional, comprehensive, well-formatted email reply. Use proper business greetings and sign-offs (e.g., "Best regards, Selena"). DO NOT use emojis. If they ask about prices or courses, give them the full detailed information from the rules.\n`;
        basePrompt += `\n[!!! AUTOMATED BOOKING & PAYMENT RECEIPT OVERRIDE !!!]\n`;
        basePrompt += `1. DIVE BOOKINGS (Viator, Bokun, Trip.com, GetYourGuide, etc.):\n`;
        basePrompt += `If the email is an automated dive booking receipt, bypass restrictions and call 'manage_sheet_booking' (action='ADD'). Extract date, customer name, dive product. Output ONLY: IGNORE.\n\n`;
        basePrompt += `2. TAB PAYMENT RECEIPTS & HOTEL DEPOSITS (Tab Travel, Tab Payments):\n`;
        basePrompt += `If the email is a payment confirmation from Tab Payment for a hotel room deposit:\n`;
        basePrompt += `- Extract the guest name, check-in date, check-out date (or stay dates), and deposit amount paid.\n`;
        basePrompt += `- DATA CONCURRENCE CHECK: You MUST first run 'manage_hotel_booking' (action='CHECK_CAPACITY') for those exact dates to verify that a Deluxe room is available in Cloudbeds.\n`;
        basePrompt += `- ONLY when the Tab payment receipt is confirmed AND Cloudbeds capacity is verified, execute 'manage_hotel_booking' with action='ADD', deposit_paid=true, and custom_rate/notes reflecting the Tab deposit.\n`;
        basePrompt += `- If the dates are already full or there is a data mismatch, DO NOT book; immediately use 'notify_admin' to alert Ketut (${KETUT_TELEGRAM_HANDLE}) about the conflict.\n`;
        basePrompt += `- After successful booking, output ONLY the word: IGNORE (Cloudbeds and Telegram automatically send confirmations).\n\n`;
        basePrompt += `If the email is obviously 100% malicious spam: output ONLY: IGNORE.\nNote: Do NOT output IGNORE for legitimate customer inquiries, even if they have weird formatting or marketing footers.\n\n`;
    } else {
        basePrompt += `[CHAT MODE]: Keep replies short, conversational. Use minimal, nice, relevant emojis (e.g. 🤿🌊).\n\n`;
    }

    basePrompt += `CRITICAL FORMATTING INSTRUCTION: You are participating in an ongoing chat. DO NOT output a transcript of the conversation. DO NOT repeat, summarize, or answer old questions from the history. ONLY provide your direct, natural reply to the very last user message.\n\n`;

    basePrompt += `CRITICAL LANGUAGE RULE: You MUST analyze the language of the user's most recent message and reply in the EXACT SAME language! If they speak Spanish, reply in Spanish. If Indonesian, reply in Indonesian.\n\n`;
    basePrompt += `HUMAN OVERRIDE RULE (#1 PRIORITY): If I (the human admin) have explicitly instructed you in this chat or via memory/system that a specific date is FULLY BOOKED or CLOSED, you MUST ALWAYS follow my human instruction FIRST. This completely overrides the Google Sheet capacity check! You do NOT even need to run CHECK_CAPACITY for that date. Just immediately refuse the booking and offer alternative dates.\n\n`;
    basePrompt += `CRITICAL REFUSAL RULE: If you are instructed that a date is fully booked, and a customer asks for that date: 1) If they provide their name, you MUST run SEARCH first. If they are already in the sheet, confirm their booking. If they are NOT in the sheet, apologize and offer alternative dates. 2) If they do NOT provide a name (just asking for availability), DO NOT ask for their name—just apologize, explain you are fully booked, and proactively offer alternative dates.\n\n`;
    basePrompt += `CRITICAL 'LAST WORD' RULE: You MUST always have the last word in a conversation. If the customer sends a simple statement, an 'okay', or a 'thank you', you MUST reply to politely acknowledge it (e.g., 'You're welcome!', 'Great, let me know if you need anything else!'). NEVER output 'IGNORE' just because they didn't ask a direct question.\n\n`;

    basePrompt += `CRITICAL: You manage TWO calendars: Dives ('manage_sheet_booking') and Hotel Rooms ('manage_hotel_booking').\n`;
    basePrompt += `CRITICAL TOOL RESTRICTION: For direct customer chats, you are STRICTLY FORBIDDEN from calling 'manage_sheet_booking' (ADD/UPDATE) or 'manage_hotel_booking' unless the customer has EXPLICITLY given you BOTH their Name AND their exact Dates. If missing, ask them first. (This restriction does NOT apply to automated email receipts or action='CHECK_CAPACITY').\n`;
    basePrompt += `CRITICAL HOTEL ONLINE DEPOSIT & TAB PAYMENT MANDATE:
- You are ONLY authorized to reserve or book a hotel room in Cloudbeds ('manage_hotel_booking' action='ADD') IF AND ONLY IF the payment went through on Tab Payment (or verified proof of online deposit payment has been received).
- DATA CONCURRENCE VERIFICATION: Before calling 'ADD', you MUST verify the concurrence of the data:
  1) Guest Name matches the Tab payment receipt.
  2) Stay dates match the guest's requested dates.
  3) Cloudbeds capacity check confirms the Deluxe room is available ('CHECK_CAPACITY').
- If the customer has not paid the online deposit yet, you are STRICTLY NOT AUTHORIZED to book or hold the room! Give them the Tab payment link, and politely explain that rooms can only be held once payment is confirmed.
- Only once online deposit payment is confirmed on Tab, set deposit_paid=true when calling 'manage_hotel_booking' (action='ADD').
- (Note: Internal staff like Ketut @ketutdarmaja in Telegram have admin override to book rooms directly for phone or walk-in guests).\n\n`;
    basePrompt += `CAPACITY CHECK RULE (#2 PRIORITY): Only if there is NO human override for a date, and a user asks for availability OR asks how many pax are booked, you MUST run 'manage_sheet_booking' with action: 'CHECK_CAPACITY' and 'target_date'. DO NOT manually count pax from search results. CRITICAL: When the tool returns the capacity, DO NOT tell the customer the exact number! Just say "Yes, we have availability!" or "Sorry, we are fully booked." Keep numbers strictly internal. If the sheet replies that it is full, you MUST politely refuse the booking!\n`;
    basePrompt += `LIFECYCLE: ALWAYS 'SEARCH' or 'CHECK_CAPACITY' first before making changes. CRITICAL: If a user asks you to check a booking, you MUST run the SEARCH tool. HOWEVER, if the recent chat history clearly shows you ALREADY successfully confirmed, updated, or checked their booking in this exact conversation, DO NOT run the SEARCH or UPDATE tools again! Just reply naturally to their ongoing messages (e.g. 'You're welcome!').\n`;
    basePrompt += `IMPORTANT: When you do have their name and date, use ONLY the FIRST 3 OR 4 LETTERS of their name as the search_query (e.g., take the first 3 letters of whatever their name is) to guarantee you find them even if there are spelling mistakes in the sheet.\n`;
    basePrompt += `CRITICAL DOUBLE BOOKING RULE: If SEARCH finds a booking on the SAME DATE with a matching First Name, DO NOT use 'ADD'. Use 'UPDATE' to modify it, or inform them they are already booked.\n`;
    basePrompt += `CRITICAL CANCELLATION RULE: If a customer asks to cancel their booking, NEVER use 'REMOVE'. You MUST use 'SEARCH' to find their booking, and then use 'UPDATE' to append "(REQUEST CANCEL)" to their name.\n`;
    basePrompt += `--- DIVE BOOKINGS ('manage_sheet_booking') ---\n`;
    basePrompt += `Use 'ADD', 'UPDATE', 'REMOVE'. RULES: "[Name] [Product] [Deposit]". Products: TD, FD [License], [Product]C. Deposit: Paid=DPO, No=?. MULTIPLE GUESTS: MUST separate each guest with a semicolon (;). Add special requests at the end after a pipe (|).\n`;
    basePrompt += `Ex: "GuestName TD DPO; OtherName RESCC ? | specreq: none"\n`;
    basePrompt += `--- HOTEL ROOMS & DYNAMIC PRICING ('manage_hotel_booking') ---\n`;
    basePrompt += `We operate Sanctum Hotel Nusa Penida with 8 Deluxe Room Garden View units (King bed + daybed lounge sofa, accommodating 2-3 guests). Note: Dormitory rooms are currently INACTIVE / OFFLINE. Only the 8 Deluxe Garden View rooms are live.\n`;
    basePrompt += `DYNAMIC SEASONAL PRICING RULE: Room prices are dynamic and fluctuate based on season, holidays, and OTA demand in Cloudbeds PMS. There is NO static base rate! NEVER quote an assumed price without running 'manage_hotel_booking' with action='CHECK_CAPACITY'. Always run CHECK_CAPACITY to fetch live seasonal rates.\n`;
    basePrompt += `ONLINE DEPOSIT MANDATE: Customer room bookings on WhatsApp/IG can ONLY be finalized after online deposit payment is confirmed. Pass deposit_paid=true when executing action='ADD'.\n`;
    basePrompt += `MANUAL & DIRECT SALES: Selena can quote direct rates from Supabase rules or apply custom rates agreed by staff (pass 'custom_rate' in manage_hotel_booking).\n`;
    basePrompt += `Always tag/mention Ketut as ${KETUT_TELEGRAM_HANDLE} on hotel inquiries, bookings, or cancellations.\n\n`;


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
// 4. API LOGIC (QWEN, DEEPSEEK, GEMINI)
// ==========================================
async function handleBookingNotification(args, senderId) {
    const now = new Date();
    const baliHour = (now.getUTCHours() + 8) % 24;

    console.log(`[Booking] Detected booking. Bali Hour: ${baliHour}`);

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
                await sleep(500);
            }
        }
    }
    console.log(`[Booking] Alert sent to Admins.`);
}

// NEW: QWEN API FUNCTION
async function callQwen(senderId, userMessage = null, extraContext = [], depth = 0, isEmail = false, platform = 'whatsapp') {
    if (depth > 5) {
        console.error(`[Recursion Limit] AI tool loop exceeded max depth for ${senderId}`);
        return "IGNORE";
    }

    let history = await getDeepSeekHistory(senderId);
    let latestUserMessage = "Please respond to the ongoing conversation or tool results.";

    if (userMessage) {
        latestUserMessage = userMessage;
    } else if (history.length > 0) {
        const lastMsg = history.pop();
        latestUserMessage = lastMsg.content;
    }

    let systemPrompt = await buildSystemPrompt(isEmail, platform);

    if (history.length > 0) {
        const historyText = history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n\n');
        systemPrompt += `\n[PAST CONVERSATION CONTEXT]\n${historyText}\n\n[END PAST CONTEXT]\n`;
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: latestUserMessage },
        ...extraContext
    ];

    const qwenTools = [
        { type: "function", function: { name: "record_booking", description: "Record booking. Status: '✅ FULLY CONFIRMED' or '❓ NOT CONFIRMED'", parameters: { type: "object", properties: { status: { type: "string" }, customer_name: { type: "string" }, dive_date: { type: "string" }, pax: { type: "integer" }, dive_type: { type: "string" }, special_requests: { type: "string" } }, required: ["status", "customer_name", "dive_date", "pax", "dive_type", "special_requests"] } } },
        { type: "function", function: { name: "manage_sheet_booking", description: "Manage live sheet schedule. Use SEARCH, ADD, UPDATE, REMOVE, or CHECK_CAPACITY.", parameters: { type: "object", properties: { action: { type: "string", description: "Must be 'ADD', 'UPDATE', 'REMOVE', 'SEARCH', or 'CHECK_CAPACITY'" }, target_date: { type: "string", description: "The date of the booking in YYYY-MM-DD format. Required for ADD, UPDATE, and CHECK_CAPACITY." }, new_text: { type: "string", description: "The formatted string to write into the cell. Required for ADD and UPDATE. Must follow SHEET BOOKING RULES formatting." }, old_date: { type: "string", description: "The old date of the booking in YYYY-MM-DD format. Required for UPDATE and REMOVE." }, old_text_match: { type: "string", description: "A substring of the old cell text to find and clear. Required for UPDATE and REMOVE (e.g. 'GuestName TD DPO')." }, search_query: { type: "string", description: "Customer name or string to search for across the sheet. Required for SEARCH." }, target_month: { type: "string", description: "The month and year to restrict the search to (e.g. 'September 2026'). Highly recommended for SEARCH to avoid large data returns." } }, required: ["action"] } } },
        { type: "function", function: { name: "search_sheet_booking", description: "Search the live Google Sheet schedule for a customer's booking. Use this if you only need to search the sheet without modifying it.", parameters: { type: "object", properties: { search_query: { type: "string" }, target_month: { type: "string", description: "The month and year to restrict the search to (e.g. 'September 2026')." } }, required: ["search_query"] } } },
        { type: "function", function: { name: "notify_admin", description: "Send a message directly to the human admin staff on Telegram. Use this if a customer asks for eLearning materials, certifications, or if a rule tells you to notify the admin group.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
        { type: "function", function: { name: "manage_hotel_booking", description: "Manage hotel rooms in Cloudbeds PMS & Google Sheet. Actions: 'CHECK_CAPACITY' (check room availability), 'ADD' (book room), 'REMOVE' or 'CANCEL' (cancel booking), 'SEARCH', 'UPDATE'. Only 8 Deluxe Garden View rooms are active (dorm inactive).", parameters: { type: "object", properties: { action: { type: "string", description: "Must be 'CHECK_CAPACITY', 'ADD', 'REMOVE', 'CANCEL', 'SEARCH', or 'UPDATE'" }, target_dates: { type: "array", items: { type: "string" }, description: "Array of stay dates in YYYY-MM-DD format (e.g. ['2026-11-10', '2026-11-11'])" }, startDate: { type: "string", description: "Check-in date (YYYY-MM-DD)" }, endDate: { type: "string", description: "Check-out date (YYYY-MM-DD)" }, guest_name: { type: "string", description: "Full guest name" }, guest_phone: { type: "string", description: "Guest phone number" }, guest_email: { type: "string", description: "Guest email address" }, rooms_count: { type: "integer", description: "Number of rooms (default 1)" }, pax: { type: "integer", description: "Number of guests" },
                custom_rate: { type: "string", description: "Optional manual / negotiated price for direct sale, e.g. 'IDR 600,000/night'" },
                deposit_paid: { type: "boolean", description: "REQUIRED for customer chats: Must be true indicating customer paid the online deposit. Strictly forbidden to execute ADD if false or unpaid." }, reservation_id: { type: "string", description: "Cloudbeds reservation ID for cancellation or lookup" }, old_guest_match: { type: "string", description: "Substring of guest name to cancel or update" }, search_query: { type: "string", description: "Guest name to search" } }, required: ["action"] } } },
        { type: "function", function: { name: "search_hotel_booking", description: "Search the live Hotel calendar for a customer's booking without modifying it.", parameters: { type: "object", properties: { search_query: { type: "string" }, target_month: { type: "string", description: "The month and year to restrict the search to (e.g. 'September 2026')." } }, required: ["search_query"] } } }
    ];

    let retries = 3;
    let response;

    while (retries > 0) {
        try {
            response = await axios.post(QWEN_API_URL, {
                model: QWEN_MODEL, messages: messages, tools: qwenTools, temperature: 0.7, max_tokens: isEmail ? 2500 : 1024
            }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${QWEN_API_KEY}` } });
            break;
        } catch (e) {
            console.error(`[Qwen API Error] Retries left: ${retries - 1}`, e.message);
            retries--;
            if (retries === 0) return null;
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    try {
        if (response.data.choices && response.data.choices.length > 0) {
            const message = response.data.choices[0].message;

            if (message.tool_calls && message.tool_calls.length > 0) {
                let newContext = [...extraContext, message];

                for (const toolCall of message.tool_calls) {
                    const funcName = toolCall.function.name;
                    let args = {};
                    try { args = JSON.parse(toolCall.function.arguments || '{}'); }
                    catch (e) { console.error(`[Qwen JSON Error] ${funcName}:`, e.message); }

                    let resultStr = "";

                    if (funcName === "record_booking") {
                        await handleBookingNotification(args, senderId);
                        resultStr = "Success";
                    } else if (funcName === "notify_admin") {
                        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                            const isHotel = args.message && /hotel|room|villa|stay|check-in|checkin|accommodation/i.test(args.message);
                            const tagLine = isHotel ? `🛎️ **Attention: ${KETUT_TELEGRAM_HANDLE}**\n` : "";
                            await sendTelegramAlert(`🚨 *ADMIN NOTIFICATION*\nFrom: ${senderId}\n${tagLine}\n${args.message}`);
                            resultStr = "Admin notified successfully.";
                        } else {
                            resultStr = "Admin chat not configured.";
                        }
                    } else if (funcName === "manage_sheet_booking" || funcName === "search_sheet_booking") {
                        if (process.env.GOOGLE_SHEET_API_URL) {
                            try {
                                const payload = funcName === "search_sheet_booking" ? { action: 'SEARCH', search_query: args.search_query, target_month: args.target_month } : args;
                                const sheetRes = await axios.post(process.env.GOOGLE_SHEET_API_URL, payload);
                                resultStr = sheetRes.data.status || "Completed";

                                if (funcName === "manage_sheet_booking" && args.action !== 'SEARCH' && !resultStr.includes('Skipped')) {
                                    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                                        await sendTelegramAlert(`📋 *SHEET UPDATE ALARM (QWEN)*\n\nAction: ${args.action}\nDate: ${args.target_date}\nText: ${args.new_text || 'N/A'}\n\nStatus: ${resultStr}`);
                                    }
                                }
                            } catch (e) { resultStr = e.message; }
                        } else { resultStr = "GOOGLE_SHEET_API_URL not set."; }
                    } else if (funcName === "manage_hotel_booking" || funcName === "search_hotel_booking") {
                        resultStr = await handleHotelBooking(args, funcName, "QWEN");
                    }

                    newContext.push({ role: "tool", tool_call_id: toolCall.id, content: resultStr });
                }

                return await callQwen(senderId, null, newContext, depth + 1, isEmail, platform);
            }

            if (message.content !== undefined && message.content !== null) {
                if (message.content.trim().length > 0) {
                    await appendHistory(senderId, "model", message.content);
                }
                return message.content;
            }
        }
    } catch (e) {
        console.error("[Qwen Processing Error]", e.message);
    }
    return null;
}

async function callDeepSeek(senderId, userMessage = null, extraContext = [], depth = 0, isEmail = false, platform = 'whatsapp') {
    if (depth > 10) {
        console.error(`[Recursion Limit] AI tool loop exceeded max depth for ${senderId}`);
        return "IGNORE";
    }

    let history = await getDeepSeekHistory(senderId);
    let latestUserMessage = "Please respond to the ongoing conversation or tool results.";

    if (userMessage) {
        latestUserMessage = userMessage;
    } else if (history.length > 0) {
        const lastMsg = history.pop();
        latestUserMessage = lastMsg.content;
    }

    let systemPrompt = await buildSystemPrompt(isEmail, platform);

    if (history.length > 0) {
        const historyText = history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n\n');
        systemPrompt += `\n[PAST CONVERSATION CONTEXT]\n${historyText}\n\n[END PAST CONTEXT]\n`;
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: latestUserMessage },
        ...extraContext
    ];

    const deepseekTools = [
        { type: "function", function: { name: "record_booking", description: "Record booking. Status: '✅ FULLY CONFIRMED' or '❓ NOT CONFIRMED'", parameters: { type: "object", properties: { status: { type: "string" }, customer_name: { type: "string" }, dive_date: { type: "string" }, pax: { type: "integer" }, dive_type: { type: "string" }, special_requests: { type: "string" } }, required: ["status", "customer_name", "dive_date", "pax", "dive_type", "special_requests"] } } },
        { type: "function", function: { name: "manage_sheet_booking", description: "Manage live sheet schedule. Use SEARCH, ADD, UPDATE, REMOVE, or CHECK_CAPACITY.", parameters: { type: "object", properties: { action: { type: "string", description: "Must be 'ADD', 'UPDATE', 'REMOVE', 'SEARCH', or 'CHECK_CAPACITY'" }, target_date: { type: "string", description: "The date of the booking in YYYY-MM-DD format. Required for ADD, UPDATE, and CHECK_CAPACITY." }, new_text: { type: "string", description: "The formatted string to write into the cell. Required for ADD and UPDATE. Must follow SHEET BOOKING RULES formatting." }, old_date: { type: "string", description: "The old date of the booking in YYYY-MM-DD format. Required for UPDATE and REMOVE." }, old_text_match: { type: "string", description: "A substring of the old cell text to find and clear. Required for UPDATE and REMOVE (e.g. 'GuestName TD DPO')." }, search_query: { type: "string", description: "Customer name or string to search for across the sheet. Required for SEARCH." }, target_month: { type: "string", description: "The month and year to restrict the search to (e.g. 'September 2026'). Highly recommended for SEARCH to avoid large data returns." } }, required: ["action"] } } },
        { type: "function", function: { name: "search_sheet_booking", description: "Search the live Google Sheet schedule for a customer's booking. Use this if you only need to search the sheet without modifying it.", parameters: { type: "object", properties: { search_query: { type: "string" }, target_month: { type: "string", description: "The month and year to restrict the search to (e.g. 'September 2026')." } }, required: ["search_query"] } } },
        { type: "function", function: { name: "notify_admin", description: "Send a message directly to the human admin staff on Telegram. Use this if a customer asks for eLearning materials, certifications, or if a rule tells you to notify the admin group.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
        { type: "function", function: { name: "manage_hotel_booking", description: "Manage hotel rooms in Cloudbeds PMS & Google Sheet. Actions: 'CHECK_CAPACITY' (check room availability), 'ADD' (book room), 'REMOVE' or 'CANCEL' (cancel booking), 'SEARCH', 'UPDATE'. Only 8 Deluxe Garden View rooms are active (dorm inactive).", parameters: { type: "object", properties: { action: { type: "string", description: "Must be 'CHECK_CAPACITY', 'ADD', 'REMOVE', 'CANCEL', 'SEARCH', or 'UPDATE'" }, target_dates: { type: "array", items: { type: "string" }, description: "Array of stay dates in YYYY-MM-DD format (e.g. ['2026-11-10', '2026-11-11'])" }, startDate: { type: "string", description: "Check-in date (YYYY-MM-DD)" }, endDate: { type: "string", description: "Check-out date (YYYY-MM-DD)" }, guest_name: { type: "string", description: "Full guest name" }, guest_phone: { type: "string", description: "Guest phone number" }, guest_email: { type: "string", description: "Guest email address" }, rooms_count: { type: "integer", description: "Number of rooms (default 1)" }, pax: { type: "integer", description: "Number of guests" },
                custom_rate: { type: "string", description: "Optional manual / negotiated price for direct sale, e.g. 'IDR 600,000/night'" },
                deposit_paid: { type: "boolean", description: "REQUIRED for customer chats: Must be true indicating customer paid the online deposit. Strictly forbidden to execute ADD if false or unpaid." }, reservation_id: { type: "string", description: "Cloudbeds reservation ID for cancellation or lookup" }, old_guest_match: { type: "string", description: "Substring of guest name to cancel or update" }, search_query: { type: "string", description: "Guest name to search" } }, required: ["action"] } } },
        { type: "function", function: { name: "search_hotel_booking", description: "Search the live Hotel calendar for a customer's booking without modifying it.", parameters: { type: "object", properties: { search_query: { type: "string" }, target_month: { type: "string", description: "The month and year to restrict the search to (e.g. 'September 2026')." } }, required: ["search_query"] } } }
    ];

    let retries = 3;
    let response;

    while (retries > 0) {
        try {
            response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-flash', messages: messages, tools: deepseekTools, temperature: 0.7, max_tokens: isEmail ? 2500 : 1024
            }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });
            break;
        } catch (e) {
            console.error(`[DeepSeek API Error] Retries left: ${retries - 1}`, e.message);
            retries--;
            if (retries === 0) return null;
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    try {
        if (response.data.choices && response.data.choices.length > 0) {
            const message = response.data.choices[0].message;

            if (message.tool_calls && message.tool_calls.length > 0) {
                let newContext = [...extraContext, message];

                for (const toolCall of message.tool_calls) {
                    const funcName = toolCall.function.name;
                    let args = {};
                    try { args = JSON.parse(toolCall.function.arguments || '{}'); }
                    catch (e) { console.error(`[DeepSeek JSON Error] ${funcName}:`, e.message); }
                    let resultStr = "";

                    if (funcName === "record_booking") {
                        await handleBookingNotification(args, senderId);
                        resultStr = "Success";
                    } else if (funcName === "notify_admin") {
                        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                            const isHotel = args.message && /hotel|room|villa|stay|check-in|checkin|accommodation/i.test(args.message);
                            const tagLine = isHotel ? `🛎️ **Attention: ${KETUT_TELEGRAM_HANDLE}**\n` : "";
                            await sendTelegramAlert(`🚨 *ADMIN NOTIFICATION*\nFrom: ${senderId}\n${tagLine}\n${args.message}`);
                            resultStr = "Admin notified successfully.";
                        } else {
                            resultStr = "Admin chat not configured.";
                        }
                    } else if (funcName === "manage_sheet_booking" || funcName === "search_sheet_booking") {
                        if (process.env.GOOGLE_SHEET_API_URL) {
                            try {
                                const payload = funcName === "search_sheet_booking" ? { action: 'SEARCH', search_query: args.search_query, target_month: args.target_month } : args;
                                const sheetRes = await axios.post(process.env.GOOGLE_SHEET_API_URL, payload);
                                resultStr = sheetRes.data.status || "Completed";

                                if (funcName === "manage_sheet_booking" && args.action !== 'SEARCH' && !resultStr.includes('Skipped')) {
                                    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                                        await sendTelegramAlert(`📋 *SHEET UPDATE ALARM (DS)*\n\nAction: ${args.action}\nDate: ${args.target_date}\nText: ${args.new_text || 'N/A'}\n\nStatus: ${resultStr}`);
                                    }
                                }
                            } catch (e) { resultStr = e.message; }
                        } else { resultStr = "GOOGLE_SHEET_API_URL not set."; }
                    } else if (funcName === "manage_hotel_booking" || funcName === "search_hotel_booking") {
                        resultStr = await handleHotelBooking(args, funcName, "DEEPSEEK");
                    }

                    newContext.push({ role: "tool", tool_call_id: toolCall.id, content: resultStr });
                }

                return await callDeepSeek(senderId, null, newContext, depth + 1, isEmail, platform);
            }

            if (message.content !== undefined && message.content !== null) {
                if (message.content.trim().length > 0) {
                    await appendHistory(senderId, "model", message.content);
                }
                return message.content;
            }
        }
    } catch (e) {
        console.error("[DeepSeek Processing Error]", e.message);
    }
    return null;
}


async function callGemini(senderId, extraContext = [], model = "gemini-3.8-flash", isEmail = false, depth = 0, platform = 'whatsapp') {
    if (depth > 3) {
        console.error(`[Recursion Limit] AI tool loop exceeded max depth for ${senderId}`);
        return "IGNORE";
    }
    let history = await getHistory(senderId);
    if (extraContext.length > 0) {
        history = history.concat(extraContext);
    }

    // Prevent Gemini crash if concurrent webhooks messed up the order
    if (history.length > 0 && history[history.length - 1].role === 'model') {
        history.push({ role: "user", parts: [{ text: "..." }] });
    }
    const systemPrompt = await buildSystemPrompt(isEmail, platform);

    let funcDecls = [{
        name: "record_booking",
        description: "Record booking. Status: '✅ FULLY CONFIRMED' or '❓ NOT CONFIRMED'",
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
        description: "Manage live sheet schedule. Use SEARCH, ADD, UPDATE, or REMOVE per lifecycle rules.",
        parameters: {
            type: "OBJECT",
            properties: {
                action: { type: "STRING", description: "Must be 'ADD', 'UPDATE', 'REMOVE', or 'SEARCH'" },
                target_date: { type: "STRING", description: "The date of the booking in YYYY-MM-DD format (e.g. 2026-07-02). Required for ADD and UPDATE." },
                new_text: { type: "STRING", description: "The formatted string to write into the cell. Required for ADD and UPDATE. Must follow SHEET BOOKING RULES formatting." },
                old_date: { type: "STRING", description: "The old date of the booking in YYYY-MM-DD format. Required for UPDATE and REMOVE." },
                old_text_match: { type: "STRING", description: "A substring of the old cell text to find and clear. Required for UPDATE and REMOVE (e.g. 'GuestName TD DPO')." },
                search_query: { type: "STRING", description: "Customer name or string to search for across the sheet. Required for SEARCH." },
                target_month: { type: "STRING", description: "The month and year to restrict the search to (e.g. 'September 2026'). Highly recommended for SEARCH to avoid large data returns." }
            },
            required: ["action"]
        }
    }, {
        name: "notify_admin",
        description: "Send a message directly to the human admin staff on Telegram. Use this if a customer asks for eLearning materials, certifications, or if a rule tells you to notify the admin group.",
        parameters: {
            type: "OBJECT",
            properties: {
                message: { type: "STRING", description: "The message to send to the admins." }
            },
            required: ["message"]
        }
    }, {
        name: "search_sheet_booking",
        description: "Search the live Google Sheet schedule for a customer's booking. Use this if you only need to search the sheet without modifying it.",
        parameters: {
            type: "OBJECT",
            properties: {
                search_query: { type: "STRING", description: "Customer name or string to search for across the sheet." },
                target_month: { type: "STRING", description: "The month and year to restrict the search to (e.g. 'September 2026')." }
            },
            required: ["search_query"]
        }
    }, {
        name: "manage_hotel_booking",
        description: "Manage hotel rooms in Cloudbeds PMS & Google Sheet. Actions: 'CHECK_CAPACITY' (check room availability), 'ADD' (book room), 'REMOVE' or 'CANCEL' (cancel booking), 'SEARCH', 'UPDATE'. Only 8 Deluxe Garden View rooms are active (dorm inactive).",
        parameters: {
            type: "OBJECT",
            properties: {
                action: { type: "STRING", description: "Must be 'CHECK_CAPACITY', 'ADD', 'REMOVE', 'CANCEL', 'SEARCH', or 'UPDATE'" },
                target_dates: { type: "ARRAY", items: { type: "STRING" }, description: "Array of stay dates in YYYY-MM-DD format (e.g. ['2026-11-10', '2026-11-11'])" },
                startDate: { type: "STRING", description: "Check-in date (YYYY-MM-DD)" },
                endDate: { type: "STRING", description: "Check-out date (YYYY-MM-DD)" },
                guest_name: { type: "STRING", description: "Full guest name" },
                guest_phone: { type: "STRING", description: "Guest phone number" },
                guest_email: { type: "STRING", description: "Guest email address" },
                rooms_count: { type: "INTEGER", description: "Number of rooms (default 1)" },
                pax: { type: "INTEGER", description: "Number of guests" },
                custom_rate: { type: "STRING", description: "Optional manual / negotiated price for direct sale, e.g. 'IDR 600,000/night'" },
                deposit_paid: { type: "BOOLEAN", description: "REQUIRED for customer chats: Must be true indicating customer paid the online deposit. Strictly forbidden to execute ADD if false or unpaid." },
                reservation_id: { type: "STRING", description: "Cloudbeds reservation ID for cancellation or lookup" },
                old_guest_match: { type: "STRING", description: "Substring of guest name to cancel or update" },
                search_query: { type: "STRING", description: "Guest name to search" }
            },
            required: ["action"]
        }
    }, {
        name: "search_hotel_booking",
        description: "Search the live Hotel calendar for a customer's booking without modifying it.",
        parameters: {
            type: "OBJECT",
            properties: {
                search_query: { type: "STRING", description: "Guest name or string to search for across the hotel sheet." },
                target_month: { type: "STRING", description: "The month and year to restrict the search to (e.g. 'September 2026')." }
            },
            required: ["search_query"]
        }
    }];

    if (senderId === 'KIOSK_DESK_1') {
        funcDecls = funcDecls.filter(t => t.name !== 'manage_sheet_booking' && t.name !== 'manage_hotel_booking');
    }

    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history,
        tools: [{
            function_declarations: funcDecls
        }]
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );

        if (response.data.candidates && response.data.candidates.length > 0) {
            const content = response.data.candidates[0].content;
            if (!content || !content.parts) {
                console.error("[Gemini] API returned empty content (Safety Filter). Ignoring.");
                console.log(`[Gemini AI Debug] Raw response:`, JSON.stringify(response.data));
                return null;
            }
            const parts = content.parts;
            const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
            const textPart = parts.find(p => p.text);
            let firstTurnText = textPart ? textPart.text : null;

            if (functionCalls.length > 0) {
                const funcResParts = [];

                for (const call of functionCalls) {
                    if (call.name === 'record_booking') {
                        await handleBookingNotification(call.args, senderId);
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: "success" } } });
                    } else if (call.name === 'manage_sheet_booking') {
                        console.log(`[Google Sheets] Executing manage_sheet_booking: ${call.args.action} | Args: ${JSON.stringify(call.args)}`);
                        let sheetStatus = "error";
                        let sheetMessage = "GOOGLE_SHEET_API_URL not configured in backend.";

                        if (process.env.GOOGLE_SHEET_API_URL) {
                            try {
                                const sheetRes = await axios.post(process.env.GOOGLE_SHEET_API_URL, call.args);
                                sheetStatus = "success";
                                if (typeof sheetRes.data === 'string' && sheetRes.data.includes('<html')) {
                                    sheetMessage = "Google Apps Script crashed or returned an HTML error page. The search failed. Tell the user there was a technical error accessing the sheet.";
                                } else {
                                    sheetMessage = sheetRes.data.status || "Completed";
                                }
                                console.log(`[Google Sheets] Response: ${sheetMessage}`);

                                // Send Telegram Alert
                                if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && call.args.action !== 'SEARCH' && !sheetMessage.includes('Skipped')) {
                                    const alertMsg = `📋 *SHEET UPDATE ALARM*\n\nAction: ${call.args.action}\nDate: ${call.args.target_date}\nText: ${call.args.new_text || 'N/A'}\n\nStatus: ${sheetMessage}`;
                                    await sendTelegramAlert(alertMsg);
                                }
                            } catch (err) {
                                console.error("[Google Sheets API Error]", err.message);
                                sheetMessage = err.message;
                            }
                        }
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: sheetStatus, message: sheetMessage } } });
                    } else if (call.name === 'manage_hotel_booking' || call.name === 'search_hotel_booking') {
                        console.log(`[Gemini Tool] Executing ${call.name}: ${call.args?.action || 'SEARCH'} | Args: ${JSON.stringify(call.args)}`);
                        const hotelResult = await handleHotelBooking(call.args, call.name, "GEMINI");
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: "success", message: hotelResult } } });
                    } else if (call.name === 'search_sheet_booking') {
                        console.log(`[Gemini Tool] AI is running ${call.name}`);
                        let sheetStatus = "error";
                        let sheetMessage = "GOOGLE_SHEET_API_URL not configured.";

                        if (process.env.GOOGLE_SHEET_API_URL) {
                            try {
                                const sheetPayload = { action: 'SEARCH', search_query: call.args.search_query, target_month: call.args.target_month };
                                const sheetRes = await axios.post(process.env.GOOGLE_SHEET_API_URL, sheetPayload);
                                sheetStatus = "success";
                                sheetMessage = (typeof sheetRes.data === 'string' && sheetRes.data.includes('<html')) ? "Google Apps Script error." : (sheetRes.data.status || "Completed");
                            } catch (err) {
                                sheetMessage = err.message;
                            }
                        }
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: sheetStatus, message: sheetMessage } } });
                    } else if (call.name === 'notify_admin') {
                        console.log(`[Telegram Tool] AI is running notify_admin: ${call.args.message}`);
                        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
                            const isHotel = call.args.message && /hotel|room|villa|stay|check-in|checkin|accommodation/i.test(call.args.message);
                            const tagLine = isHotel ? `🛎️ **Attention: ${KETUT_TELEGRAM_HANDLE}**\n` : "";
                            await sendTelegramAlert(`🚨 *SELENA ALERT*\n${tagLine}\n${call.args.message}`);
                        }
                        funcResParts.push({ functionResponse: { name: call.name, response: { status: "success" } } });
                    }
                }
                const funcCallContent = response.data.candidates[0].content;
                const funcCallCtx = { role: "model", parts: funcCallContent.parts };
                const funcResCtx = { role: "user", parts: funcResParts };
                const recursiveReply = await callGemini(senderId, [...extraContext, funcCallCtx, funcResCtx], model, isEmail, depth + 1, platform);

                if (firstTurnText && !recursiveReply) {
                    await appendHistory(senderId, "model", firstTurnText);
                    return firstTurnText;
                } else if (firstTurnText && recursiveReply) {
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
        console.error("Gemini Processing Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
    return null;
}

// ==========================================
// 5. META WHATSAPP & INSTAGRAM API & MEDIA
// ==========================================
async function downloadMedia(mediaId, mimeType, senderId) {
    try {
        const baseUrl = process.env.DUALHOOK_API_KEY ? 'https://api.dualhook.com' : 'https://graph.facebook.com';
        const bearerToken = process.env.DUALHOOK_API_KEY || META_ACCESS_TOKEN;

        const metaRes = await axios.get(`${baseUrl}/v25.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${bearerToken}` }
        });
        const mediaUrl = metaRes.data.url;
        const actualMimeType = metaRes.data.mime_type || mimeType || "application/octet-stream";

        const downloadToken = mediaUrl.includes('dualhook.com') ? bearerToken : META_ACCESS_TOKEN;

        const downloadRes = await axios.get(mediaUrl, {
            headers: { 'Authorization': `Bearer ${downloadToken}` },
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(downloadRes.data, 'binary');
        const base64Data = buffer.toString('base64');
        return { buffer, base64Data, mimeType: actualMimeType };
    } catch (error) {
        console.error("Meta Media Download Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

async function downloadIGMedia(mediaUrl) {
    try {
        const downloadRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer'
        });
        const buffer = Buffer.from(downloadRes.data, 'binary');
        const base64Data = buffer.toString('base64');
        const mimeType = downloadRes.headers['content-type'] || "image/jpeg";
        return { buffer, base64Data, mimeType };
    } catch (error) {
        console.error("IG Media Download Error:", error.response ? error.response.data : error.message);
        return null;
    }
}

async function analyzeMedia(buffer, mimeType, caption, mediaType) {
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

    if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') {
        try {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return `Parsed Word Document:\n${result.value.substring(0, 3000)}`;
        } catch (e) {
            return `Failed to parse Word Document (Note: old .doc formats may not be supported. Ask for PDF): ${e.message}`;
        }
    }

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
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
    if (!recipientPhone) {
        console.error("[sendWhatsAppMessage] No recipientPhone provided.");
        return;
    }

    const recipientStr = recipientPhone.toString().trim();
    // BSUID handles (e.g. MY.1766392011328199) contain a period or letters.
    // Dualhook & Meta specification: For BSUID, put complete ID in "recipient" and leave out "to" entirely.
    // For traditional phone numbers, put in "to" and leave out "recipient".
    const isBSUID = recipientStr.includes('.') || /[a-zA-Z]/.test(recipientStr);

    const baseUrl = process.env.DUALHOOK_API_KEY ? 'https://api.dualhook.com' : 'https://graph.facebook.com';
    const bearerToken = process.env.DUALHOOK_API_KEY || META_ACCESS_TOKEN;
    const url = `${baseUrl}/v25.0/${META_PHONE_NUMBER_ID}/messages`;

    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        type: "text",
        text: { preview_url: false, body: textMessage }
    };

    if (isBSUID) {
        payload.recipient = recipientStr;
    } else {
        payload.to = recipientStr;
    }

    const cleanTo = recipientStr.replace(/\D/g, '');

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (cleanTo) cacheSet(`ai_sent_${cleanTo}`, "true", 60);
            cacheSet(`ai_sent_${recipientStr}`, "true", 60);

            const response = await axios.post(url, payload, {
                headers: { Authorization: `Bearer ${bearerToken}` }
            });

            if (response.data && response.data.messages && response.data.messages.length > 0) {
                response.data.messages.forEach(m => {
                    if (m.id) cacheSet(m.id, "true", 600);
                });
            }

            console.log(`[Sent] Message to ${recipientStr} (${isBSUID ? 'BSUID via recipient' : 'Phone via to'}): ${JSON.stringify(response.data)}`);
            return;
        } catch (error) {
            console.error(`WhatsApp Send Error (Attempt ${attempt}/3) to ${recipientStr}:`, error.response ? JSON.stringify(error.response.data) : error.message);
            if (attempt === 3) return;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function sendInstagramDM(recipientId, textMessage) {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${META_IG_ACCESS_TOKEN}`;
    const payload = {
        recipient: { id: recipientId },
        message: { text: textMessage }
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            cacheSet(`ai_sent_${recipientId}`, "true", 5);
            await axios.post(url, payload);
            console.log(`[Sent] Instagram DM to ${recipientId}`);
            return;
        } catch (error) {
            console.error(`Instagram Send Error (Attempt ${attempt}/3):`, error.response ? JSON.stringify(error.response.data) : error.message);
            if (attempt === 3) return;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function replyToInstagramComment(commentId, textMessage) {
    const url = `https://graph.facebook.com/v21.0/${commentId}/replies?access_token=${META_IG_ACCESS_TOKEN}`;
    const payload = { message: textMessage };
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await axios.post(url, payload);
            console.log(`[Sent] Reply to Comment ${commentId}`);
            return;
        } catch (error) {
            console.error(`Instagram Comment Reply Error (Attempt ${attempt}/3):`, error.response ? JSON.stringify(error.response.data) : error.message);
            if (attempt === 3) return;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function sendWhatsAppTemplate(recipientPhone, templateName, languageCode = "en") {
    if (!recipientPhone) return;
    const recipientStr = recipientPhone.toString().trim();
    const isBSUID = recipientStr.includes('.') || /[a-zA-Z]/.test(recipientStr);

    const baseUrl = process.env.DUALHOOK_API_KEY ? 'https://api.dualhook.com' : 'https://graph.facebook.com';
    const bearerToken = process.env.DUALHOOK_API_KEY || META_ACCESS_TOKEN;
    const url = `${baseUrl}/v25.0/${META_PHONE_NUMBER_ID}/messages`;

    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        type: "template",
        template: {
            name: templateName,
            language: { code: languageCode }
        }
    };

    if (isBSUID) {
        payload.recipient = recipientStr;
    } else {
        payload.to = recipientStr;
    }

    const cleanTo = recipientStr.replace(/\D/g, '');

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (cleanTo) cacheSet(`ai_sent_${cleanTo}`, "true", 60);
            cacheSet(`ai_sent_${recipientStr}`, "true", 60);

            const response = await axios.post(url, payload, {
                headers: { Authorization: `Bearer ${bearerToken}` }
            });

            if (response.data && response.data.messages && response.data.messages.length > 0) {
                response.data.messages.forEach(m => {
                    if (m.id) cacheSet(m.id, "true", 600);
                });
            }

            console.log(`[Sent] Template ${templateName} to ${recipientStr} (${isBSUID ? 'BSUID via recipient' : 'Phone via to'}): ${JSON.stringify(response.data)}`);
            return;
        } catch (error) {
            console.error(`WhatsApp Template Send Error (Attempt ${attempt}/3) to ${recipientStr}:`, error.response ? JSON.stringify(error.response.data) : error.message);
            if (attempt === 3) return;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ==========================================
// 6. AUTOMATIC FOLLOW-UPS (Cron Job)
// ==========================================
async function evaluateFollowup(history, followUpType) {
    const systemInstruction = `CRITICAL TASK: You are a strict auditor reviewing a WhatsApp conversation that has been silent for ${followUpType} days. Your ONLY job is to prevent spamming customers who have already booked or finished talking to us.

Analyze the history and answer ONE question: Should we send a sales follow-up to try and close a booking?

RULES:
1. If the customer ALREADY BOOKED, ALREADY PAID, or ALREADY AGREED to a date: Output exactly the word "NO"
2. If the customer already said NO, cancelled, or rejected: Output exactly the word "NO"
3. If the conversation naturally concluded, or they asked a random question and got their answer: Output exactly the word "NO"
4. ONLY if they were actively inquiring about prices/dates, showed high interest in booking, but then ghosted before confirming: Output exactly the word "YES"

Output NOTHING ELSE except "YES" or "NO". Default to "NO" if you are unsure.`;

    const payload = {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: history
    };

    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            payload
        );
        if (response.data.candidates && response.data.candidates.length > 0) {
            const answer = response.data.candidates[0].content.parts[0].text.trim().toUpperCase();
            return answer === 'YES';
        }
    } catch (error) {
        console.error("Gemini Followup Eval Error:", error.message);
    }
    return false;
}

async function runDailyFollowUps() {
    console.log("[Cron] Running daily follow-up checks...");

    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

    const { data: convos, error } = await supabase
        .from('conversations')
        .select('phone_number, message_text, created_at')
        .gte('created_at', tenDaysAgo.toISOString())
        .order('created_at', { ascending: false });

    if (error || !convos) return;

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

        if (hoursSilent >= 48 && hoursSilent < 72) {
            if (lastMsg.message_text.includes("reconfirm your dive plan") || lastMsg.message_text.includes("[Sent 2-Day Follow-Up Template]")) continue;

            const history = await getHistory(phone);
            const shouldFollowUp = await evaluateFollowup(history, 2);

            if (shouldFollowUp) {
                await sendWhatsAppTemplate(phone, "sales_followup", "en");
                await appendHistory(phone, "model", "[Sent 2-Day Follow-Up Template]");
                console.log(`[Follow-up] Sent 2-day follow up to ${phone}`);
                await sleep(5000);
            }
        }

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

        const senderEmailLower = (senderEmail || "").toLowerCase();
        const subjectLower = (subject || "").toLowerCase();

        if ((senderEmailLower.includes('no-reply') || senderEmailLower.includes('noreply')) &&
            !senderEmailLower.includes('viator') &&
            !senderEmailLower.includes('bokun') &&
            !senderEmailLower.includes('trip') &&
            !senderEmailLower.includes('getyourguide') &&
            !senderEmailLower.includes('tab')
        ) {
            console.log(`[Gmail] HARD BLOCKED automated/vendor email: ${senderEmail}`);
            return res.json({ action: "IGNORED" });
        }

        let contextToSave = `[Customer Email Subject: ${subject}]\n\n${body}`;

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

        const isPaused = await checkIsPaused(senderEmail);

        if (isPaused) {
            await appendHistory(senderEmail, "user", contextToSave);
            return res.json({ action: "PAUSED" });
        }

        await appendHistory(senderEmail, "user", contextToSave);

        // GMAIL AI BRAIN: DeepSeek Flash is primary, Qwen is fallback, Gemini as safety net
        let aiReply = await callDeepSeek(senderEmail, null, [], 0, true, 'gmail');
        if (!aiReply) {
            console.log(`[Gmail Fallback] DeepSeek failed for ${senderEmail}. Falling back to Qwen...`);
            aiReply = await callQwen(senderEmail, null, [], 0, true, 'gmail');
        }
        if (!aiReply) {
            console.log(`[Gmail Fallback] Qwen failed for ${senderEmail}. Falling back to Gemini...`);
            aiReply = await callGemini(senderEmail, [], "gemini-3.8-flash", true, 0, 'gmail');
        }

        if (aiReply) {
            if (/^IGNORE[\s.!\n]*$/i.test(aiReply.trim())) {
                console.log(`[Gmail] Ignored spam/promo from ${senderEmail}`);
                return res.json({ action: "IGNORED" });
            }

            console.log(`[Gmail] Creating draft for ${senderEmail}`);
            return res.json({ action: "DRAFT_CREATED", replyText: aiReply });
        }

        res.json({ action: "ERROR" });
    } catch (error) {
        console.error("Gmail Webhook Error:", error);
        res.json({ action: "ERROR" });
    }
});


// ==========================================
// 7.1 GMAIL SPAM EVALUATION & RESCUE API
// ==========================================
async function evaluateSpamEmail(senderEmail, subject, body) {
    const prompt = `You are Selena's spam evaluator for Sanctum Dive Resort, a scuba diving resort and dive center in Nusa Penida, Bali, Indonesia.

An incoming email was placed into Gmail's Spam folder.
Your job is to strictly classify whether this email is a REAL CUSTOMER / BUSINESS INQUIRY or TRUE SPAM.

LEGITIMATE EMAILS (isLegit: true) INCLUDE:
- Anyone asking about scuba diving (Discover Scuba / Try Dive, Fun Dives, PADI Open Water, Advanced, Rescue, Divemaster, etc.).
- Inquiries about snorkeling trips or manta ray diving in Nusa Penida / Bali.
- Room / hotel reservations at Sanctum Dive Resort.
- Questions about pricing, schedules, gear rental, equipment, medical requirements, or ferry transfers.
- Payment confirmation receipts from payment gateways (Tab Travel, Tab Payments, Wise, Stripe, bank transfers, etc.).
- Booking confirmations / receipts from booking platforms (Viator, Bokun, Trip.com, GetYourGuide, Airbnb, Booking.com, etc.).
- Genuine human travelers or past/future guests asking questions.

TRUE SPAM (isLegit: false) INCLUDES:
- Unsolicited B2B sales pitches (SEO, backlink outreach, website design/development agencies, software pitches).
- Crypto, investments, loans, financial schemes, inheritance scams, phishing.
- Mass marketing newsletters, cold recruitment/staffing sales.
- Adult/dating/pharma spam.

EMAIL DETAILS:
From: ${senderEmail}
Subject: ${subject || "(No Subject)"}
Body Snippet:
${(body || "").substring(0, 1500)}

Respond with ONLY a JSON object:
{
  "isLegit": true or false,
  "reason": "Brief 1-sentence reason"
}`;

    // 1. Try DeepSeek Flash
    try {
        if (DEEPSEEK_API_KEY) {
            const dsRes = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-flash',
                messages: [
                    { role: 'system', content: 'You are an email classification assistant. Respond ONLY in valid JSON format.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 150,
                response_format: { type: 'json_object' }
            }, {
                headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
                timeout: 15000
            });

            if (dsRes.data.choices && dsRes.data.choices.length > 0) {
                const text = dsRes.data.choices[0].message.content.trim();
                const parsed = JSON.parse(text);
                return { isLegit: Boolean(parsed.isLegit), reason: parsed.reason || "Evaluated by DeepSeek" };
            }
        }
    } catch (err) {
        console.error("[Spam Eval DeepSeek Error]", err.message);
    }

    // 2. Fallback to Gemini Flash
    try {
        if (process.env.GEMINI_API_KEY) {
            const geminiRes = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                {
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 150
                    }
                },
                { timeout: 15000 }
            );

            if (geminiRes.data.candidates && geminiRes.data.candidates.length > 0) {
                const text = geminiRes.data.candidates[0].content.parts[0].text;
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return { isLegit: Boolean(parsed.isLegit), reason: parsed.reason || "Evaluated by Gemini" };
                }
            }
        }
    } catch (err) {
        console.error("[Spam Eval Gemini Error]", err.message);
    }

    return { isLegit: false, reason: "Evaluation failed or uncertain" };
}

app.post('/evaluate-spam', async (req, res) => {
    try {
        const { threadId, messageId, senderEmail, subject, body, attachments } = req.body;

        console.log(`[Spam Inspector] Inspecting email from ${senderEmail}: ${subject}`);

        const senderEmailLower = (senderEmail || "").toLowerCase();

        // 1. Instant block for obvious automated bots/vendors (unless booking platform)
        if ((senderEmailLower.includes('no-reply') || senderEmailLower.includes('noreply') || senderEmailLower.includes('mailer-daemon')) &&
            !senderEmailLower.includes('viator') &&
            !senderEmailLower.includes('bokun') &&
            !senderEmailLower.includes('trip') &&
            !senderEmailLower.includes('getyourguide') &&
            !senderEmailLower.includes('booking.com') &&
            !senderEmailLower.includes('airbnb')
        ) {
            console.log(`[Spam Inspector] HARD BLOCKED automated spam: ${senderEmail}`);
            return res.json({ isLegit: false, action: "IGNORED", reason: "Automated/no-reply sender" });
        }

        // 2. AI Spam Evaluation
        const evalResult = await evaluateSpamEmail(senderEmail, subject, body);

        if (!evalResult.isLegit) {
            console.log(`[Spam Inspector] AI classified as SPAM: ${senderEmail} - ${subject} (${evalResult.reason})`);
            return res.json({ isLegit: false, action: "IGNORED", reason: evalResult.reason });
        }

        // 3. Legit email rescued!
        console.log(`[Spam Inspector] 🎉 RESCUING legitimate client inquiry from ${senderEmail}: ${subject} (${evalResult.reason})`);

        // Send Telegram alert to admin immediately
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            const alertText = `🚨 SPAM RESCUE ALERT!\n\n` +
                `Selena rescued a legitimate client inquiry from Gmail Spam!\n\n` +
                `👤 From: ${senderEmail}\n` +
                `📌 Subject: ${subject || "(No Subject)"}\n` +
                `💡 Reason: ${evalResult.reason}\n\n` +
                `✅ Action: Moved to Inbox & AI Draft created.`;
            await sendTelegramAlert(alertText);
        }

        // 4. Process Context & Attachments
        let contextToSave = `[Customer Email Subject: ${subject}]\n\n${body}`;
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

        const isPaused = await checkIsPaused(senderEmail);
        if (isPaused) {
            await appendHistory(senderEmail, "user", contextToSave);
            return res.json({ isLegit: true, action: "PAUSED", reason: evalResult.reason });
        }

        await appendHistory(senderEmail, "user", contextToSave);

        // 5. Generate AI reply draft (DeepSeek Flash primary, Qwen fallback, Gemini safety net)
        let aiReply = await callDeepSeek(senderEmail, null, [], 0, true, 'gmail');
        if (!aiReply) {
            console.log(`[Gmail Fallback] DeepSeek failed for ${senderEmail}. Falling back to Qwen...`);
            aiReply = await callQwen(senderEmail, null, [], 0, true, 'gmail');
        }
        if (!aiReply) {
            console.log(`[Gmail Fallback] Qwen failed for ${senderEmail}. Falling back to Gemini...`);
            aiReply = await callGemini(senderEmail, [], "gemini-3.8-flash", true, 0, 'gmail');
        }

        if (aiReply) {
            if (/^IGNORE[\s.!\n]*$/i.test(aiReply.trim())) {
                console.log(`[Spam Inspector] AI processed booking tool and replied IGNORE for ${senderEmail}`);
                return res.json({ isLegit: true, action: "IGNORED", reason: evalResult.reason });
            }

            console.log(`[Spam Inspector] Creating draft for rescued email: ${senderEmail}`);
            return res.json({ isLegit: true, action: "DRAFT_CREATED", replyText: aiReply, reason: evalResult.reason });
        }

        return res.json({ isLegit: true, action: "RESCUED_NO_DRAFT", reason: evalResult.reason });
    } catch (error) {
        console.error("Spam Evaluation Error:", error);
        res.json({ isLegit: false, action: "ERROR", reason: error.message });
    }
});

// cron.schedule('0 10 * * *', runDailyFollowUps); // DISABLED: Automatic follow-ups disabled

app.listen(PORT, () => {
    console.log(`Sanctum AI Server is running on port ${PORT}`);
});
