
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { googleManager } from './google_manager.js';
import { SHEET_SCHEMA, STATUS } from './schema.js';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// --- SINGLE INSTANCE LOCK SYSTEM ---
const LOCK_FILE = path.join(__dirname, 'bridge.lock');
async function acquireLock() {
    const MAX_RETRIES = 5;

    for (let i = 0; i < MAX_RETRIES; i++) {
        if (!fs.existsSync(LOCK_FILE)) break;

        try {
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
            if (!isNaN(pid)) {
                // Testing if process exists (throws if not)
                process.kill(pid, 0);

                // If we get here, process IS running
                console.log(`⏳ Verrou actif (PID ${pid}). Attente... (${i + 1}/${MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                // Invalid PID content
                throw new Error("Invalid PID");
            }
        } catch (e) {
            // Process dead (ESRCH) or file error -> Stale lock
            console.log("🔓 Verrou obsolète (Processus inactif). Suppression...");
            try { fs.unlinkSync(LOCK_FILE); } catch (err) { }
            break;
        }
    }

    // Force cleanup if still stuck
    if (fs.existsSync(LOCK_FILE)) {
        console.warn("⚠️ Verrou forcé après attente.");
        try { fs.unlinkSync(LOCK_FILE); } catch (e) { }
    }

    try {
        fs.writeFileSync(LOCK_FILE, process.pid.toString());
        console.log(`🔐 Verrou acquis par PID ${process.pid}`);
    } catch (e) {
        console.error("Lock error:", e);
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            // Only release if WE are the owner (PID match)
            // Although usually redundant on exit, safer if multiple processes mess around.
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
            if (pid === process.pid) {
                fs.unlinkSync(LOCK_FILE);
                console.log("🔐 Verrou libéré.");
            }
        }
    } catch (e) { }
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(); });
process.on('SIGTERM', () => { releaseLock(); process.exit(); });
process.on('uncaughtException', (err) => { console.error(err); releaseLock(); process.exit(1); });

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SPREADSHEET_ID) {
    console.error("âŒ ERREUR DE CONFIGURATION : Variables manquantes.");
    releaseLock();
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- LOGGING ---
function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    try {
        fs.appendFileSync(path.join(__dirname, 'bridge_debug.log'), logLine);
    } catch (e) {
        // ignore
    }
}

// Override console.log/error to write to file
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    logToFile(`INFO: ${msg}`);
    originalLog.apply(console, args);
};

console.error = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    logToFile(`ERROR: ${msg}`);
    originalError.apply(console, args);
};

// --- DATA CACHE ---
const TABS_CONFIG = ['fr metropole ', 'Guadeloupe', 'Martinique', 'Guyane', 'Reunion', 'Mayotte', 'Corse'];
let TABS = [];
const CHECK_INTERVAL_MS = 60000; // 1 Minute (Better responsiveness)

// --- STATE DIFFING CACHE ---
const stateCache = new Map(); // Store hashes of rows/stock to prevent busy loops
const notifiedEmptyTabs = new Set(); // Silence repeated "Empty Sheet" warnings
const realtimeDebounceTimeouts = new Map(); // Debounce realtime events by clientId

// --- MAPPINGS (ID -> NAME for Sheet readability) ---
const CAMION_NAMES = {
    'camion-1000': 'Nicolas',
    'camion-500': 'David',
    'camion-2000': 'Gros Camion',
    'TM 1': 'TM 1'
};

const NAME_TO_ID = {
    'Nicolas': 'camion-1000',
    'David': 'camion-500',
    'Gros Camion': 'camion-2000',
    'TM 1': 'TM 1'
};

// --- HELPER FUNCTIONS ---
function resolveTabName(sanitizedName) {
    // Standardize: fr_metropole -> fr metropole
    const baseName = sanitizedName.replace(/_/g, ' ').trim();

    if (!TABS || TABS.length === 0) {
        // Fallback to basic replacement if TABS not yet loaded
        return baseName;
    }

    // 1. Precise match (ignoring case/trim)
    const match = TABS.find(t => t.trim().toLowerCase() === baseName.toLowerCase());
    if (match) return match;

    // 2. Default to original sanitized
    return baseName;
}

function getZoneFromTab(tabName) {
    const lower = tabName.toLowerCase();
    if (lower.includes('fr') || lower.includes('metropole')) return 'FR';
    if (lower.includes('guadeloupe')) return 'GP';
    if (lower.includes('martinique')) return 'MQ';
    if (lower.includes('guyane')) return 'GF';
    if (lower.includes('reunion')) return 'RE';
    if (lower.includes('mayotte')) return 'YT';
    if (lower.includes('corse')) return 'CORSE';
    return 'UNKNOWN';
}

function formatDateValues(dateInput) {
    if (!dateInput) return { date: '', time: '' };
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return { date: '', time: '' };
    const date = d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
    const time = d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    return { date, time };
}

/**
 * Calcule la date de fin estimée en fonction du nombre de LEDs et des horaires de travail.
 * Performance : 60 LEDs / jour de 9h (9h - 18h). Exclut les samedis et dimanches.
 */
function calculateEstimatedEnd(startDate, nbLed, ledsPerDay = 60, startHour = 9, endHour = 18) {
    const workingHoursPerDay = endHour - startHour;
    const ledsPerHour = ledsPerDay / workingHoursPerDay;

    let currentDate = new Date(startDate);
    let remainingLed = parseFloat(nbLed) || 0;

    if (remainingLed <= 0) return currentDate;

    if (currentDate.getHours() < startHour) {
        currentDate.setHours(startHour, 0, 0, 0);
    } else if (currentDate.getHours() >= endHour) {
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(startHour, 0, 0, 0);
    }

    // Sauter les weekends (samedi=6, dimanche=0)
    while (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(startHour, 0, 0, 0);
    }

    while (remainingLed > 0.1) {
        // Sauter weekends (samedi=6, dimanche=0)
        if (currentDate.getDay() === 0 || currentDate.getDay() === 6) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        const currentHour = currentDate.getHours() + (currentDate.getMinutes() / 60);
        const hoursLeftToday = Math.max(0, endHour - currentHour);
        const ledsPossibleToday = hoursLeftToday * ledsPerHour;

        if (ledsPossibleToday >= remainingLed) {
            const hoursNeeded = remainingLed / ledsPerHour;
            const totalMinutesNeeded = hoursNeeded * 60;
            currentDate.setMinutes(currentDate.getMinutes() + totalMinutesNeeded);
            remainingLed = 0;
        } else {
            remainingLed -= ledsPossibleToday;
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
        }
    }

    return currentDate;
}

function parseId(compositeId) {
    const lastUnderscoreIndex = compositeId.lastIndexOf('_');
    if (lastUnderscoreIndex === -1) return null;
    let tabName = compositeId.substring(0, lastUnderscoreIndex);
    if (tabName.endsWith('_')) tabName = tabName.slice(0, -1);
    const rowIndex = parseInt(compositeId.substring(lastUnderscoreIndex + 1));
    return { tabName, rowIndex };
}

/**
 * Intelligent CSV Splitter
 * Handles quoted fields with commas correctly.
 */
function csvSplit(line) {
    if (!line || typeof line !== 'string') return [line];
    const result = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(cur.trim());
            cur = '';
        } else {
            cur += char;
        }
    }
    result.push(cur.trim());
    return result;
}

/**
 * Parses DD/MM/YYYY to YYYY-MM-DD
 */
function parseDateToISO(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.trim().split('/');
    if (parts.length === 3) {
        // DD/MM/YYYY -> YYYY-MM-DD
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    // Try standard parse
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
    }
    return dateStr; // Fallback to original if parse fails
}


/**
 * Generates a hash for state diffing
 */
function generateHash(data) {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('md5').update(s).digest('hex');
}


/**
 * Check if a row is a header row (should be skipped)
 */
function isHeaderRow(row) {
    if (!row || row.length === 0) return true;
    const first = (row[0] || '').toUpperCase();
    if (first.includes('NOM') && first.includes('PRENOM')) return true;
    if (first.includes('SIGNATURE') && (first.includes('DATE') || first.includes('LOGO'))) return true;
    return false;
}

// --- CALENDAR LOGIC (SECURE & ROBUST VIA MANAGER) ---
async function createCalendarEvent(calendarId, eventData, client) {
    try {
        // 1. Check existing ID
        if (client.calendar_event_id) {
            console.log(`↻ Updating Event (${client.calendar_event_id})...`);
            try {
                const response = await googleManager.calendarUpdate({
                    calendarId: calendarId,
                    eventId: client.calendar_event_id,
                    requestBody: eventData,
                });
                return response.data;
            } catch (updateErr) {
                if (updateErr.code === 404 || updateErr.code === 410) {
                    console.warn("âš ï¸ Event ID not found/deleted. Recreating...");
                } else {
                    throw updateErr;
                }
            }
        }

        // 2. Search fallback
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const listRes = await googleManager.calendarList({
            calendarId: calendarId,
            timeMin: now.toISOString(),
            q: client.id,
            singleEvents: true,
            maxResults: 1
        });

        const existingEvent = listRes.data.items && listRes.data.items.length > 0 ? listRes.data.items[0] : null;

        if (existingEvent) {
            console.log(`â†» Recovered Event (${existingEvent.id}). Updating DB...`);
            await supabase.from('clients').update({ calendar_event_id: existingEvent.id }).eq('id', client.id);
            const response = await googleManager.calendarUpdate({
                calendarId: calendarId,
                eventId: existingEvent.id,
                requestBody: eventData,
            });
            return response.data;
        }

        // 3. Create New
        console.log(`🆕 Creating Calendar Event for ${client.nom}`);
        const response = await googleManager.calendarInsert({
            calendarId: calendarId,
            requestBody: eventData,
        });

        // 4. Save ID
        if (response.data && response.data.id) {
            console.log(`✅ Event Created (${response.data.id}).`);
            await supabase.from('clients').update({ calendar_event_id: response.data.id }).eq('id', client.id);
        }

        return response.data;

    } catch (error) {
        console.error("🔴 Calendar Error:", error.message);
        return null;
    }
}

// --- SHEET UPDATES (VIA MANAGER) ---
async function updateSheetCell(tabName, rowIndex, columnLetter, value) {
    const tryUpdate = async (name) => {
        const range = `'${name}'!${columnLetter}${rowIndex}`;
        await googleManager.sheetsUpdate({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[value]] }
        });
        return range;
    };

    try {
        const successfulRange = await tryUpdate(tabName);
        console.log(`✅ [Sheet] Updated ${successfulRange} -> "${value}"`);
    } catch (e) {
        // Fallback: Si erreur de range, on tente sans/avec espace final (problème récurrent)
        try {
            const alternativeName = tabName.includes(' ') && tabName.endsWith(' ') ? tabName.trim() : (tabName + ' ');
            const successfulRange = await tryUpdate(alternativeName);
            console.log(`âœ… [Sheet] Updated (Retry) ${successfulRange} -> "${value}"`);
        } catch (e2) {
            console.error(`âŒ [Sheet] Update Failed for ${tabName}!${columnLetter}${rowIndex}:`, e.message);
        }
    }
}

// --- INGESTION ---
async function ingestSheets() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const now = new Date();
            fs.utimesSync(LOCK_FILE, now, now);
        }
    } catch (e) { }

    try {
        // Ensure connected
        await googleManager.connect();

        // Refresh Tab List Once
        if (TABS.length === 0) {
            try {
                const meta = await googleManager.sheetsGetMeta({ spreadsheetId: SPREADSHEET_ID });
                const actualSheetTitles = meta.data.sheets.map(s => s.properties.title);
                TABS = TABS_CONFIG.map(cfg => actualSheetTitles.find(t => t.toLowerCase().trim() === cfg.toLowerCase().trim())).filter(Boolean);
            } catch (e) {
                TABS = [...TABS_CONFIG];
            }
        }

        for (const tabName of TABS) {
            try {
                const range = `'${tabName}'!A4:Z3000`;
                const res = await googleManager.sheetsGet({ spreadsheetId: SPREADSHEET_ID, range });
                const rows = res.data.values || [];

                // --- STATE DIFFING (Global Tab Content) ---
                const tabHash = generateHash(rows);
                if (stateCache.get(`tab_${tabName}`) === tabHash) {
                    continue; // No change in this tab since last check
                }
                stateCache.set(`tab_${tabName}`, tabHash);

                if (rows.length > 0) {
                    console.log(`✅ [Ingest] "${tabName}": ${rows.length} rows found.`);
                    notifiedEmptyTabs.delete(tabName); // Reset warning if data returns
                } else {
                    if (!notifiedEmptyTabs.has(tabName)) {
                        console.warn(`🛑 [Ingest] Empty data for "${tabName}" (Range: ${range}). Verify if data starts at A4.`);
                        notifiedEmptyTabs.add(tabName);
                    }
                    continue;
                }

                // 2. Initial Stock (B1)
                const stockRes = await googleManager.sheetsGet({ spreadsheetId: SPREADSHEET_ID, range: `'${tabName}'!B1` });
                const initialStock = parseInt(stockRes.data.values?.[0]?.[0] || '0');
                let totalConsumed = 0;

                console.log(`✅ [Ingest] "${tabName}": ${rows.length} potential rows. Processing...`);

                let emptyRowCount = 0;
                for (let i = 0; i < rows.length; i++) {
                    let row = rows[i];
                    const rowIndex = i + 4;

                    // Support for empty rows at the end or in between
                    if (!row || row.length === 0 || !(row[0] || '').trim()) {
                        emptyRowCount++;
                        if (emptyRowCount > 10) {
                            if (tabName.includes('metropole')) console.log(`[Debug] Stopping ${tabName} at row ${rowIndex} (10 consecutive empty)`);
                            break;
                        }
                        continue;
                    }

                    // Reset counter if we find a valid row
                    emptyRowCount = 0;

                    // --- ANTI-CSV-COMPRESSION LOGIC ---
                    if (row.length === 1 && String(row[0]).includes(',')) {
                        row = csvSplit(row[0]);
                    }

                    // --- SKIP HEADERS ---
                    if (isHeaderRow(row)) {
                        continue;
                    }

                    // --- CALC STOCK (Always do this BEFORE hash skip to keep D1/F1 accurate) ---
                    const val = parseInt((row[SHEET_SCHEMA.COL_NB_LED] || '0').replace(/\s/g, ''));
                    if (!isNaN(val)) totalConsumed += val;

                    // --- STATE DIFFING (Row Level) ---
                    const rowHash = generateHash(row);
                    const cacheKey = `${tabName}_row_${rowIndex}`;
                    if (stateCache.get(cacheKey) === rowHash) {
                        continue; // Row hasn't changed
                    }
                    // We don't set the cache yet, but we will after successful update to ensure persistence

                    const nom = (row[0] || '').trim();
                    if (!nom) continue; // Should be handled by emptyRowCount but safety first

                    if (tabName.includes('metropole')) {
                        console.log(`[Debug] Processing Row ${rowIndex}: Name="${nom}"`);
                    }

                    const id = `${tabName}_${rowIndex}`.replace(/\s+/g, '_');

                    const { data: existing } = await supabase.from('clients')
                        .select('id, nom, prenom, adresse_brute, telephone, email, nb_led, statut_client, date_livraison_prevue, statut_livraison, date_install_debut, date_install_fin, date_install_fin_reelle, statut_installation, livreur_id, updated_at, calendar_event_id')
                        .eq('id', id)
                        .single();

                    const clientData = {
                        id,
                        zone_pays: getZoneFromTab(tabName),
                        google_row_index: rowIndex,
                        nom: (row[0] || '').replace(/^"|"$/g, ''),
                        prenom: (row[1] || '').replace(/^"|"$/g, ''),
                        adresse_brute: (row[2] || '').replace(/^"|"$/g, ''),
                        // ROW[3] is Code Postal (Skip or Read if DB supports it)
                        telephone: (row[SHEET_SCHEMA.COL_TELEPHONE] || '').replace(/^"|"$/g, ''),
                        email: (row[SHEET_SCHEMA.COL_EMAIL] || '').replace(/^"|"$/g, ''),
                        nb_led: parseInt((row[SHEET_SCHEMA.COL_NB_LED] || '0').replace(/\s/g, '')),
                        statut_client: (row[SHEET_SCHEMA.COL_STATUT_GLOBAL] || '').trim().toUpperCase(),
                        date_livraison_prevue: parseDateToISO(row[SHEET_SCHEMA.COL_LIVRAISON_DATE]),
                        heure_livraison: (row[SHEET_SCHEMA.COL_LIVRAISON_TIME] || null),
                        signature_livraison: (row[SHEET_SCHEMA.COL_LIVRAISON_SIGNATURE] || null),
                        date_install_debut: parseDateToISO(row[SHEET_SCHEMA.COL_INSTALL_DATE_DEBUT]),
                        date_install_fin: parseDateToISO(row[SHEET_SCHEMA.COL_INSTALL_DATE_FIN]),
                        date_install_fin_reelle: (row[SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE] || null), // Import Raw (contains Time)
                        statut_installation: (row[SHEET_SCHEMA.COL_INSTALL_STATUT] || null),
                        // Handle Driver ID (Read Name -> Convert to ID)
                        // If Sheet contains "Nicolas", we map to "camion-1000". If unknown, we keep raw.
                        livreur_id: ((() => {
                            const val = (row[SHEET_SCHEMA.COL_CAMION_ID] || '').trim();
                            for (const [name, id] of Object.entries(NAME_TO_ID)) {
                                if (val.toLowerCase() === name.toLowerCase()) return id;
                            }
                            return val || null;
                        })()),
                        updated_at: new Date()
                    };

                    // Normalize Status BEFORE comparison to prevent "Ghost Loops"
                    // (e.g. "✅ 6. TERMINÉ" vs "TERMINÉ")
                    if (existing && existing.statut_client && clientData.statut_client) {
                        const cleanNew = clientData.statut_client.replace(/^[0-9✅🔴🚚📦📅🚧\s\.]+/, '').trim().toUpperCase();
                        const cleanOld = existing.statut_client.replace(/^[0-9✅🔴🚚📦📅🚧\s\.]+/, '').trim().toUpperCase();

                        if (cleanNew === cleanOld) {
                            // Semantically identical: Use the DB version to avoid detecting a change
                            clientData.statut_client = existing.statut_client;
                        }
                    }

                    // Check for changes (ignoring updated_at/id)
                    let hasChanged = !existing;
                    if (existing) {
                        if (existing.nom !== clientData.nom) hasChanged = true;
                        if ((existing.prenom || '') !== (clientData.prenom || '')) hasChanged = true;
                        if ((existing.adresse_brute || '') !== (clientData.adresse_brute || '')) hasChanged = true;
                        if ((existing.telephone || '') !== (clientData.telephone || '')) hasChanged = true;
                        if ((existing.email || '') !== (clientData.email || '')) hasChanged = true;
                        if (existing.nb_led !== clientData.nb_led) hasChanged = true;
                        if ((existing.statut_client || '') !== (clientData.statut_client || '')) hasChanged = true;
                        if ((existing.date_livraison_prevue || '') !== (clientData.date_livraison_prevue || '')) hasChanged = true;
                        if ((existing.livreur_id || '') !== (clientData.livreur_id || '')) hasChanged = true;
                        if ((existing.statut_installation || '') !== (clientData.statut_installation || '')) hasChanged = true;
                        if ((existing.date_install_fin_reelle || '') !== (clientData.date_install_fin_reelle || '')) hasChanged = true;
                    }

                    if (!hasChanged && tabName.includes('metropole')) {
                        console.log(`[Debug] Row ${rowIndex} No Change detected.`);
                    }

                    if (hasChanged) {
                        if (existing) {
                            const diffs = [];
                            if (existing.nom !== clientData.nom) diffs.push(`Nom: ${existing.nom}->${clientData.nom}`);
                            if ((existing.statut_client || '') !== (clientData.statut_client || '')) diffs.push(`Statut: ${existing.statut_client}->${clientData.statut_client}`);
                            if (Number(existing.nb_led) !== Number(clientData.nb_led)) diffs.push(`LED: ${existing.nb_led}->${clientData.nb_led}`);

                            if (diffs.length > 0) console.log(`🔍 [Diff] ${id} (${clientData.nom}): ${diffs.join(', ')}`);
                        }
                        // --- GRACE PERIOD (Safety first) ---
                        // If the client was updated in Supabase very recently, skip ingestion.
                        if (existing && existing.updated_at) {
                            const lastUpdate = new Date(existing.updated_at);
                            const ageMs = Date.now() - lastUpdate.getTime();
                            // Increased grace period to 45s to break infinite loops and racing
                            if (ageMs < 45000) {
                                console.log(`⏳ [Ingest] Skipping ${id} (Modified by User ${Math.round(ageMs / 1000)}s ago - Protection Active)`);
                                continue;
                            }
                        }

                        console.log(`[Debug] Change detected for ${id}`);

                        // Check for REAL client replacement (Case insensitive)
                        const isNameDifferent = existing && existing.nom && clientData.nom &&
                            existing.nom.trim().toLowerCase() !== clientData.nom.trim().toLowerCase();

                        if (isNameDifferent) {
                            console.log(`[Ingest] Client replacement detected for ${id} (Old: "${existing.nom}" -> New: "${clientData.nom}"). Resetting status fields.`);
                            Object.assign(clientData, {
                                date_livraison_prevue: null,
                                statut_livraison: null,
                                date_install_debut: null,
                                date_install_fin: null,
                                statut_installation: null,
                                calendar_event_id: null
                            });
                        }



                        const { error } = await supabase.from('clients').upsert(clientData, { onConflict: 'id' });
                        if (!error) {
                            console.log(`[Ingest] Updated Client: ${id} (${clientData.nom})`);
                            stateCache.set(`${tabName}_row_${rowIndex}`, generateHash(row));
                        } else {
                            console.error(`[Ingest] Supabase Error for ${id}:`, error.message);
                        }
                    } else {
                        // No logic change but we still want to cache the row state to avoid re-parsing next time
                        stateCache.set(`${tabName}_row_${rowIndex}`, generateHash(row));
                    }
                }

                // 3. Finalize Stock Update
                try {
                    const remaining = initialStock - totalConsumed;
                    const stockHash = generateHash(`${totalConsumed}_${remaining}`);
                    const stockCacheKey = `stock_${tabName}`;

                    if (stateCache.get(stockCacheKey) !== stockHash) {
                        console.log(`📊 [Stock] ${tabName}: Initial=${initialStock}, Consumed=${totalConsumed}, Remaining=${remaining}. Updating D1/F1...`);
                        await googleManager.sheetsBatchUpdate({
                            spreadsheetId: SPREADSHEET_ID,
                            requestBody: {
                                valueInputOption: 'USER_ENTERED',
                                data: [
                                    { range: `'${tabName}'!D1`, values: [[totalConsumed]] },
                                    { range: `'${tabName}'!F1`, values: [[remaining]] }
                                ]
                            }
                        });
                        stateCache.set(stockCacheKey, stockHash);
                    } else {
                        // console.log(`📊 [Stock] ${tabName} unchanged.`);
                    }
                } catch (stockErr) {
                    console.error(`⚠️ [Stock] Error finalizing stock for ${tabName}:`, stockErr.message);
                }
            } catch (e) { console.error(`Error reading tab ${tabName}:`, e.message); }

            // Wait a bit even with manager to be nice - INCREASING DELAY to avoid Rate Limit
            await new Promise(r => setTimeout(r, 2000)); // Was 200ms, now 2s between rows/tabs to let Google breathe
        }
    } catch (e) { console.error('Ingestion Cycle Error:', e); }
}

// --- READ ROW HELPER ---
async function readSheetRow(tabName, rowIndex) {
    try {
        const range = `'${tabName}'!A${rowIndex}:Z${rowIndex}`;
        const res = await googleManager.sheetsGet({
            spreadsheetId: SPREADSHEET_ID,
            range: range
        });
        return res.data.values?.[0] || [];
    } catch (e) {
        return [];
    }
}

// --- SHARED PROCESSING LOGIC ---
async function processClientUpdate(newData, oldData = {}) {
    if (!newData || !newData.id) return;

    const parts = parseId(newData.id);

    // --- NEW CLIENT CREATION LOGIC ---
    if (!parts) {
        // If ID is not format "Tab_Row", it might be a new UUID client from App
        if (newData.id.length > 10 && newData.nom) {
            console.log(`✨ [New Client] Detected new client "${newData.nom}" with temp ID: ${newData.id}`);

            // 1. Determine Target Tab
            let targetTab = 'fr metropole '; // Default (padding space is important if in config)
            const zone = (newData.zone_pays || 'FR').toUpperCase();

            const ZONE_TAB_MAP = {
                'FR': 'fr metropole ',
                'GP': 'Guadeloupe',
                'MQ': 'Martinique',
                'GF': 'Guyane',
                'RE': 'Reunion',
                'YT': 'Mayotte',
                'CORSE': 'Corse'
            };

            if (ZONE_TAB_MAP[zone]) targetTab = ZONE_TAB_MAP[zone];
            // Try matching Zip Code if zone is generic
            if (newData.code_postal && newData.code_postal.startsWith('971')) targetTab = 'Guadeloupe';
            if (newData.code_postal && newData.code_postal.startsWith('972')) targetTab = 'Martinique';
            // ... add others if needed

            console.log(`✨ [New Client] Assigned to tab: "${targetTab}"`);

            // 2. Prepare Row Data
            const rowData = new Array(20).fill(''); // Safety buffer
            rowData[SHEET_SCHEMA.COL_NOM] = newData.nom || '';
            rowData[SHEET_SCHEMA.COL_PRENOM] = newData.prenom || '';
            rowData[SHEET_SCHEMA.COL_ADRESSE] = newData.adresse_brute || '';
            rowData[SHEET_SCHEMA.COL_TELEPHONE] = newData.telephone || '';
            rowData[SHEET_SCHEMA.COL_EMAIL] = newData.email || '';
            rowData[SHEET_SCHEMA.COL_NB_LED] = newData.nb_led || '0';
            rowData[SHEET_SCHEMA.COL_STATUT_GLOBAL] = "🔴 1. Livraison à planifier";

            // Dates & Meta
            if (newData.date_livraison_prevue) {
                const { date } = formatDateValues(newData.date_livraison_prevue);
                rowData[SHEET_SCHEMA.COL_LIVRAISON_DATE] = date;
            }

            // 3. Append to Sheet
            try {
                const appendRes = await googleManager.sheetsAppend({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `'${targetTab}'!A:A`, // Append to end of sheet
                    valueInputOption: 'USER_ENTERED',
                    insertDataOption: 'INSERT_ROWS',
                    requestBody: {
                        values: [rowData]
                    }
                });

                // 4. Extract New Row Index
                const updatedRange = appendRes.data.updates?.updatedRange || ''; // e.g. "'fr metropole '!A105:T105"
                const match = updatedRange.match(/[A-Z]+(\d+):/);

                if (match && match[1]) {
                    const newRowIndex = parseInt(match[1]);
                    const cleanTabName = targetTab.replace(/\s+/g, '_'); // Match bridge ID format
                    const newId = `${cleanTabName}_${newRowIndex}`;

                    console.log(`✅ [New Client] Created at Row ${newRowIndex}. Migrating ID: ${newData.id} -> ${newId}`);

                    // 5. Update Supabase ID (Migration) AND Status
                    const { error } = await supabase.from('clients')
                        .update({
                            id: newId,
                            google_row_index: newRowIndex,
                            zone_pays: getZoneFromTab(targetTab),
                            statut_client: "🔴 1. Livraison à planifier" // FORCE UPDATE
                        })
                        .eq('id', newData.id);

                    if (error) console.error("❌ [New Client] Failed to migrate ID:", error.message);
                    else console.log("✅ [New Client] ID Migration Successful & Status Initialized.");

                    return; // Done
                }
            } catch (e) {
                console.error("❌ [New Client] Failed to append to sheet:", e.message);
            }
        }
        return;
    }
    const { tabName: sanitizedTabName, rowIndex } = parts;
    const tabName = resolveTabName(sanitizedTabName);

    // 1. CALCULATE EXPECTED STATES (Strict Sequential Logic)
    const livStatus = (newData.statut_livraison || '').toUpperCase();
    const instStatus = (newData.statut_installation || '').toUpperCase();
    const isDelivered = livStatus.includes('LIVRÉ') || livStatus.includes('LIVREE') || newData.date_livraison_reelle;
    const todayStr = new Date().toLocaleDateString('fr-FR'); // DD/MM/YYYY
    const todayISO = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Helper robust date check
    const checkIsToday = (dateStr) => {
        if (!dateStr) return false;
        if (dateStr.startsWith(todayISO)) return true; // YYYY-MM-DD match
        if (dateStr.startsWith(todayStr)) return true; // DD/MM/YYYY match
        // Check manually parsed
        try {
            const parts = dateStr.includes('/') ? dateStr.split(' ')[0].split('/') : null;
            if (parts && parts.length === 3) {
                // parts [DD, MM, YYYY]
                if (parts[0] === todayStr.split('/')[0] && parts[1] === todayStr.split('/')[1]) return true;
            }
        } catch (e) { }
        return false;
    };

    const isInstallToday = checkIsToday(newData.date_install_debut);

    let state = 1;
    let statusText = "🔴 1. Livraison à planifier";

    if (instStatus.includes('TERMIN') || newData.date_install_fin) {
        state = 6; statusText = "✅ 6. Terminé";
    }
    else if (isInstallToday || instStatus.includes('EN_COURS')) {
        state = 5; statusText = "🚧 5. Installation en cours";
        if (instStatus !== 'EN_COURS' && isInstallToday) {
            console.log(`🚧 [Auto-Start] Installation day reached for ${newData.nom}. Setting status to EN_COURS.`);
            // Calculer la fin estimée pour l'auto-start
            const now = new Date();
            const estEnd = calculateEstimatedEnd(now, newData.nb_led || 0);
            const { date, time } = formatDateValues(estEnd);

            supabase.from('clients').update({
                statut_installation: 'EN_COURS',
                date_install_fin_reelle: `${date} ${time}`
            }).eq('id', newData.id).then();
        }
    }
    else if (newData.date_install_debut || instStatus.includes('PLANIFI')) {
        state = 4; statusText = "📅 4. Installation confirmée";
    }
    else if (isDelivered) {
        state = 3; statusText = "📦 3. Matériel reçu";
    }
    else if (newData.date_livraison_prevue) {
        state = 2; statusText = "🚚 2. Livraison confirmée";
    }

    // Override if explicit "Install à planifier" needed?
    // Let's stick to simple:
    // 1. No Date Liv -> A planifier
    // 2. Date Liv -> Confirmed
    // 3. Date Real Liv -> Recu
    // 4. Date Install -> Install Confirm
    // 5. Date Install Fin -> Termine

    if (newData.nom && newData.nom.toLowerCase().includes('simon')) {
        console.log(`   => COMPUTED STATE: ${state} (${statusText})`);
    }

    try {
        // 2. FETCH CURRENT ROW TO COMPARE (1 Read Request)
        const currentRow = await readSheetRow(tabName, rowIndex);

        // --- SAFETY CHECK: GHOST ROW ---
        // If the row in the sheet is empty (Scanning Name/Address), DO NOT WRITE.
        // This prevents Supabase ghosts from polluting empty lines.
        const currentName = currentRow[SHEET_SCHEMA.COL_NOM] || '';
        const currentAddr = currentRow[SHEET_SCHEMA.COL_ADRESSE] || '';
        if (!currentName.trim() && !currentAddr.trim()) {
            console.warn(`👻 [Ghost Blocked] Database has client at ${tabName}!${rowIndex}, but Sheet row is empty. Skipping write.`);
            return;
        }

        const updates = []; // Store updates to be batched

        // Helper to check and schedule update
        const checkAndAdd = (colIndex, colLetter, newVal) => {
            const currentVal = currentRow[colIndex] || '';
            // Compare normalized strings to avoid jitter
            if (currentVal.trim() !== newVal.trim()) {
                const logMsg = currentVal.trim() === '' ?
                    `📝 Buffering Update (Repairing Empty): ${colLetter}${rowIndex} "" -> "${newVal}"` :
                    `📝 Buffering Update: ${colLetter}${rowIndex} "${currentVal}" -> "${newVal}"`;
                console.log(logMsg);
                updates.push({
                    range: `'${tabName}'!${colLetter}${rowIndex}`,
                    values: [[newVal]]
                });
            }
        };

        // 3. DETERMINE DESIRED VALUES

        // Col G: Global Status
        // console.log(`🔍 [Status Check] ID: ${newData.id} inputState=${state} => "${statusText}"`);
        checkAndAdd(SHEET_SCHEMA.COL_STATUT_GLOBAL, 'G', statusText);

        // State 2: Liv Planifiée (Col H)
        if (state === 2 && newData.date_livraison_prevue) {
            const { date } = formatDateValues(newData.date_livraison_prevue);
            checkAndAdd(SHEET_SCHEMA.COL_LIVRAISON_DATE, 'H', date);

            // --- FORCE LIVREUR TM 1 ---
            if (newData.livreur_id !== 'TM 1') {
                console.log(`🚚 [Auto-Assign] Correcting driver for ${newData.nom}: TM 1`);
                newData.livreur_id = 'TM 1';
                // Update DB to be persistent
                supabase.from('clients').update({ livreur_id: 'TM 1' }).eq('id', newData.id).then();
            }

            // --- SYNC CALENDAR (DELIVERY) ---
            const d = new Date(newData.date_livraison_prevue);
            d.setHours(8, 0, 0, 0); // 8:00 AM
            const endD = new Date(d.getTime() + 1 * 60 * 60 * 1000);

            const deliveryCalId = process.env.CALENDAR_ID || 'primary';
            const zoneCode = newData.zone_pays || getZoneFromTab(tabName) || '';

            try {
                const event = await createCalendarEvent(deliveryCalId, {
                    summary: `🚚 Liv : ${newData.nom} (${newData.ville || zoneCode})`,
                    location: newData.adresse_brute || '',
                    description: `Client: ${newData.nom}\nID: ${newData.id}\nLivreur: TM 1\nStatut: ${statusText}`,
                    start: { dateTime: d.toISOString(), timeZone: 'Europe/Paris' },
                    end: { dateTime: endD.toISOString(), timeZone: 'Europe/Paris' }
                }, newData);
                if (event) console.log(`📅 [Cal] Delivery event synced for ${newData.nom}`);
            } catch (e) {
                console.error(`📅 [Cal] Delivery sync failed for ${newData.nom}:`, e.message);
            }
        }

        // State 3+: Livrée (Col I, J)
        const isDeliveredLocal = livStatus.includes('LIVRÉ') || livStatus.includes('LIVREE') || newData.date_livraison_reelle;
        const currentSignature = (currentRow[SHEET_SCHEMA.COL_LIVRAISON_SIGNATURE] || '').toString();

        if (isDeliveredLocal && !currentSignature.trim()) {
            console.log(`🔍 [Delivery Sync] Processing I/J columns for ${newData.nom}...`);
            let dateToSync = '', timeToSync = '';

            // Determine Date/Time
            const now = new Date();
            const { date: serverDate, time: serverTime } = formatDateValues(now);
            dateToSync = serverDate; timeToSync = serverTime;

            if (newData.date_livraison_reelle && newData.date_livraison_reelle.length > 10) {
                const { date, time } = formatDateValues(newData.date_livraison_reelle);
                if (date) { dateToSync = date; if (time) timeToSync = time; }
            } else if (newData.date_livraison_validee && newData.date_livraison_validee.length > 10) {
                const { date, time } = formatDateValues(newData.date_livraison_validee);
                if (date) { dateToSync = date; if (time) timeToSync = time; }
            }

            // Col I (Signature/Date+Time)
            checkAndAdd(SHEET_SCHEMA.COL_LIVRAISON_SIGNATURE, 'I', `${dateToSync} ${timeToSync}`.trim());
            // Col J (Time)
            checkAndAdd(SHEET_SCHEMA.COL_LIVRAISON_TIME, 'J', timeToSync);
        }

        // State 4-5: Install Confirmée/Planifiée (Col K)
        if (state === 4 || state === 5 || newData.date_install_debut || (state === 2 && newData.date_livraison_prevue)) {
            let installDate = newData.date_install_debut;

            // Planification automatique le même jour que la livraison si vide
            if (!installDate && newData.date_livraison_prevue) {
                installDate = newData.date_livraison_prevue;

                // Mettre à jour Supabase pour garder les données synchrones
                supabase.from('clients')
                    .update({
                        date_install_debut: installDate,
                        statut_installation: 'PLANIFIÉE'
                    })
                    .eq('id', newData.id)
                    .then(() => console.log(`📅 [Auto-Plan] Installation sync avec livraison pour ${newData.nom}`));
            }

            if (installDate) {
                const { date: fDate } = formatDateValues(installDate);
                checkAndAdd(SHEET_SCHEMA.COL_INSTALL_DATE_DEBUT, 'K', fDate);

                // --- FORCE INSTALLATEUR TM 1 ---
                checkAndAdd(SHEET_SCHEMA.COL_INSTALL_POSEUR_ID, 'Q', 'TM 1');

                // --- SYNC STATUS COL M ---
                // Si c'est aujourd'hui, on force "EN COURS" dans la colonne M aussi
                // FIX: Respecter le statut explicite s'il est déjà EN_COURS ou TERMINE
                let currentStatusM = 'PLANIFIÉE';
                if (instStatus.includes('EN_COURS') || instStatus.includes('EN COURS') || isInstallToday) currentStatusM = 'EN COURS';
                if (instStatus.includes('TERMIN')) currentStatusM = 'TERMINÉE';

                checkAndAdd(SHEET_SCHEMA.COL_INSTALL_STATUT, 'M', currentStatusM);

                // --- SYNC CALENDAR ---
                // --- SYNC CALENDAR ---
                const startDate = new Date(installDate);
                const calculatedEnd = calculateEstimatedEnd(startDate, newData.nb_led || 0);

                // Google Calendar All-Day Logic (Exclusive End)
                const gCalStart = new Date(startDate);
                const gCalEnd = new Date(calculatedEnd);
                gCalEnd.setDate(gCalEnd.getDate() + 1);

                const toYMD = (d) => d.toISOString().split('T')[0];
                const shortStart = gCalStart.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
                const shortEnd = calculatedEnd.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

                const installCalId = process.env.CALENDAR_ID_INSTALLATIONS || 'primary';

                try {
                    const event = await createCalendarEvent(installCalId, {
                        summary: `🛠️ ${newData.nb_led || 0} LED - ${newData.nom} (${shortStart} ➔ ${shortEnd})`,
                        location: newData.adresse_brute || '',
                        description: `Client: ${newData.nom}\nID: ${newData.id}\nEquipe: TM 1\nStatut: ${statusText}\nDu: ${shortStart} Au: ${shortEnd}`,
                        start: { date: toYMD(gCalStart) },
                        end: { date: toYMD(gCalEnd) }
                    }, newData);
                    if (event) console.log(`📅 [Cal] Installation event synced for ${newData.nom}`);
                } catch (e) {
                    console.error(`📅 [Cal] Installation sync failed for ${newData.nom}:`, e.message);
                }
            }
        }

        // State 5: Installation en cours (Col N - FIN ESTIMÉE)
        if (state === 5) {
            const currentN = (currentRow[SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE] || '').toString();
            // Si N est vide ou provient seulement d'un import brut (ISO), on synchronise la version formatée
            if (newData.date_install_fin_reelle && (!currentN || currentN.includes('T') || currentN.trim().length === 0)) {
                checkAndAdd(SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE, 'N', newData.date_install_fin_reelle);
            }
        }

        // State 6: Terminé (Col N - DATE FIN REELLE + Col L Date)
        if (state === 6) {
            // COL L: DATE FIN (Prefer DB date if exists)
            let finalDateC = '';
            if (newData.date_install_fin) {
                const { date } = formatDateValues(newData.date_install_fin);
                finalDateC = date;
            } else {
                const { date } = formatDateValues(new Date());
                finalDateC = date;
            }
            checkAndAdd(SHEET_SCHEMA.COL_INSTALL_DATE_FIN, 'L', finalDateC);

            // COL N: DATE FIN REELLE (Timestamp final)
            // On met le timestamp actuel si différent
            const { date, time } = formatDateValues(newData.date_install_fin_reelle || new Date());
            checkAndAdd(SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE, 'N', `${date} ${time}`);
        }

        // Update Status (Col M - Internal/Visible)
        if (instStatus) {
            checkAndAdd(SHEET_SCHEMA.COL_INSTALL_STATUT, 'M', instStatus);
        }

        // Col O (New): Dispatch / Chauffeur
        if (newData.livreur_id) {
            const mappedName = CAMION_NAMES[newData.livreur_id] || newData.livreur_id;
            checkAndAdd(SHEET_SCHEMA.COL_CAMION_ID, 'O', mappedName);
        }

        // 4. EXECUTE BATCH WRITE (1 Request max)
        if (updates.length > 0) {
            console.log(`📡 [Sync] Flushing ${updates.length} updates for ${newData.nom} to Sheet...`);
            await googleManager.sheetsBatchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: updates
                }
            });
            console.log(`✅ [Sync] Batch Updated ${newData.nom} successfully.`);
        } else {
            // console.log(`✨ [Sync] No changes needed for ${newData.nom}.`);
        }

    } catch (err) {
        console.error("Logic Error:", err.message);
    }
}

// --- POLLING FALLBACK ---
let lastPollTime = new Date(Date.now() - 60000).toISOString(); // Start looking 1 min back

async function pollSupabaseChanges() {
    try {
        const { data: recentChanges, error } = await supabase
            .from('clients')
            .select('*')
            .gt('updated_at', lastPollTime);

        if (error) throw error;

        if (recentChanges && recentChanges.length > 0) {
            // console.log(`ðŸ”„ [Polling] Found ${recentChanges.length} updates.`);
            for (const client of recentChanges) {
                await processClientUpdate(client);
            }
            // Update lastPollTime to now (minus small buffer)
            lastPollTime = new Date(Date.now() - 5000).toISOString();
        } else {
            // Update lastPollTime anyway to advance window
            lastPollTime = new Date(Date.now() - 30000).toISOString();
        }
    } catch (e) {
        console.error("Polling Error:", e.message);
    }
}

// --- REALTIME ---
async function setupRealtimeSubscription() {
    console.log("Setting up Supabase Realtime with 2000ms Debounce...");
    supabase.channel('custom-all-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, async (payload) => {
            const client = payload.new || payload.old;
            if (!client || !client.id) return;

            const clientId = client.id;
            console.log(`⚡ [Realtime] Event received for ${client.nom} (${clientId})`);

            // Clear existing timeout
            if (realtimeDebounceTimeouts.has(clientId)) {
                clearTimeout(realtimeDebounceTimeouts.get(clientId));
            }

            // Set new timeout
            const timeout = setTimeout(async () => {
                console.log(`🚀 [Debounce] processing ${client.nom} after 2s silence.`);
                realtimeDebounceTimeouts.delete(clientId);
                await processClientUpdate(payload.new, payload.old);
            }, 2000);

            realtimeDebounceTimeouts.set(clientId, timeout);
        })
        .subscribe((status) => console.log(`Realtime Status: ${status}`));
}

// --- HEATBEAT (SILENT) ---
// setInterval(() => {}, 30000); // Disabled for silence


// --- RUNNERS (Recursive Looping for Stability) ---
async function runIngestionLoop() {
    try {
        await ingestSheets();
    } catch (e) {
        console.error("❌ [Runner] Ingestion Loop Crashed (Recovering...):", e.message);
    } finally {
        setTimeout(runIngestionLoop, CHECK_INTERVAL_MS);
    }
}

async function runPollingLoop() {
    try {
        await pollSupabaseChanges();
    } catch (e) {
        console.error("❌ [Runner] Polling Loop Crashed (Recovering...):", e.message);
    } finally {
        setTimeout(runPollingLoop, 10000);
    }
}

// --- START ---
async function start() {
    console.log("🚀 Bridge Starting with Anti-Blocking Google Manager...");
    console.log("🛡️  Security Mode: Recursive Loops enabled (Anti-Crash/Anti-Spam).");
    console.log("🕒 Date Sync: Prioritizing 'date_livraison_reelle'.");

    try {
        await googleManager.connect();

        // Initial Ingest
        await ingestSheets();

        // Start Recursive Loops
        runIngestionLoop(); // Replaces setInterval
        runPollingLoop();   // Replaces setInterval

        // Start Realtime
        setupRealtimeSubscription();

        console.log("🟢 Bridge Running safely. Waiting for events...");
    } catch (err) {
        console.error("🔥 FATAL STARTUP ERROR:", err);
        setTimeout(start, 30000);
    }
}

(async () => {
    await acquireLock();
    start();
})();
