// Force restart to fix EADDRINUSE error
// Server Entry Point - Updated for APP_URL reload
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { googleManager } from './google_manager.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// import { mockClients, mockStock } from './mockData.js';
import { SHEET_SCHEMA, STATUS } from './schema.js';

import { createClient } from '@supabase/supabase-js';

// --- MIDDLEWARES DE SÉCURITÉ & VALIDATION ---
import {
    securityHeaders,
    sanitizeInput,
    csrfProtection,
    suspiciousActivityLogger,
    requestTimeout,
    bodyLimiter
} from './middleware/security.js';

import {
    generalLimiter,
    strictLimiter,
    apiLimiter,
    geoLimiter,
    scanLimiter,
    mutationLimiter
} from './middleware/rateLimiter.js';

import {
    validate,
    stockUpdateSchema,
    stockQuerySchema,
    reportQuerySchema,
    vroomOptimizeSchema,
    updateClientSchema
} from './middleware/validation.js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
const PORT = process.env.PORT || 3001;

console.log("🚀 DEMARRAGE DU SERVEUR - VERSION AVEC FIX HEURE (COLONNE J) & TABS");

// --- START CRON JOBS ---
import('./cron_qhare.js').then(m => m.default(10)); // Check toutes les 10 min

app.use(securityHeaders);
app.use(cors());
app.use(requestTimeout(30000));
app.use(express.json(bodyLimiter.json));
app.use(express.urlencoded(bodyLimiter.urlencoded));
app.use(sanitizeInput);
app.use(suspiciousActivityLogger);
app.use(csrfProtection);
app.use(generalLimiter); // Application globale (Niveau 1)

// --- WEBHOOK QHARE (Réception temps réel) ---
app.post('/api/webhook/qhare', async (req, res) => {
    // console.log("📥 [Webhook Qhare] Données reçues:", JSON.stringify(req.body));

    try {
        const lead = req.body;

        // Validation basique
        if (!lead || (!lead.nom && !lead.id)) {
            return res.status(400).json({ error: "Payload invalide" });
        }

        console.log(`🔔 [Webhook] Notification Qhare: ${lead.nom} (Etat: ${lead.etat})`);

        // FILTRE: On n'importe QUE les dossiers "SIGNÉ"
        const etat = (lead.etat || '').toUpperCase();
        if (!etat.includes('SIGNÉ') && !etat.includes('SIGNE')) {
            console.log("⏭️ [Webhook] Ignoré (Pas signé)");
            return res.json({ status: 'ignored', reason: 'not_signed' });
        }

        // Insertion / Mise à jour Supabase
        const { data: existing } = await supabase
            .from('clients')
            .select('id')
            .or(`email.eq.${lead.email},telephone.eq.${lead.telephone},nom.eq.${lead.nom}`)
            .maybeSingle();

        if (existing) {
            console.log(`✅ [Webhook] Client déjà existant (ID: ${existing.id}). Mise à jour potentielle...`);
            // TODO: Update logic if needed
            return res.json({ status: 'exists', id: existing.id });
        }

        const newClient = {
            source: 'Qhare Webhook',
            nom: lead.nom,
            prenom: lead.prenom,
            email: lead.email,
            telephone: lead.telephone || lead.telephone_portable,
            adresse_brute: `${lead.adresse || ''} ${lead.code_postal || ''} ${lead.ville || ''}`.trim(),
            code_postal: lead.code_postal,
            ville: lead.ville,
            departement: lead.departement,
            statut_client: 'NON_PLANIFIÉ',
            nb_led: 0,
            chauffage: lead.chauffage,
            commentaire: `Import Webhook ID: ${lead.id}`
        };

        const { data: created, error } = await supabase
            .from('clients')
            .insert(newClient)
            .select()
            .single();

        if (error) throw error;

        console.log(`🎉 [Webhook] Client CRÉÉ avec succès: ${created.nom}`);
        res.json({ status: 'created', id: created.id });

    } catch (e) {
        console.error("❌ [Webhook] Erreur:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Route Proxy VROOM pour éviter les problèmes CORS
const ORS_API_KEY = process.env.ORS_API_KEY;
const ORS_API_KEY_BACKUP = process.env.ORS_API_KEY_BACKUP;
const ACTIVE_ORS_KEY = ORS_API_KEY || ORS_API_KEY_BACKUP || '';

app.post('/api/vroom/optimize', apiLimiter, validate(vroomOptimizeSchema), async (req, res) => {
    try {
        console.log("🟢 VROOM Optimization requested");

        const VROOM_LOCAL_URL = process.env.VROOM_URL || 'http://localhost:3000';
        let vroomUrl = VROOM_LOCAL_URL;

        // 1. TENTATIVE LOCALE (Si dispo)
        if (!process.env.FORCE_CLOUD) { // Variable pour forcer le cloud si besoin
            try {
                const response = await fetch(vroomUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(req.body),
                    signal: AbortSignal.timeout(2000) // 2s max pour local
                });

                if (response.ok) {
                    const data = await response.json();
                    console.log(`✅ VROOM Success via LOCAL API (${vroomUrl})`);
                    return res.json(data);
                }
            } catch (e) {
                // Silencieux si pas de local (cas fréquent)
            }
        }

        // 2. TENTATIVE OPENROUTESERVICE (Cloud Gratuit - Meilleure option)
        if (ACTIVE_ORS_KEY && ACTIVE_ORS_KEY.length > 20) {
            console.log("☁️ Tentative ORS Optimization API...");
            try {
                const orsResp = await fetch('https://api.openrouteservice.org/optimization', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': ACTIVE_ORS_KEY
                    },
                    body: JSON.stringify(req.body),
                    signal: AbortSignal.timeout(15000)
                });

                if (orsResp.ok) {
                    const data = await orsResp.json();
                    console.log("✅ ORS Optimization Success");
                    return res.json(data);
                } else {
                    const errText = await orsResp.text();
                    console.warn(`⚠️ ORS Failed (${orsResp.status}):`, errText.substring(0, 200));
                }
            } catch (e) {
                console.error("⚠️ ORS Exception:", e.message);
            }
        }

        // 3. FALLBACK : API PUBLIQUE VROOM (Dernier recours)
        console.log("⚠️ Utilisation VROOM Public Demo API (Fallback)...");
        const responsePublic = await fetch('http://solver.vroom-project.org/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
            signal: AbortSignal.timeout(30000)
        });

        const dataPublic = await responsePublic.json();
        if (!responsePublic.ok) {
            console.error("🔴 VROOM Public Error:", JSON.stringify(dataPublic));
            return res.status(responsePublic.status).json(dataPublic);
        }

        console.log(`✅ VROOM Success via PUBLIC API`);
        res.json(dataPublic);
    } catch (error) {
        console.error("🔴 VROOM Proxy Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Route VROOM (existante)
// ...


// Route SCAN GPS (Maintenance)
// Système multi-clés LocationIQ avec rotation automatique (depuis variable d'env séparée par virgules)
const LOCATION_IQ_KEYS = (process.env.LOCATION_IQ_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
let currentKeyIndex = 0;

// Fonction pour obtenir la prochaine clé (rotation)
function getNextLocationIQKey() {
    const key = LOCATION_IQ_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % LOCATION_IQ_KEYS.length;
    return key;
}

// Endpoint pour vérifier quels clients n'ont pas de GPS
app.get('/api/clients/check-gps', async (req, res) => {
    try {
        console.log("🔍 Vérification des clients sans GPS...");

        // Récupérer tous les clients
        const { data: clients, error } = await supabase.from('clients').select('*');
        if (error) throw error;

        // Identifier les clients sans GPS valide
        const missingGPS = clients.filter(c => {
            if (!c.gps) return true;
            if (typeof c.gps === 'object' && (!c.gps.lat || !c.gps.lon)) return true;
            if (typeof c.gps === 'string' && c.gps.length < 5) return true;
            return false;
        });

        // Clients avec GPS valide
        const withGPS = clients.filter(c => {
            if (!c.gps) return false;
            if (typeof c.gps === 'object' && c.gps.lat && c.gps.lon) return true;
            if (typeof c.gps === 'string' && c.gps.length >= 5) return true;
            return false;
        });

        // Formater les résultats
        const missingList = missingGPS.map(c => ({
            id: c.id,
            nom: c.nom,
            prenom: c.prenom,
            adresse: c.adresse_brute || `${c.adresse || ''} ${c.code_postal || ''} ${c.ville || ''}`.trim(),
            gps: c.gps || null,
            statut: c.statut_client
        }));

        const withGPSList = withGPS.map(c => ({
            id: c.id,
            nom: c.nom,
            prenom: c.prenom,
            gps: c.gps
        }));

        res.json({
            total: clients.length,
            withGPS: withGPS.length,
            missingGPS: missingGPS.length,
            percentage: clients.length > 0 ? Math.round((withGPS.length / clients.length) * 100) : 0,
            clientsWithoutGPS: missingList,
            clientsWithGPS: withGPSList
        });

    } catch (error) {
        console.error("🔴 Erreur vérification GPS:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/clients/scan-gps', scanLimiter, async (req, res) => {
    try {
        console.log("🛠️ Démarrage du scan GPS serveur...");

        // 1. Récupérer les clients sans GPS
        const { data: clients, error } = await supabase.from('clients').select('*');
        if (error) throw error;

        const missingGPS = clients.filter(c => {
            if (!c.gps) return true;
            if (typeof c.gps === 'object' && (!c.gps.lat || !c.gps.lon)) return true;
            if (typeof c.gps === 'string' && c.gps.length < 5) return true;
            return false;
        });

        console.log(`🔍 ${missingGPS.length} clients trouvés sans GPS.`);

        let fixed = 0;
        let failed = 0;

        for (const client of missingGPS) {
            const address = client.adresse_brute || `${client.adresse} ${client.code_postal} ${client.ville}`;

            if (!address || address.length < 5) {
                console.log(`⏭️ Skip ${client.nom}: adresse vide`);
                continue;
            }

            // Pause pour respect API BAN (très permissive)
            await new Promise(r => setTimeout(r, 200));

            let lat = null;
            let lon = null;
            let source = '';

            // 1. Essai API BAN (France + DOM) - Rapide & Gratuit
            try {
                const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
                const geoRes = await fetch(url);

                if (geoRes.ok) {
                    const geoData = await geoRes.json();
                    if (geoData.features && geoData.features.length > 0) {
                        const coords = geoData.features[0].geometry.coordinates; // [lon, lat]
                        lon = parseFloat(coords[0]);
                        lat = parseFloat(coords[1]);
                        source = 'BAN';
                    }
                }
            } catch (err) {
                console.warn(`⚠️ Erreur BAN pour ${client.nom}:`, err.message);
            }

            // 2. Fallback LocationIQ (Si BAN échoue) - Plus robuste à l'international/mal formaté
            if (!lat || !lon) {
                console.log(`⚠️ BAN échec pour "${address}". Tentative LocationIQ...`);
                // Délai supplémentaire pour LocationIQ (Max 2 req/s en gratuit)
                await new Promise(r => setTimeout(r, 600));

                try {
                    const key = getNextLocationIQKey();
                    // Ajout de &countrycodes=fr pour prioriser la France/DOM si possible, mais on laisse ouvert au cas où
                    const urlIQ = `https://eu1.locationiq.com/v1/search.php?key=${key}&q=${encodeURIComponent(address)}&format=json&limit=1`;
                    const resIQ = await fetch(urlIQ);

                    if (resIQ.ok) {
                        const dataIQ = await resIQ.json();
                        if (Array.isArray(dataIQ) && dataIQ.length > 0) {
                            lat = parseFloat(dataIQ[0].lat);
                            lon = parseFloat(dataIQ[0].lon);
                            source = 'LocationIQ';
                        }
                    } else {
                        // Log discret pour éviter de spammer si quota dépassé
                        if (resIQ.status === 429) console.warn("LocationIQ Rate Limit Reached");
                    }
                } catch (err) {
                    console.warn(`⚠️ Erreur LocationIQ pour ${client.nom}:`, err.message);
                }
            }

            // 3. Sauvegarde si trouvé
            if (lat && lon) {
                try {
                    await supabase
                        .from('clients')
                        .update({
                            gps: { lat, lon },
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', client.id);

                    console.log(`✅ Fixed (${source}): ${client.nom} ${client.prenom} → ${lat}, ${lon}`);
                    fixed++;
                } catch (updateErr) {
                    console.error("Erreur Update Supabase:", updateErr);
                }
            } else {
                console.log(`❌ ECHEC TOTAL: ${client.nom} ${client.prenom} - Adresse: "${address}"`);
                failed++;
            }
        }

        res.json({ success: true, fixed, failed, total: missingGPS.length });

    } catch (error) {
        console.error("🔴 Server Scan Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" }
});

io.on('connection', (socket) => {
    console.log('⚡ Client connecté:', socket.id);
});

// --- GRACEFUL SHUTDOWN (Sécurité Port) ---
const shutdown = () => {
    console.log("🛑 Arrêt du serveur (Graceful Shutdown)...");
    io.close(() => {
        httpServer.close(() => {
            console.log("👋 Serveur fermé et port 3001 libéré.");
            process.exit(0);
        });
    });
    // Forcer quitter si ça prend trop de temps
    setTimeout(() => process.exit(1), 5000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Notifier tous les clients
const notifyUpdate = (type, data = {}) => {
    io.emit('update', { type, data, timestamp: new Date().toISOString() });
};

// --- HELPER DATES ---
const formatDateForSheet = (dateInput) => {
    if (!dateInput) return '';
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return '';

    // Convertir en heure de Paris
    const formatter = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

    try {
        const parts = formatter.formatToParts(date);
        const get = (type) => parts.find(p => p.type === type)?.value;
        return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
    } catch (e) {
        console.error("Date formatting error:", e);
        return '';
    }
};

const parseDateFromSheet = (rawValue) => {
    if (!rawValue) return null;

    // Normalize: replace 'h' with ':' and ensure simple spacing
    let clean = rawValue.replace(/h/gi, ':').trim();

    // Regex for DD/MM/YYYY or DD/MM/YY with optional time HH:MM
    const match = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2})[:](\d{2}))?/);

    if (match) {
        let [_, d, m, y, h, min] = match;
        d = d.padStart(2, '0');
        m = m.padStart(2, '0');
        if (y.length === 2) y = '20' + y; // Assume 20xx
        h = h ? h.padStart(2, '0') : '12';
        min = min ? min.padStart(2, '0') : '00';
        return `${y}-${m}-${d}T${h}:${min}:00.000`;
    }
    return null;
};

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

    // Ajuster à l'heure de début si avant ou après les heures
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


// --- GOOGLE SHEETS ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
// IDs des agendas (à remplir par l'utilisateur ou via .env)
const CALENDAR_ID_LIVRAISONS = process.env.CALENDAR_ID_LIVRAISONS || 'primary';
const CALENDAR_ID_INSTALLATIONS = process.env.CALENDAR_ID_INSTALLATIONS || 'primary';

let googleSheetsService = null;
let googleCalendarService = null;

async function connectToGoogle() {
    try {
        const connected = await googleManager.connect();
        if (connected) {
            console.log("🟢 [Server] Google Manager Connecté (Anti-Blocking Active).");
            console.log(`📅 ID Agenda Livraisons: ${CALENDAR_ID_LIVRAISONS}`);
            console.log(`📅 ID Agenda Installations: ${CALENDAR_ID_INSTALLATIONS}`);

            // ADAPTER: Rediriger les appels existants vers le GoogleManager (Queue + Retry)
            googleSheetsService = {
                spreadsheets: {
                    values: {
                        get: (p) => googleManager.sheetsGet(p),
                        update: (p) => googleManager.sheetsUpdate(p),
                        batchUpdate: (p) => googleManager.sheetsBatchUpdate(p)
                    },
                    get: (p) => googleManager.sheetsGetMeta(p)
                }
            };

            googleCalendarService = {
                events: {
                    list: (p) => googleManager.calendarList(p),
                    insert: (p) => googleManager.calendarInsert(p),
                    update: (p) => googleManager.calendarUpdate(p),
                    get: (p) => googleManager.calendarGet(p)
                }
            };

        } else {
            console.log("🟠 [Server] Mode Offline (credentials.json manquant ou erreur).");
        }
    } catch (error) {
        console.error("🔴 [Server] Erreur connexion Google:", error.message);
    }
}
connectToGoogle();

// --- UTILS SHEETS ---
function getColLetter(colIndex) {
    // 0 -> A, 1 -> B ...
    return String.fromCharCode(65 + colIndex);
}

async function batchUpdate(data) {
    if (!googleSheetsService) return;
    try {
        await googleSheetsService.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                data: data,
                valueInputOption: 'USER_ENTERED'
            }
        });
        console.log(`✅ Batch Update: ${data.length} cells updated.`);
    } catch (error) {
        console.error("🔴 Batch Update Error:", error.message);
    }
}

/**
 * Créer un événement dans Google Calendar
 * @param {string} calendarId - ID de l'agenda
 * @param {object} event - Détails de l'événement (summary, location, description, start, end)
 */
async function createCalendarEvent(calendarId, event) {
    if (!googleCalendarService) {
        console.warn("⚠️ Google Calendar Service non initialisé.");
        return null;
    }
    try {
        console.log(`📡 Tentative de création d'événement sur agenda: ${calendarId}`);
        console.log(`🕒 Horaire: ${event.start?.dateTime} -> ${event.end?.dateTime}`);
        const response = await googleCalendarService.events.insert({
            calendarId: calendarId,
            requestBody: event,
        });
        console.log(`📅 Événement créé avec succès : ${response.data.htmlLink}`);
        return response.data;
    } catch (error) {
        console.error("🔴 Erreur Google Calendar détaillée:", error.message);
        if (error.response && error.response.data) {
            console.error("Détails API:", JSON.stringify(error.response.data));
        }
        return null;
    }
}


// --- ROUTES ---

// Endpoint de statut
// Endpoint de validation rapide (utilisé par les chauffeurs/poseurs via lien dans Sheets)
// Endpoint supprimé (doublon)


// Endpoint de validation rapide (utilisé par les chauffeurs/poseurs via lien dans Sheets)
app.get('/api/valider/:clientId/:type', strictLimiter, async (req, res) => {
    const { clientId, type } = req.params;

    // --- HOOK QHARE (Sync) ---
    // On lance la sync en "fire and forget" (sans attendre) pour ne pas ralentir l'app
    import('./sync_qhare.js').then(m => m.default(clientId, type)).catch(err => console.error("Sync Error import", err));

    if (!googleSheetsService || (!clientId?.startsWith('sheet-') && !clientId?.includes('_'))) {
        return res.send("<h1>Erreur : ID Client invalide ou service Google inaccessible</h1>");
    }
    try {

        let index;
        let tabName = 'devis';

        if (clientId.startsWith('sheet-')) {
            index = parseInt(clientId.split('-')[1]) + 4;
        } else {
            // CORRECT ID PARSING LOGIC compatible with bridge.js
            // Bridge ID format: 'fr_metropole__18' for 'fr metropole' tab (space -> underscore)
            // Strategy: Split by last underscore for index, then handle the rest.

            console.log(`🔍 Validation request for ID: ${clientId}`);

            const parts = clientId.split('_');
            const strIndex = parts.pop(); // Last part is always the index (e.g. "18")
            index = parseInt(strIndex);

            // Rejoin the rest to get the sanitized tab name (e.g. "fr_metropole" or "fr_metropole_")
            // Wait, if ID is "fr_metropole__18", parts are ["fr", "metropole", "", "18"] (if double underscore)
            // bridge.js: `${tabName}_${rowIndex}`.replace(/\s+/g, '_');
            // 'fr metropole' -> 'fr_metropole_18' (single underscore if space replaced by one underscore)

            // IF THE USER SAYS IT FAILED AND SHOWS DOUBLE UNDERSCORES "fr_metropole__18":
            // It means bridge.js might be doing something else or regex behavior.
            // Let's rely on finding the sheet name via string matching if possible, or robust parsing.

            // Robust Parsing:
            // Remove the last `_${index}` from the end of the string.
            const idWithoutIndex = clientId.substring(0, clientId.lastIndexOf('_'));

            // Now we have "fr_metropole_" (if there was a double underscore originally?)
            // Or "fr_metropole" 

            // Try 1: Treat as direct name (underscores = spaces?)
            // Bridge logic: replace(/\s+/g, '_') => Space becomes `_`.
            // So `fr metropole` => `fr_metropole`. 
            // ID => `fr_metropole_18`.

            // If we have `fr_metropole__18`, that implies `fr_metropole_` was the tab name part?
            // Maybe there was a trailing space in the tab name? "fr metropole " -> "fr_metropole_"

            // Let's look at the known TABS list if possible, or use a heuristic.
            // Heuristic: Replace all `_` with ` ` and trim. Then check which tab matches.
            // But we don't have TABS list here easily (it's in bridge.js).
            // Let's just try to be smart.

            let potentialName = idWithoutIndex.replace(/_/g, ' ');
            // "fr metropole " (if double underscore)

            // Clean it up
            potentialName = potentialName.trim();
            // "fr metropole"

            tabName = potentialName;

            // Special Case handling if needed provided we know standard tabs
            // But let's assume 'fr metropole' is the target.
            console.log(`👉 Resolved Tab Name: '${tabName}', Index: ${index}`);
        }

        const rangePrefix = `'${tabName}'!`;
        const nowStr = formatDateForSheet(new Date());

        if (type === 'livraison') {
            // 1. Fetch info client pour calcul
            const { data: clientData, error: fetchErr } = await supabase
                .from('clients')
                .select('nb_led')
                .eq('id', clientId)
                .single();

            if (fetchErr) console.warn("⚠️ Impossible de récupérer nb_led pour calcul date fin:", fetchErr.message);

            // 2. Calculer Date Fin Estimée (Démarrage Immédiat)
            const startDate = new Date();
            const estEnd = calculateEstimatedEnd(startDate, clientData?.nb_led || 0);
            const estEndStr = formatDateForSheet(estEnd); // Format compatible Sheet pour Col N

            // 3. UPDATE SUPABASE
            // - Validation Livraison
            // - Démarrage Installation (EN_COURS)
            // - Fixation Date Fin Réelle (Col N)
            const { error: err } = await supabase.from('clients').update({
                statut_client: STATUS.GLOBAL.EN_COURS, // Passage direct en 5. (Au lieu de LIVREE)
                statut_livraison: STATUS.LIVRAISON.LIVREE,

                // Livraison Data
                date_livraison_reelle: new Date().toISOString(),
                heure_livraison: nowStr,
                signature_livraison: nowStr,

                // Installation Data (Auto-Start)
                statut_installation: STATUS.INSTALLATION.EN_COURS,
                date_install_debut: new Date().toISOString(), // ISO pour parsing sûr côté bridge
                date_install_fin_reelle: estEndStr // Formaté pour affichage direct Sheet Col N
            }).eq('id', clientId);

            if (err) {
                console.error("❌ Erreur Supabase validation:", err);
                return res.status(500).json({ error: 'Supabase update failed' });
            }

            console.log(`✅ Livraison validée + Install Démarrée pour ${clientId}. Fin estimée: ${estEndStr}`);
            return res.json({ success: true, message: 'Livraison validée & Installation démarrée' });

        } else if (type === 'chantier') {
            // ✅ ONLY UPDATE SUPABASE
            const { error: err } = await supabase.from('clients').update({
                statut_client: STATUS.GLOBAL.TERMINE,
                statut_installation: STATUS.INSTALLATION.TERMINE,
                date_install_fin: nowStr
            }).eq('id', clientId);

            if (err) {
                console.error("❌ Erreur Supabase installation:", err);
                return res.status(500).json({ error: 'Supabase update failed' });
            }

            console.log(`✅ Installation terminée pour ${clientId} à ${nowStr}`);
            return res.json({ success: true, message: 'Installation terminée' });

        } else if (type === 'chantier-debut') {
            // 1. Fetch info client pour calcul
            const { data: clientData, error: fetchErr } = await supabase
                .from('clients')
                .select('nb_led')
                .eq('id', clientId)
                .single();

            if (fetchErr) console.warn("⚠️ Impossible de récupérer nb_led pour calcul date fin:", fetchErr.message);

            // 2. Calculer Date Fin Estimée (Démarrage Immédiat)
            const startDate = new Date();
            const estEnd = calculateEstimatedEnd(startDate, clientData?.nb_led || 0);
            const estEndStr = formatDateForSheet(estEnd); // Format compatible Sheet pour Col N

            // 3. UPDATE SUPABASE
            const { error: err } = await supabase.from('clients').update({
                statut_client: STATUS.GLOBAL.EN_COURS,
                statut_installation: STATUS.INSTALLATION.EN_COURS,
                date_install_debut: nowStr,
                date_install_fin_reelle: estEndStr // Fixation date fin estimée
            }).eq('id', clientId);

            if (err) {
                console.error("❌ Erreur Supabase début installation:", err);
                return res.status(500).json({ error: 'Supabase update failed' });
            }

            console.log(`✅ Début installation pour ${clientId} à ${nowStr}`);
            return res.json({ success: true, message: 'Début installation enregistré' });
        }

        // Unknown action type
        return res.status(400).json({ error: 'Type de validation inconnu' });


    } catch (e) {
        res.status(500).send(`<h1>Erreur : ${e.message}</h1>`);
    }
});

app.get('/api/status/google', (req, res) => {
    res.json({
        sheets: !!googleSheetsService,
        calendar: !!googleCalendarService,
        calendars: {
            livraisons: CALENDAR_ID_LIVRAISONS,
            installations: CALENDAR_ID_INSTALLATIONS
        }
    });
});

// Endpoint interne pour notifier des mises à jour (appelé par bridge.js)
app.post('/api/notify', async (req, res) => {
    const { type, data } = req.body;
    console.log(`🔔 Notification reçue de bridge.js: ${type}`);
    notifyUpdate(type || 'clients', data);
    res.json({ success: true });
});

// RESSOURCES (CHAUFFEURS) - MOCK TEMPORAIRE POUR TEST
app.get('/api/resources', (req, res) => {
    res.json([
        // -- LIVREURS (Pour ref future, PlanningModal utilise encore du hardcode mais bon d'avoir ici) --
        { id: 'camion-1', nom: 'Nicolas (Nord)', type: 'LIVREUR', capacite: 1000, secteur: 'IDF' },
        { id: 'camion-2', nom: 'David (Sud)', type: 'LIVREUR', capacite: 500, secteur: 'PACA' },
        { id: 'camion-3', nom: 'Livreur Corse', type: 'LIVREUR', capacite: 300, secteur: 'COR' },
        { id: 'camion-4', nom: 'Livreur Guadeloupe', type: 'LIVREUR', capacite: 300, secteur: 'GP' },
        { id: 'camion-5', nom: 'Livreur Martinique', type: 'LIVREUR', capacite: 300, secteur: 'MQ' },
        { id: 'camion-6', nom: 'Livreur Réunion', type: 'LIVREUR', capacite: 300, secteur: 'RE' },

        // -- POSEURS (Utilisé par InstallationModal) --
        { id: 'poseur-1', nom: 'Équipe Paris (IdF)', type: 'POSEUR', capacite: 50, secteur: 'IDF' },
        { id: 'poseur-2', nom: 'Équipe Lyon (Rhône)', type: 'POSEUR', capacite: 50, secteur: 'ARA' },
        { id: 'poseur-3', nom: 'Équipe Sud (PACA)', type: 'POSEUR', capacite: 50, secteur: 'PACA' },
        { id: 'poseur-4', nom: 'Installateur Corse', type: 'POSEUR', capacite: 40, secteur: 'COR' },
        { id: 'poseur-5', nom: 'Installateur Guadeloupe', type: 'POSEUR', capacite: 40, secteur: 'GP' },
        { id: 'poseur-6', nom: 'Installateur Martinique', type: 'POSEUR', capacite: 40, secteur: 'MQ' },
        { id: 'poseur-7', nom: 'Installateur Réunion', type: 'POSEUR', capacite: 40, secteur: 'RE' }
    ]);
});

// 1. GET ALL CLIENTS (FROM SUPABASE SOURCE OF TRUTH)
app.get('/api/clients', async (req, res) => {
    try {
        const { data: clients, error } = await supabase
            .from('clients')
            .select('*');

        if (error) throw error;

        // Map Supabase snake_case columns to Frontend snake_case/camelCase expectations
        const mappedClients = clients.map(c => ({
            id: c.id,
            nom: c.nom,
            prenom: c.prenom,
            adresse: c.adresse_brute,
            telephone: c.telephone,
            email: c.email,

            // KEY FIELDS
            statut_client: c.statut_client, // The one Frontend looks for now
            nb_led: c.nb_led,
            nombreLED: c.nb_led, // Alias for Frontend Interface compatibility
            rappel_info: c.rappel_info, // Expose recall timer info for Frontend

            // Logistics
            dateLivraison: c.date_livraison_prevue,
            date_livraison_reelle: c.date_livraison_reelle, // EXPOSED Real Delivery Date
            heureLivraison: c.heure_livraison, // Expose time explicitly
            signatureLivraison: c.signature_livraison, // Expose actual delivery timestamp
            statut: c.statut_client, // Keep this for legacy compatibility just in case
            logistique: c.statut_livraison, // Alias used in ClientsEnCoursView step 2 logic

            // Installation
            dateDebutTravaux: c.date_install_debut,
            dateFinTravaux: c.date_install_fin,
            date_install_fin_reelle: c.date_install_fin_reelle, // EXPOSED Real Installation End Date
            installStatut: c.statut_installation,

            // Location
            ville: extractCity(c.adresse_brute),
            codePostal: extractCP(c.adresse_brute),

            // GPS Coordinates
            gps: c.gps,
            lat: c.lat,
            lon: c.lon,
            latitude: c.latitude,
            longitude: c.longitude,

            // Champs bruts pour compatibilité
            livreur_id: c.livreur_id,
            camionId: c.livreur_id, // Alias pour compatibilité
            date_livraison_prevue: c.date_livraison_prevue,

            // Meta
            updated_at: c.updated_at
        }));

        res.json(mappedClients);
    } catch (error) {
        console.error("Erreur GET Clients (Supabase):", error.message);
        res.status(500).json({ error: "Erreur lecture base de données" });
    }
});

// 2. UPDATE CLIENT
app.put('/api/clients/:id', validate(updateClientSchema), async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    try {
        const { data, error } = await supabase
            .from('clients')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        console.log(`✅ Client ${id} mis à jour via API`);

        // --- HOOK QHARE (Sync Planification) ---
        // Si on a modifié une date de travaux ou de livraison, on considère que c'est planifié
        if (updates.date_install_debut || updates.date_livraison_prevue) {
            import('./sync_qhare.js').then(m => m.default(id, 'planification', data)).catch(err => console.error("Sync Error", err));
        }

        res.json(data);
    } catch (error) {
        console.error(`❌ Erreur mise à jour client ${id}:`, error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour du client' });
    }
});

function extractCity(addr) {
    if (!addr) return '';
    const match = addr.match(/(\d{5})\s+([^,]+)/);
    return match ? match[2].trim() : '';
}
function extractCP(addr) {
    if (!addr) return '';
    const match = addr.match(/(\d{5})/);
    return match ? match[1] : '';
}
// 1.5 GET STOCK LIST (Items Details)
app.get('/api/stock', async (req, res) => {
    if (googleSheetsService) {
        try {
            // Lecture B1 (Initial), D1 (Conso), F1 (Restant)
            const response = await googleSheetsService.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'devis!A1:F1',
            });
            const values = response.data.values?.[0] || [];

            const stockInitial = parseInt(values[1]?.replace(/\s/g, '')) || 0;
            const conso = parseInt(values[3]?.replace(/\s/g, '')) || 0;
            // Use calculated remaining to be safe
            const stockActuel = stockInitial - conso;

            const realStockItem = {
                id: 'sheet-stock-1',
                marque: 'LED Standard', // Generic name since we only have 1 model
                reference: 'V1.0',
                stockInitial: stockInitial,
                stockActuel: stockActuel,
                conso: conso,
                volumeCarton: 0.05,
                seuilAlerte: 25
            };

            return res.json([realStockItem]);
        } catch (e) {
            console.error("Error fetching stock list from sheet:", e);
        }
    }

    // Fallback Mock (updated to single item in mockData)
    res.json(mockStock);
});

// 1.8 UPDATE STOCK (ADD)
app.post('/api/stock/add', strictLimiter, validate(stockUpdateSchema), async (req, res) => {
    const { zone, quantite } = req.body;
    const qty = parseInt(quantite);

    if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: "Montant invalide" });
    }

    if (!googleSheetsService) {
        return res.status(503).json({ error: "Service Google indisponible" });
    }

    // MAP ZONE TO SHEET NAME
    // 'devis' seems to be the main sheet used for FR stock in existing code
    const ZONE_SHEETS = {
        'FR': 'fr metropole ',
        'GP': 'Guadeloupe',
        'MQ': 'Martinique',
        'CORSE': 'Corse',
        'RE': 'Reunion',
        'YT': 'Mayotte',
        'GF': 'Guyane'
    };

    const sheetName = ZONE_SHEETS[zone] || 'fr metropole ';

    try {
        // 1. Get current stock (B1)
        const range = `'${sheetName}'!B1`;
        const response = await googleSheetsService.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
        });

        const currentValRaw = response.data.values?.[0]?.[0];
        const currentStock = parseInt(String(currentValRaw || '0').replace(/\s/g, '')) || 0;
        const newStock = currentStock + qty;

        // 2. Update stock (B1)
        await googleSheetsService.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[newStock]] }
        });

        console.log(`✅ Stock updated for ${zone} (${sheetName}): ${currentStock} -> ${newStock} (+${qty})`);
        res.json({ success: true, newStock, zone });

    } catch (error) {
        console.error(`🔴 Error updating stock for ${zone} (Sheet: '${sheetName}'):`, error);
        res.status(500).json({ error: "Erreur mise à jour Google Sheets" });
    }
});

// 2. STOCK GLOBAL (Lit B1, D1, F1 + Force les formules)
app.get('/api/stock/global', validate(stockQuerySchema, 'query'), async (req, res) => {
    const nowStr = new Date().toLocaleString('fr-FR');
    const { zone } = req.query; // Support ?zone=GP

    const ZONE_SHEETS = {
        'FR': 'fr metropole ',
        'GP': 'Guadeloupe',
        'MQ': 'Martinique',
        'CORSE': 'Corse',
        'RE': 'Reunion',
        'YT': 'Mayotte',
        'GF': 'Guyane'
    };

    const sheetName = ZONE_SHEETS[zone] || 'fr metropole ';

    if (googleSheetsService) {
        try {
            // Étape 1 : On s'assure que les formules sont présentes dans le fichier
            // B1 est le total (chiffre), D1 est la somme de C4:C, F1 est le reste B1-D1
            // Use dynamic sheet name for range
            try {
                await batchUpdate([
                    { range: `'${sheetName}'!D1`, values: [['=SUMIF(G4:G; "*2.*"; F4:F) + SUMIF(G4:G; "*3.*"; F4:F) + SUMIF(G4:G; "*4.*"; F4:F) + SUMIF(G4:G; "*5.*"; F4:F) + SUMIF(G4:G; "*6.*"; F4:F)']] },
                    { range: `'${sheetName}'!F1`, values: [['=B1-D1']] }
                ]);
            } catch (formErr) {
                console.warn("Formula update warning:", formErr.message);
            }

            // Étape 2 : On lit les valeurs calculées par Google
            const response = await googleSheetsService.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `'${sheetName}'!A1:F1`,
            });
            const values = response.data.values?.[0] || [];

            // Nettoyage des espaces pour les grands nombres (ex: "5 500" -> 5500)
            const cleanInt = (val) => parseInt(String(val || '0').replace(/\s/g, '')) || 0;

            const stockTotal = cleanInt(values[1]); // B1
            const consommees = cleanInt(values[3]); // D1 (Calculé par la formule SUM)
            const restantes = cleanInt(values[5]);  // F1 (Calculé par B1-D1)

            const ratio = stockTotal > 0 ? (restantes / stockTotal) : 0;

            return res.json({
                total: stockTotal,
                consommees: consommees,
                restantes: restantes,
                pourcentage: Math.round(ratio * 100),
                critique: ratio < 0.25,
                lastUpdated: nowStr,
                zone: zone || 'FR'
            });
        } catch (e) {
            console.error(`Erreur Stock Global (${sheetName}):`, e.message);
        }
    }

    // Fallback Mock
    let mockTotal = 50000;
    if (zone === 'GP' || zone === 'MQ') mockTotal = 5000;
    if (zone === 'CORSE') mockTotal = 2000;

    res.json({
        total: mockTotal,
        consommees: Math.round(mockTotal * 0.1),
        restantes: Math.round(mockTotal * 0.9),
        pourcentage: 90,
        critique: false,
        lastUpdated: nowStr,
        zone: zone || 'FR'
    });
});
// 3. PLANIFICATION LIVRAISON
// 3. PLANIFICATION LIVRAISON
app.post('/api/livraisons/planifier', mutationLimiter, async (req, res) => {
    const { clientId, date, camionId } = req.body;

    // Support both old 'sheet-' IDs and new 'TAB_ROW' IDs
    if (!googleSheetsService || (!clientId.startsWith('sheet-') && !clientId.includes('_')))
        return res.json({ success: true, mock: true });

    try {
        let index;
        let tabName = 'devis';

        if (clientId.startsWith('sheet-')) {
            index = parseInt(clientId.split('-')[1]) + 4;
        } else {
            const lastUnderscore = clientId.lastIndexOf('_');
            // Convert underscores back to spaces for Google Sheets tab names
            tabName = clientId.substring(0, lastUnderscore).replace(/_/g, ' ');
            index = parseInt(clientId.substring(lastUnderscore + 1));
        }

        const rowIndex = index;
        const finalDate = new Date(date);

        // Utiliser Heure de Paris pour l'affichage Sheet/Supabase
        const formatter = new Intl.DateTimeFormat('fr-FR', {
            timeZone: 'Europe/Paris',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });

        const parts = formatter.formatToParts(finalDate);
        const get = (type) => parts.find(p => p.type === type)?.value;

        const dayStr = `${get('day')}/${get('month')}/${get('year')}`;
        const timeStr = `${get('hour')}:${get('minute')}`;
        const dateTimeStr = `${dayStr} ${timeStr}`;

        // 1. Mise à jour Google Sheets
        const rangePrefix = `'${tabName}'!`;
        const updates = [
            // Mettre le statut à EN COURS dès la planification (Col G)
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${rowIndex}`, values: [['EN COURS']] },
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_DATE)}${rowIndex}`, values: [[dayStr]] },
            // Correction USER: Ne rien mettre dans l'heure (Col J) à la planification. C'est l'heure de validation uniquement.
            // Update: On vide aussi la colonne I (Signature) pour éviter confusion si re-planification.
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_TIME)}${rowIndex}`, values: [['']] },
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_SIGNATURE)}${rowIndex}`, values: [['']] },
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_CAMION_ID)}${rowIndex}`, values: [[camionId || '1']] },
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INFO_DIVERS)}${rowIndex}`, values: [['']] }
        ];

        await batchUpdate(updates);

        // 2. Vercel URL Generation & Links
        const APP_URL = process.env.VITE_PUBLIC_APP_URL || 'https://arkos-app.vercel.app';
        const validationLink = `${APP_URL}/validate?id=${clientId}&action=livraison`;
        await batchUpdate([{ range: `${rangePrefix}P${rowIndex}`, values: [[validationLink]] }]);

        // 3. Création de l'événement Google Calendar
        if (googleCalendarService) {
            try {
                const clientRow = await googleSheetsService.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${rangePrefix}A${rowIndex}:F${rowIndex}`
                });

                if (clientRow.data.values && clientRow.data.values.length > 0) {
                    const rowData = clientRow.data.values[0];
                    const nom = rowData[0] || '';
                    const prenom = rowData[1] || '';
                    const adresse = rowData[2] || '';
                    const nbLed = rowData[SHEET_SCHEMA.COL_NB_LED] || 0;

                    const start = new Date(date);
                    const end = new Date(start.getTime() + 30 * 60000);

                    await createCalendarEvent(CALENDAR_ID_LIVRAISONS, {
                        summary: `🚚 Livraison : ${prenom} ${nom} (${nbLed} LEDs)`,
                        location: adresse,
                        description: `Livraison prévue avec le camion : ${camionId || 'Non spécifié'}\n\n👇 LIEN DE VALIDATION CHAUFFEUR :\n${validationLink}`,
                        start: { dateTime: start.toISOString(), timeZone: 'Europe/Paris' },
                        end: { dateTime: end.toISOString(), timeZone: 'Europe/Paris' },
                    });
                }
            } catch (calErr) {
                console.error("⚠️ Erreur création event livraison calendar:", calErr.message);
            }
        }

        // 4. Mise à jour Supabase (Source de Vérité immédiate)
        try {
            await supabase
                .from('clients')
                .update({
                    // Passer le statut à EN COURS dès qu'une livraison est planifiée
                    statut_client: 'EN COURS',
                    date_livraison_prevue: dayStr,
                    // heure_livraison: timeStr, // SUPPRIMÉ: On ne stocke plus l'heure prévue ici, pour éviter confusion avec heure réelle
                    heure_livraison: null, // On reset l'heure de livraison si on replanifie
                    statut_livraison: STATUS.LIVRAISON.PLANIFIEE,
                    livreur_id: camionId || '1'
                })
                .eq('id', clientId);
            console.log(`✅ Supabase mis à jour pour client ${clientId} -> Statut: EN COURS`);
        } catch (supaErr) {
            console.error("⚠️ Erreur mise à jour Supabase (planification):", supaErr.message);
        }

        notifyUpdate('stock');
        notifyUpdate('clients');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3b. BULK PLANIFICATION LIVRAISON (For FleetMonitor/Calendar)
app.post('/api/livraisons/bulk-planifier', mutationLimiter, async (req, res) => {
    const { clientIds, date, camionId } = req.body;

    if (!clientIds || !Array.isArray(clientIds)) {
        return res.status(400).json({ error: "No clientIds provided" });
    }

    try {
        let successCount = 0;
        const failedIds = [];

        // Helper for formatting
        const finalDate = new Date(date);
        const formatter = new Intl.DateTimeFormat('fr-FR', {
            timeZone: 'Europe/Paris',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
        const parts = formatter.formatToParts(finalDate);
        const get = (type) => parts.find(p => p.type === type)?.value;
        const dayStr = `${get('day')}/${get('month')}/${get('year')}`;

        // We process sequentially to avoid rate limits on Sheets/Calendar APIs
        // or concurrent write issues
        for (const clientId of clientIds) {
            try {
                // 1. Resolve ID for Sheets
                let index;
                let tabName = 'devis';
                let isSheet = false;

                if (clientId.startsWith('sheet-')) {
                    index = parseInt(clientId.split('-')[1]) + 4;
                    isSheet = true;
                } else if (clientId.includes('_')) {
                    const lastUnderscore = clientId.lastIndexOf('_');
                    if (lastUnderscore !== -1) {
                        tabName = clientId.substring(0, lastUnderscore).replace(/_/g, ' ');
                        index = parseInt(clientId.substring(lastUnderscore + 1));
                        isSheet = true;
                    }
                }

                if (googleSheetsService && isSheet && index) {
                    const rowIndex = index;
                    const rangePrefix = `'${tabName}'!`;

                    // 2. Vercel URL Generation & Links
                    // Use configured APP URL or default to localhost for dev (User should configure this!)
                    const APP_URL = process.env.VITE_PUBLIC_APP_URL || 'https://arkos-app.vercel.app';
                    const validationLink = `${APP_URL}/validate?id=${clientId}&action=livraison`;

                    // 3. Sheets Update
                    const updates = [
                        { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${rowIndex}`, values: [['EN COURS']] },
                        { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_DATE)}${rowIndex}`, values: [[dayStr]] },
                        { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_TIME)}${rowIndex}`, values: [['']] }, // Clear J
                        { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_SIGNATURE)}${rowIndex}`, values: [['']] }, // Clear I (New Validation Col)
                        { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_CAMION_ID)}${rowIndex}`, values: [[camionId || '1']] },
                        { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_STATUT)}${rowIndex}`, values: [['PLANIFIÉE']] },
                        { range: `${rangePrefix}P${rowIndex}`, values: [[validationLink]] } // Save Link to Col P
                    ];
                    await batchUpdate(updates);

                    // 4. Calendar Event
                    if (googleCalendarService) {
                        const clientRow = await googleSheetsService.spreadsheets.values.get({
                            spreadsheetId: SPREADSHEET_ID,
                            range: `${rangePrefix}A${rowIndex}:F${rowIndex}`
                        });

                        if (clientRow.data.values && clientRow.data.values.length > 0) {
                            const rowData = clientRow.data.values[0];
                            const nom = rowData[0] || '';
                            const prenom = rowData[1] || '';
                            const adresse = rowData[2] || '';
                            const nbLed = rowData[SHEET_SCHEMA.COL_NB_LED] || 0;

                            const start = new Date(date);
                            start.setHours(8, 0, 0);
                            const end = new Date(start);
                            end.setHours(18, 0, 0);

                            await createCalendarEvent(CALENDAR_ID_LIVRAISONS, {
                                summary: `🚚 Livraison : ${prenom} ${nom} (${nbLed} LEDs)`,
                                location: adresse,
                                description: `🚛 Chauffeur : ${camionId === '1' ? 'Nicolas' : camionId === '2' ? 'David' : 'Autre'}\n\n👇 LIEN DE VALIDATION CHAUFFEUR :\n${validationLink}\n\n📲 ACCÉDER À MON ESPACE LIVREUR :\n${APP_URL}/driver/${camionId}\n\n(Lien unique pour gérer toutes vos livraisons du jour)`,
                                start: { dateTime: start.toISOString(), timeZone: 'Europe/Paris' },
                                end: { dateTime: end.toISOString(), timeZone: 'Europe/Paris' },
                            });
                        }
                    }
                }

                // 4. Supabase Update (Always runs, simpler and reliable)
                await supabase
                    .from('clients')
                    .update({
                        statut_client: 'EN COURS',
                        date_livraison_prevue: dayStr,
                        statut_livraison: 'PLANIFIÉ',
                        livreur_id: camionId || '1'
                    })
                    .eq('id', clientId);

                successCount++;

            } catch (err) {
                console.error(`Error processing bulk item ${clientId}:`, err);
                failedIds.push(clientId);
            }
        }

        notifyUpdate('clients');
        res.json({ success: true, count: successCount, failed: failedIds });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. STATUT LIVRAISON
app.post('/api/livraisons/status', mutationLimiter, async (req, res) => {
    const { clientId, statut } = req.body;
    if (!googleSheetsService || (!clientId?.startsWith('sheet-') && !clientId?.includes('_'))) return res.json({ success: true, mock: true });

    try {
        let index;
        let tabName = 'devis';

        if (clientId.startsWith('sheet-')) {
            index = parseInt(clientId.split('-')[1]) + 4;
        } else {
            const lastUnderscore = clientId.lastIndexOf('_');
            tabName = clientId.substring(0, lastUnderscore).replace(/_/g, ' ');
            index = parseInt(clientId.substring(lastUnderscore + 1));
        }

        const rangePrefix = `'${tabName}'!`;
        const nowStr = formatDateForSheet(new Date());
        const updates = [
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${index}`, values: [[statut]] }
        ];

        // Si livré, remplir aussi la colonne I (Signature)
        if (statut === STATUS.LIVRAISON.LIVREE) {
            updates.push({
                range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_LIVRAISON_SIGNATURE)}${index}`,
                values: [[nowStr]]
            });
        }

        await batchUpdate(updates);

        // Sync Supabase
        // Sync Supabase - Generic Update to support Installation fields too
        // We filter out clientId and 'statut' which is used above, but include everything else
        const { clientId: _, statut: __, ...otherFields } = req.body;

        const updatePayload = {
            statut_client: statut,
            // Only update delivery status if it IS a delivery update
            ...(statut === 'LIVRÉE' || statut === 'PLANIFIÉE' ? {
                statut_livraison: statut,
                heure_livraison: statut === STATUS.LIVRAISON.LIVREE ? nowStr : undefined,
                logistique: statut === STATUS.LIVRAISON.LIVREE ? STATUS.LIVRAISON.LIVREE : undefined
            } : {}),
            ...otherFields // Spread dates and installation status
        };

        await supabase.from('clients').update({
            ...updatePayload,
            updated_at: new Date().toISOString()
        }).eq('id', clientId);

        notifyUpdate('clients');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper for Deterministic IDs (prevents duplicates and collisions)
function getSafeCalendarId(clientId) {
    // Google Calendar IDs only allow a-v and 0-9.
    // Hex encoding (0-9, a-f) is safe and deterministic.
    const hex = Buffer.from(clientId.toString()).toString('hex');
    return 'led' + hex;
}

// 4. PLANNING (Full)
app.post('/api/planning/confirm', mutationLimiter, async (req, res) => {
    console.log("⚡ [API] /api/planning/confirm HIT", req.body);
    const { clientId, date, camionId, clientName, address, nbLed } = req.body;
    const safeNotify = (typeof notifyUpdate === 'function') ? notifyUpdate : () => { };

    try {
        console.log(`📅 [Planning] Planification demandée pour ${clientId} à la date ${date}`);

        // 0. VÉRIFICATION DE CONFLIT : Le chauffeur est-il déjà occupé ce jour-là ?
        // Récupérer tous les clients du même chauffeur avec des installations planifiées
        const { data: existingClients, error: fetchError } = await supabase
            .from('clients')
            .select('id, nom, date_install_debut, date_install_fin_reelle, nb_led, statut_installation')
            .eq('livreur_id', camionId)
            .in('statut_installation', ['PLANIFIÉE', 'EN_COURS']);

        if (fetchError) {
            console.error(`❌ [Planning] Erreur lors de la vérification des conflits:`, fetchError);
        } else if (existingClients && existingClients.length > 0) {
            // Vérifier si la date demandée chevauche une installation existante
            const requestedDate = new Date(date);
            requestedDate.setHours(0, 0, 0, 0); // Normaliser à minuit

            for (const client of existingClients) {
                if (!client.date_install_debut) continue;

                const installStart = new Date(client.date_install_debut);
                installStart.setHours(0, 0, 0, 0);

                // Calculer la date de fin estimée si elle existe
                let installEnd = null;
                if (client.date_install_fin_reelle) {
                    installEnd = new Date(client.date_install_fin_reelle);
                    installEnd.setHours(23, 59, 59, 999); // Fin de journée
                } else if (client.nb_led) {
                    // Calculer la fin estimée basée sur le nombre de LEDs
                    const estimatedEnd = calculateEstimatedEnd(installStart, client.nb_led);
                    installEnd = new Date(estimatedEnd);
                    installEnd.setHours(23, 59, 59, 999);
                }

                // Vérifier si la date demandée tombe pendant l'installation
                if (installEnd) {
                    if (requestedDate >= installStart && requestedDate <= installEnd) {
                        console.warn(`⚠️ [Planning] CONFLIT DÉTECTÉ: Le chauffeur ${camionId} a déjà une installation en cours pour "${client.nom}" du ${installStart.toLocaleDateString('fr-FR')} au ${installEnd.toLocaleDateString('fr-FR')}`);
                        return res.status(409).json({
                            error: 'CONFLIT_PLANNING',
                            message: `Le chauffeur est déjà occupé ce jour-là avec l'installation de "${client.nom}" (${client.nb_led} LEDs). Fin estimée: ${installEnd.toLocaleDateString('fr-FR')} à ${installEnd.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`,
                            conflictingClient: {
                                nom: client.nom,
                                dateDebut: installStart.toISOString(),
                                dateFin: installEnd.toISOString(),
                                nbLed: client.nb_led
                            }
                        });
                    }
                }
            }
        }

        // 1. Supabase Update (si pas de conflit)
        const { error } = await supabase
            .from('clients')
            .update({
                date_livraison_prevue: date,
                statut_livraison: 'PLANIFIÉE',
                statut_client: '🚚 2. Livraison confirmée',
                livreur_id: camionId,
                updated_at: new Date().toISOString()
            })
            .eq('id', clientId);

        if (error) {
            console.error(`❌ [Planning] Supabase Update Error:`, error);
            throw error;
        }
        console.log(`✅ [Planning] Supabase Updated for ${clientId}`);

        // 2. Google Calendar (Upsert)
        if (googleCalendarService) {
            try {
                // Fetch fresh client data for the event details
                const { data: clientData, error: clientFetchError } = await supabase
                    .from('clients')
                    .select('nom, prenom, adresse, code_postal, ville, nb_led')
                    .eq('id', clientId)
                    .single();

                if (clientFetchError || !clientData) {
                    console.error("❌ Failed to fetch client data for calendar:", clientFetchError);
                }

                // Use fetched data, fallback to body data, fallback to defaults
                const finalName = clientData ? `${clientData.prenom || ''} ${clientData.nom || ''}`.trim() : (clientName || "Client");
                const finalAddress = clientData ? `${clientData.adresse || ''} ${clientData.code_postal || ''} ${clientData.ville || ''}`.trim() : (address || "");
                const finalNbLed = clientData && clientData.nb_led ? parseFloat(clientData.nb_led) : (parseFloat(nbLed) || 0);

                console.log(`🔍 [Planning Debug] ID: ${clientId}, Nom: ${finalName}, LEDs Supabase: ${clientData?.nb_led}, LEDs Body: ${nbLed}, Final: ${finalNbLed}`);

                const eventId = getSafeCalendarId(clientId);


                const startDate = new Date(date); // Date with 00:00
                const calculatedEnd = calculateEstimatedEnd(startDate, finalNbLed);

                console.log(`🧮 [Planning Debug] Start: ${startDate.toISOString()}, End: ${calculatedEnd.toISOString()}`);

                // Google Calendar All-Day Events: End date is EXCLUSIVE (midnight of next day)
                // If work ends on Jan 20, we want the event to cover Jan 20 provided it ends after 8am?
                // Actually usually "Chantier" = All Day.
                // So if calculatedEnd is Jan 20, we want End = Jan 21 for GCal.

                const gCalStart = new Date(startDate);
                const gCalEnd = new Date(calculatedEnd);
                gCalEnd.setDate(gCalEnd.getDate() + 1); // Add 1 day for Exclusive End

                // Format YYYY-MM-DD
                const toYMD = (d) => d.toISOString().split('T')[0];

                const shortStart = gCalStart.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
                const shortEnd = calculatedEnd.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }); // Use real end for display text

                const eventBody = {
                    summary: `🚚 ${finalNbLed} LED - ${finalName} (${shortStart} ➔ ${shortEnd})`,
                    description: `📅 Du: ${shortStart} Au: ${shortEnd}\nClient: ${finalName}\nAdresse: ${finalAddress}\nNb LEDs: ${finalNbLed}\nCamion: ${camionId}\n\nLien Validation: https://arkos-app.vercel.app/validate?id=${clientId}`,
                    location: finalAddress,
                    start: { date: toYMD(gCalStart) }, // ALL DAY EVENT
                    end: { date: toYMD(gCalEnd) },     // ALL DAY EVENT
                    id: eventId
                };

                // Try INSERT first
                try {
                    await googleCalendarService.events.insert({
                        calendarId: CALENDAR_ID_LIVRAISONS,
                        requestBody: eventBody
                    });
                    console.log(`✅ Event Created: ${eventId}`);
                } catch (insertErr) {
                    // If conflict (409), UPDATE instead
                    if (insertErr.code === 409 || (insertErr.response && insertErr.response.status === 409)) {
                        console.log(`♻️ Event exists (409). Updating ${eventId}...`);
                        await googleCalendarService.events.update({
                            calendarId: CALENDAR_ID_LIVRAISONS,
                            eventId: eventId,
                            requestBody: eventBody
                        });
                    } else {
                        throw insertErr;
                    }
                }
            } catch (calErr) {
                console.error("Calendar Sync Error:", calErr.message);
            }
        }

        safeNotify('clients');
        res.json({ success: true });
    } catch (e) {
        console.error("Planning Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// NEW: Update Full Tour (Sync Calendar & Heure Livraison)
app.post('/api/tour/update', mutationLimiter, async (req, res) => {
    const { clients, date } = req.body;
    if (!clients || !date) return res.status(400).json({ error: "Missing data" });

    let updatedCount = 0;
    try {
        for (const c of clients) {
            if (!c.time) continue;
            const timeParts = c.time.split(':');
            if (timeParts.length !== 2) continue;

            // 1. Update Supabase Heure
            await supabase
                .from('clients')
                .update({ heure_livraison: c.time })
                .eq('id', c.id);

            // 2. Sync Calendar (Deterministic ID)
            if (googleCalendarService) {
                try {
                    const eventId = getSafeCalendarId(c.id);

                    const newStart = parseInt(timeParts[0]).toString().padStart(2, '0') + ':' + parseInt(timeParts[1]).toString().padStart(2, '0') + ':00';
                    const startDateTime = `${date}T${newStart}`;

                    // Calcul End time (+45m)
                    const startDateObj = new Date(`${date}T${newStart}`);
                    const endDateObj = new Date(startDateObj.getTime() + 45 * 60000);

                    const endDateTime = endDateObj.getFullYear() + '-' +
                        (endDateObj.getMonth() + 1).toString().padStart(2, '0') + '-' +
                        endDateObj.getDate().toString().padStart(2, '0') + 'T' +
                        endDateObj.getHours().toString().padStart(2, '0') + ':' +
                        endDateObj.getMinutes().toString().padStart(2, '0') + ':' +
                        endDateObj.getSeconds().toString().padStart(2, '0');

                    // Try Update directly
                    try {
                        const currentEvent = await googleCalendarService.events.get({
                            calendarId: CALENDAR_ID_LIVRAISONS,
                            eventId: eventId
                        });

                        await googleCalendarService.events.update({
                            calendarId: CALENDAR_ID_LIVRAISONS,
                            eventId: eventId,
                            requestBody: {
                                ...currentEvent.data,
                                status: 'confirmed',
                                location: c.adresse || '',
                                start: { date: date },
                                end: { date: date }
                            }
                        });
                        updatedCount++;
                    } catch (err) {
                        if (err.code === 404) {
                            console.warn(`Event ${eventId} not found. Checking legacy or creating new...`);

                            // 1. Fallback: Search legacy
                            let legacyFound = false;
                            try {
                                const startOfDay = new Date(date); startOfDay.setHours(0, 0, 0, 0);
                                const endOfDay = new Date(date); endOfDay.setHours(23, 59, 59, 999);
                                const events = await googleCalendarService.events.list({
                                    calendarId: CALENDAR_ID_LIVRAISONS,
                                    timeMin: startOfDay.toISOString(),
                                    timeMax: endOfDay.toISOString(),
                                    q: c.nom,
                                    singleEvents: true
                                });
                                const fuzzyEvent = events.data.items?.find(e => e.summary && e.summary.includes(c.nom));

                                if (fuzzyEvent) {
                                    console.log(`♻️ Found legacy event for ${c.nom}, updating...`);
                                    await googleCalendarService.events.update({
                                        calendarId: CALENDAR_ID_LIVRAISONS,
                                        eventId: fuzzyEvent.id,
                                        requestBody: {
                                            ...fuzzyEvent,
                                            location: c.adresse || '',
                                            start: { date: date },
                                            end: { date: date }
                                        }
                                    });
                                    updatedCount++;
                                    legacyFound = true;
                                }
                            } catch (fuzzyErr) { console.error("Fuzzy err", fuzzyErr.message); }

                            // 2. If Not Found -> INSERT NEW
                            if (!legacyFound) {
                                console.log(`🆕 Creating NEW event for ${c.nom} (Deterministic ID: ${eventId})`);
                                const appUrl = process.env.VITE_PUBLIC_APP_URL || 'https://arkos-app.vercel.app';
                                const link = `${appUrl}/validate?id=${c.id}&action=livraison`;

                                try {
                                    await googleCalendarService.events.insert({
                                        calendarId: CALENDAR_ID_LIVRAISONS,
                                        requestBody: {
                                            id: eventId, // Force deterministic ID
                                            summary: `🚚 Livraison : ${c.nom}`,
                                            location: c.adresse || '',
                                            description: `Client: ${c.nom}\nID: ${c.id}\nValider: ${link}`,
                                            start: { date: date },
                                            end: { date: date }
                                        }
                                    });
                                    updatedCount++;
                                } catch (createErr) {
                                    console.error(`❌ Failed to create event for ${c.nom}`, createErr.message);
                                }
                            }
                        }
                    }
                } catch (calErr) {
                    console.error("Calendar update error", calErr.message);
                }
            }
        }
        res.json({ success: true, updated: updatedCount });
    } catch (e) {
        console.error("Tour Update Error:", e);
        res.status(500).json({ error: e.message });
    }
});


// 5. INSTALLATION CREATION
app.post('/api/installations/creer', mutationLimiter, async (req, res) => {
    const { clientId, dateDebut, poseurId } = req.body;

    // Support both ID formats
    if (!googleSheetsService || (!clientId.startsWith('sheet-') && !clientId.includes('_')))
        return res.json({ success: true });

    try {
        let index;
        let tabName = 'devis';

        if (clientId.startsWith('sheet-')) {
            index = parseInt(clientId.split('-')[1]) + 4;
        } else {
            const lastUnderscore = clientId.lastIndexOf('_');
            tabName = clientId.substring(0, lastUnderscore).replace(/_/g, ' ');
            index = parseInt(clientId.substring(lastUnderscore + 1));
        }

        const rowIndex = index;
        const rangePrefix = `'${tabName}'!`;

        // 0. Récupération infos
        const clientRow = await googleSheetsService.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${rangePrefix}A${rowIndex}:F${rowIndex}`
        });

        const rowData = clientRow.data.values?.[0] || [];
        const nom = rowData[SHEET_SCHEMA.COL_NOM] || '';
        const prenom = rowData[SHEET_SCHEMA.COL_PRENOM] || '';
        const nbLed = parseInt(rowData[SHEET_SCHEMA.COL_NB_LED]) || 0;
        const adresse = rowData[SHEET_SCHEMA.COL_ADRESSE] || '';

        // Calcul durée estimée (60 LED/jour, 9h-18h)
        const dateDebutStr = formatDateForSheet(dateDebut);
        const dDebut = new Date(dateDebut);
        const dFin = calculateEstimatedEnd(dDebut, nbLed);
        const dateFinStr = formatDateForSheet(dFin);

        // 1. Mise à jour Google Sheets
        const updates = [
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_DEBUT)}${rowIndex}`, values: [[dateDebutStr]] },
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_FIN)}${rowIndex}`, values: [[dateFinStr]] },
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE)}${rowIndex}`, values: [[dateFinStr]] }, // Pré-remplir N
            // NE PAS changer le statut global ici - il ne doit changer que quand l'installation démarre
            { range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_POSEUR_ID)}${rowIndex}`, values: [[poseurId || '']] }
        ];

        await batchUpdate(updates);

        // 1b. Lien Vercel
        const APP_URL = process.env.VITE_PUBLIC_APP_URL || 'https://arkos-app.vercel.app';
        const validationLink = `${APP_URL}/validate?id=${clientId}&action=installation`;
        await batchUpdate([{ range: `${rangePrefix}P${rowIndex}`, values: [[validationLink]] }]);

        // 2. Création de l'événement Google Calendar
        if (googleCalendarService) {
            try {
                const start = new Date(dateDebut);
                const end = new Date(dFin);

                await createCalendarEvent(CALENDAR_ID_INSTALLATIONS, {
                    summary: `🛠️ Chantier LED (${nbLed} LEDs) : ${prenom} ${nom}`,
                    location: adresse,
                    description: `Installation de ${nbLed} LEDs par l'équipe : ${poseurId || 'Non spécifiée'}\nDurée estimée : ${dureeJours} jour(s)\n\n👇 LIEN DE VALIDATION INSTALLATEUR :\n${validationLink}`,
                    start: { dateTime: start.toISOString(), timeZone: 'Europe/Paris' },
                    end: { dateTime: end.toISOString(), timeZone: 'Europe/Paris' },
                });
            } catch (calErr) {
                console.error("⚠️ Erreur création event installation calendar:", calErr.message);
            }
        }

        // 3. Mise à jour Supabase
        try {
            await supabase
                .from('clients')
                .update({
                    // NE PAS changer statut_client ici - il ne doit changer que quand l'installation démarre
                    statut_installation: STATUS.INSTALLATION.PLANIFIEE,
                    date_install_debut: dateDebutStr,
                    date_install_fin: dateFinStr,
                    poseur_id: poseurId || '',
                    updated_at: new Date().toISOString()
                })
                .eq('id', clientId);
        } catch (supaErr) {
            console.error("⚠️ Supabase error (install plan):", supaErr.message);
        }

        notifyUpdate('clients');
        res.json({ success: true });
    } catch (e) {
        console.error("Erreur Planification Installation:", e);
        res.status(500).json({ error: e.message });
    }
});

// 6. INSTALLATION STATUT (Mise à jour stock si Terminé)
app.post('/api/installations/status', mutationLimiter, async (req, res) => {
    const { clientId, statut } = req.body;
    if (!googleSheetsService || (!clientId?.startsWith('sheet-') && !clientId?.includes('_'))) return res.json({ success: true, mock: true });

    try {
        let index;
        let tabName = 'devis';

        if (clientId.startsWith('sheet-')) {
            index = parseInt(clientId.split('-')[1]) + 4;
        } else {
            const lastUnderscore = clientId.lastIndexOf('_');
            tabName = clientId.substring(0, lastUnderscore).replace(/_/g, ' ');
            index = parseInt(clientId.substring(lastUnderscore + 1));
        }

        const rowIndex = index;
        const rangePrefix = `'${tabName}'!`;
        const updates = [];

        if (statut === 'TERMINÉE' || statut === 'TERMINÉ') {
            const nowStr = formatDateForSheet(new Date());
            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${rowIndex}`, values: [[STATUS.GLOBAL.TERMINE]] });
            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_FIN)}${rowIndex}`, values: [[nowStr]] });
            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE)}${rowIndex}`, values: [[nowStr]] });

            // Sync Supabase
            await supabase.from('clients').update({
                statut_client: STATUS.GLOBAL.TERMINE,
                statut_installation: STATUS.INSTALLATION.TERMINE,
                date_install_fin: nowStr,
                date_install_fin_reelle: nowStr,
                updated_at: new Date().toISOString()
            }).eq('id', clientId);
        } else if (statut === 'EN_COURS' || statut === 'EN COURS') {
            const now = new Date();
            const nowStr = formatDateForSheet(now);

            // Récupérer nbLed pour calcul fin estimée
            const { data: client } = await supabase.from('clients').select('nb_led').eq('id', clientId).single();
            const nbLed = client?.nb_led || 0;
            const estimatedEnd = calculateEstimatedEnd(now, nbLed);
            const estimatedEndStr = formatDateForSheet(estimatedEnd);

            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${rowIndex}`, values: [[STATUS.GLOBAL.EN_COURS]] });
            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_DEBUT)}${rowIndex}`, values: [[nowStr]] });
            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_INSTALL_DATE_FIN_REELLE)}${rowIndex}`, values: [[estimatedEndStr]] });

            // Sync Supabase
            await supabase.from('clients').update({
                statut_client: STATUS.GLOBAL.EN_COURS,
                statut_installation: STATUS.INSTALLATION.EN_COURS,
                date_install_debut: nowStr,
                date_install_fin_reelle: estimatedEndStr,
                updated_at: new Date().toISOString()
            }).eq('id', clientId);
        } else {
            // Generic
            updates.push({ range: `${rangePrefix}${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${rowIndex}`, values: [[statut]] });
            await supabase.from('clients').update({ statut_client: statut }).eq('id', clientId);
        }

        await batchUpdate(updates);
        notifyUpdate('clients');
        notifyUpdate('stock'); // Car l'install impacte D1/F1
        res.json({ success: true });
    } catch (e) {
        console.error("Erreur Install Status:", e);
        res.status(500).json({ error: e.message });
    }
});

// 8. UPDATE CLIENT STATUS (Compatibilité ClientsView)
// 7. GEOCODING API (Proxy to LocationIQ)
app.get('/api/geocode', geoLimiter, async (req, res) => {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: "Address is required" });

    const LOCATIONIQ_TOKEN = process.env.LOCATIONIQ_TOKEN || process.env.LOCATIONIQ_API_KEY;
    if (!LOCATIONIQ_TOKEN) {
        console.warn("⚠️ LOCATIONIQ_TOKEN not found in env");
        // Fallback dev mode mock if no key
        return res.json({ lat: 48.8566, lon: 2.3522, display_name: "Paris (Mock)" });
    }

    try {
        const url = `https://us1.locationiq.com/v1/search.php?key=${LOCATIONIQ_TOKEN}&q=${encodeURIComponent(address)}&format=json&limit=1`;
        const response = await fetch(url);

        if (!response.ok) throw new Error(`LocationIQ error: ${response.statusText}`);

        const data = await response.json();
        if (data && data.length > 0) {
            res.json({
                lat: parseFloat(data[0].lat),
                lon: parseFloat(data[0].lon),
                display_name: data[0].display_name
            });
        } else {
            res.status(404).json({ error: "Address not found" });
        }
    } catch (e) {
        console.error("Geocoding Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 8. UPDATE CLIENT STATUS (Gestion Rappel & Statut)
app.post('/api/clients/status', mutationLimiter, async (req, res) => {
    const { clientId, statut, customInfo } = req.body;

    // CAS SPÉCIAL: RAPPEL (Stockage Supabase UNIQUEMENT)
    if (statut === 'A_RAPPELER') {
        try {
            // 26h Timer Logic
            const now = new Date();
            const nextRecall = new Date(now.getTime() + 26 * 60 * 60 * 1000); // +26h

            // Fetch current attempt count
            const { data: current } = await supabase.from('clients').select('rappel_info').eq('id', clientId).single();
            const attempts = (current?.rappel_info?.attempt_count || 0) + 1;

            const rappelPayload = {
                attempt_count: attempts,
                last_attempt: now.toISOString(),
                next_recall: nextRecall.toISOString(),
                active: true
            };

            // Update Supabase 'rappel_info' ONLY
            await supabase.from('clients').update({
                rappel_info: rappelPayload
            }).eq('id', clientId);

            console.log(`⏳ Rappel programmé pour ${clientId} dans 26h (Tentative ${attempts})`);

            // On ne touche PAS au Sheet (statut reste SIGNÉ ou autre) pour éviter les conflits Bridge
            // Le Frontend affichera "Ne répond pas" basé sur 'rappel_info' en priorité

            notifyUpdate('clients');
            return res.json({ success: true, mode: 'supabase_only' });

        } catch (e) {
            console.error("Erreur save rappel:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    // CAS SPÉCIAL: ANNULATION RAPPEL (Client a répondu)
    if (statut === 'SIGNÉ' && customInfo === 'CLEAR_RAPPEL') {
        try {
            await supabase.from('clients').update({
                rappel_info: null
            }).eq('id', clientId);

            notifyUpdate('clients');
            return res.json({ success: true, mode: 'supabase_cleared' });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // COMPORTEMENT CLASSIQUE (Write to Sheets via Bridge/Batch)
    if (!googleSheetsService || (!clientId.startsWith('sheet-') && !clientId.includes('_'))) {
        return res.json({ success: true, mock: true });
    }

    try {
        let index;
        let tabName = 'devis';
        if (clientId.startsWith('sheet-')) {
            index = parseInt(clientId.split('-')[1]) + 4;
        } else {
            const lastUnderscore = clientId.lastIndexOf('_');
            tabName = clientId.substring(0, lastUnderscore).replace(/_/g, ' ');
            index = parseInt(clientId.substring(lastUnderscore + 1));
        }

        const updates = [];
        // Statut Global (G)
        if (statut) {
            const range = `'${tabName}'!${getColLetter(SHEET_SCHEMA.COL_STATUT_GLOBAL)}${index}`;
            updates.push({ range: range, values: [[statut]] });
        }

        await batchUpdate(updates);
        notifyUpdate('clients');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. GENERIC "CLIENT UPDATE" (Anciennement POST /logistics avec conflits)
// On refait une route propre pour valider les étapes manuellement depuis la vue détail
app.post('/api/clients/update-step', async (req, res) => {
    const { clientId, step, value } = req.body;
    // step: 'LIVRAISON_STATUT' | 'INSTALL_STATUT' | ...
    if (!googleSheetsService || !clientId?.startsWith('sheet-')) return res.json({ success: true });

    try {
        const index = parseInt(clientId.split('-')[1]) + 4;
        let colIndex = -1;
        let finalValue = value;

        switch (step) {
            case 'LIVRAISON_STATUT':
                colIndex = SHEET_SCHEMA.COL_LIVRAISON_STATUT;
                if (value === 'LIVRÉ' || value === 'LIVREE') {
                    finalValue = 'LIVRÉE'; // Normalize to feminine for delivery status
                    // Si on force "Livré" à la main, on met à jour la date aussi ?
                    // Optionnel.
                }
                break;
            case 'INSTALL_STATUT':
                colIndex = SHEET_SCHEMA.COL_INSTALL_STATUT;
                if (value === 'TERMINÉ' || value === 'TERMINE') {
                    finalValue = 'TERMINÉE'; // Normalize to feminine for installation status
                }
                break;
            case 'STATUT_GLOBAL':
                colIndex = SHEET_SCHEMA.COL_STATUT_GLOBAL;
                break;
        }

        if (colIndex !== -1) {
            await batchUpdate([
                { range: `devis!${getColLetter(colIndex)}${index}`, values: [[finalValue]] }
            ]);
            notifyUpdate('clients');
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. STOCK UPDATE
app.post('/api/stock/update', async (req, res) => {
    const { newTotal } = req.body;

    // Si offline, on renvoie juste ok
    if (!googleSheetsService) {
        console.log(`[Mock] Stock mis à jour: ${newTotal}`);
        return res.json({ success: true, mock: true, newTotal });
    }

    try {
        // Lecture actuelle pour D1 (Conso)
        const stockRow = await googleSheetsService.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'devis!D1', // Conso actuelle
        });
        const currentConso = parseInt(stockRow.data.values?.[0]?.[0]?.replace(/\s/g, '')) || 0;
        const newRestant = newTotal - currentConso;

        // Met à jour B1 (Total), D1 (Conso inchangé, mais on pourrait le laisser), F1 (Restant)
        // Mais POST attend 'newTotal' qui est le nouveau stock INITIAL (Total acheté) ? 
        // -> Oui, Stock View calcule newTotal = oldTotal + added. C'est bien B1.

        // Utilisation de formules pour que le Sheet reste dynamique
        const updates = [
            { range: 'devis!B1', values: [[newTotal]] },
            { range: 'devis!D1', values: [['=SUMIF(I4:I, "PLANIFIÉE", C4:C) + SUMIF(I4:I, "LIVRÉE", C4:C)']] },
            { range: 'devis!F1', values: [['=B1-D1']] }
        ];

        await batchUpdate(updates);
        notifyUpdate('stock');

        console.log(`🟢 Stock Total mis à jour: ${newTotal}. Formules D1/F1 réinjectées.`);
        res.json({ success: true });
    } catch (e) {
        console.error("Erreur update stock:", e);
        res.status(500).json({ error: e.message });
    }
});


// --- SMART SCHEDULER LOGIC ---

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// Geocoding with simple caching mechanism
async function getCoordinates(address, clientId = null) {
    if (!address) return null;

    // 1. Try to read from Sheet if clientId exists
    if (clientId && clientId.startsWith('sheet-') && googleSheetsService) {
        try {
            const index = parseInt(clientId.split('-')[1]) + 4;
            // Read Columns Q (16) and R (17)
            const range = `devis!${getColLetter(SHEET_SCHEMA.COL_LAT)}${index}:${getColLetter(SHEET_SCHEMA.COL_LON)}${index}`;
            const response = await googleSheetsService.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: range,
            });
            const values = response.data.values?.[0];
            if (values && values[0] && values[1]) {
                return { lat: parseFloat(values[0].replace(',', '.')), lon: parseFloat(values[1].replace(',', '.')) };
            }
        } catch (e) {
            console.error("Error reading coords:", e);
        }
    }

    // 1b. Hardcoded Mock REMOVED to ensure precision
    // if (lowerAddr.includes('paris')) return { lat: 48.8566, lon: 2.3522 };
    // ...

    // 2. Call API (LocationIQ)
    console.log(`🌍 Geocoding API Call (LocationIQ) for: ${address}`);
    const API_KEY = process.env.LOCATIONIQ_TOKEN || 'pk.07c69a7c3666d9258284534720937a09';
    try {
        const url = `https://us1.locationiq.com/v1/search.php?key=${API_KEY}&q=${encodeURIComponent(address)}&format=json&limit=1`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data && data.length > 0) {
                const coords = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
                await saveCoords(clientId, coords); // Helper to save
                return coords;
            }
        }
    } catch (e) {
        console.error("LocationIQ Error:", e.message);
    }

    // 3. Fallback: OpenRouteService Geocoding (Since we have the key!)
    const ORS_KEY = process.env.ORS_API_KEY;
    if (ORS_KEY) {
        console.log(`🌍 Geocoding Fallback (ORS) for: ${address}`);
        try {
            const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_KEY}&text=${encodeURIComponent(address)}&size=1`;
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                if (data.features && data.features.length > 0) {
                    const [lon, lat] = data.features[0].geometry.coordinates; // ORS is [Lon, Lat]
                    const coords = { lat, lon };
                    await saveCoords(clientId, coords);
                    return coords;
                }
            }
        } catch (e) {
            console.error("ORS Geocoding Error:", e.message);
        }
    }

    return null;
}

// Helper to save coords to sheet to avoid writing duplicate code
// Helper to save coords to Supabase (Source of Truth)
async function saveCoords(clientId, coords) {
    if (clientId) {
        // Just log for now or update supabase. 
        // Since bridge.js handles geocoding, we might not need this, but good to have.
        try {
            await supabase.from('clients').update({ gps: coords }).eq('id', clientId);
            console.log(`💾 Coords saved for ${clientId} in Supabase`);
        } catch (e) { console.error("Error saving coords", e); }
    }
}

// Helper Region
const getRegionFromDept = (dept) => {
    const mapping = {
        '75': 'IDF', '77': 'IDF', '78': 'IDF', '91': 'IDF', '92': 'IDF', '93': 'IDF', '94': 'IDF', '95': 'IDF',
        '69': 'ARA', '01': 'ARA', '03': 'ARA', '07': 'ARA', '15': 'ARA', '26': 'ARA', '38': 'ARA', '42': 'ARA', '43': 'ARA', '63': 'ARA', '73': 'ARA', '74': 'ARA',
        '13': 'PACA', '04': 'PACA', '05': 'PACA', '06': 'PACA', '83': 'PACA', '84': 'PACA',
        '33': 'NAQ', '16': 'NAQ', '17': 'NAQ', '19': 'NAQ', '23': 'NAQ', '24': 'NAQ', '40': 'NAQ', '47': 'NAQ', '64': 'NAQ', '79': 'NAQ', '86': 'NAQ', '87': 'NAQ',
        '31': 'OCC', '09': 'OCC', '11': 'OCC', '12': 'OCC', '30': 'OCC', '32': 'OCC', '34': 'OCC', '46': 'OCC', '48': 'OCC', '65': 'OCC', '66': 'OCC', '81': 'OCC', '82': 'OCC',
        '44': 'PDL', '49': 'PDL', '53': 'PDL', '72': 'PDL', '85': 'PDL',
        '35': 'BRE', '22': 'BRE', '29': 'BRE', '56': 'BRE',
        '59': 'HDF', '02': 'HDF', '60': 'HDF', '62': 'HDF', '80': 'HDF',
        '67': 'GES', '08': 'GES', '10': 'GES', '51': 'GES', '52': 'GES', '54': 'GES', '55': 'GES', '57': 'GES', '68': 'GES', '88': 'GES',
        '21': 'BFC', '25': 'BFC', '39': 'BFC', '58': 'BFC', '70': 'BFC', '71': 'BFC', '89': 'BFC', '90': 'BFC',
        '45': 'CVL', '18': 'CVL', '28': 'CVL', '36': 'CVL', '37': 'CVL', '41': 'CVL',
        '76': 'NOR', '14': 'NOR', '27': 'NOR', '50': 'NOR', '61': 'NOR',
        '2A': 'COR', '2B': 'COR'
    };
    return mapping[dept] || 'AUTRE';
};

app.post('/api/scheduler/suggestions', async (req, res) => {
    const { address, clientId, type = 'LIVRAISON', lat, lon } = req.body;

    // Use Supabase for everything
    try {
        // 1. Get Target Coordinates (Use payload if available to save API calls)
        let targetCoords = null;
        if (lat && lon) {
            targetCoords = { lat: parseFloat(lat), lon: parseFloat(lon) };
        } else {
            targetCoords = await getCoordinates(address, clientId);
        }

        if (!targetCoords) {
            console.warn("⚠️ Géocoding échoué pour:", address);
            return res.json({});
        }

        // Get Client Region info for weighting
        const targetDept = address?.match(/(\d{5})/)?.[1]?.substring(0, 2);

        // Commando Zones Definition (Simplified Map)
        // 1: Nord/Est, 2: Alpes, 3: Sud/Corse, 4: Occitanie, 5: Atlantique, 6: Breton, 7: Normand
        const COMMANDO_MAPPING = {
            // Zone 1: Nord & Est (Lundi)
            '59': 1, '62': 1, '02': 1, '80': 1, '60': 1, '08': 1, '51': 1, '55': 1, '54': 1, '57': 1, '67': 1, '68': 1, '88': 1, '10': 1, '52': 1,
            // Zone 2: Bourgogne & Rhône-Alpes (Mardi)
            '21': 2, '71': 2, '89': 2, '58': 2, '25': 2, '39': 2, '70': 2, '90': 2, '69': 2, '01': 2, '73': 2, '74': 2, '38': 2, '42': 2, '03': 2,
            // Zone 3: Sud & Méditerranée (Mercredi)
            '04': 3, '05': 3, '06': 3, '13': 3, '83': 3, '84': 3, '20': 3, '2A': 3, '2B': 3, '09': 3, '11': 3, '12': 3, '30': 3, '31': 3, '32': 3, '34': 3, '46': 3, '48': 3, '65': 3, '66': 3, '81': 3, '82': 3, '07': 3, '26': 3, '43': 3, '15': 3, '63': 3,
            // Zone 4: Grand Ouest & Atlantique (Jeudi)
            '16': 4, '17': 4, '19': 4, '23': 4, '24': 4, '33': 4, '40': 4, '47': 4, '64': 4, '79': 4, '86': 4, '87': 4, '44': 4, '49': 4, '53': 4, '72': 4, '85': 4, '35': 4, '22': 4, '29': 4, '56': 4, '36': 4, '18': 4,
            // Zone 5: Bassin Parisien (Vendredi)
            '75': 5, '77': 5, '78': 5, '91': 5, '92': 5, '93': 5, '94': 5, '95': 5, '14': 5, '27': 5, '50': 5, '61': 5, '76': 5, '28': 5, '45': 5, '41': 5, '37': 5
        };
        const targetZoneDay = COMMANDO_MAPPING[targetDept] || 0;

        // ... [Step 2 Fetch Code unchanged] ...
        const { data: clients, error } = await supabase.from('clients').select('*');
        // ... [Active Appointments Logic unchanged] ...
        if (error) throw error;

        const activeAppointments = [];
        const todayStr = new Date().toISOString().split('T')[0];
        const SEARCH_TYPE = req.body.type || 'LIVRAISON';

        clients.forEach((c) => {
            const dateLiv = c.date_livraison_prevue;
            const dateInstall = c.date_install_debut;
            const gps = c.gps || {};
            const lat = gps.lat;
            const lon = gps.lon;
            const camionId = '1';

            if (!lat || !lon) return;

            if (SEARCH_TYPE === 'LIVRAISON' && dateLiv) {
                activeAppointments.push({
                    type: 'LIVRAISON', date: dateLiv, time: '08:00', lat, lon, nbLed: c.nb_led,
                    address: c.adresse_brute, client: c.nom, clientId: c.id, camionId
                });
            }
            if (SEARCH_TYPE === 'INSTALLATION' && dateInstall) {
                activeAppointments.push({
                    type: 'INSTALLATION', date: dateInstall, time: '08:00', lat, lon, nbLed: c.nb_led,
                    address: c.adresse_brute, client: c.nom, clientId: c.id, camionId: c.install_poseur_id || "equipe-1"
                });
            }
        });

        const suggestions = {};
        const appointmentsByDate = {};
        activeAppointments.forEach(a => {
            if (!appointmentsByDate[a.date]) appointmentsByDate[a.date] = [];
            appointmentsByDate[a.date].push(a);
        });

        // Helper for Distance/Duration (Cache this if possible in prod)
        const getRouteData = async (start, end) => {
            const crowDist = getDistanceFromLatLonInKm(start.lat, start.lon, end.lat, end.lon);
            // Only use ORS if < 200km crow fly to save API
            if (crowDist < 200) {
                const apiKey = process.env.ORS_API_KEY;
                if (apiKey) {
                    try {
                        const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${apiKey}&start=${start.lon},${start.lat}&end=${end.lon},${end.lat}`;
                        const r = await fetch(url);
                        if (r.ok) {
                            const d = await r.json();
                            const s = d.features?.[0]?.properties?.summary;
                            if (s) return { dist: s.distance / 1000, duration: s.duration / 60, isReal: true };
                        }
                    } catch (e) { }
                }
            }
            // Fallback
            return { dist: crowDist, duration: crowDist * 1.5, isReal: false };
        };

        const candidates = [];
        const today = new Date();
        // Start from -1 (Yesterday) to allow retrofit planning
        for (let i = -1; i <= 60; i++) { // Increase horizon to 60 days to find zone match
            const d = new Date(today);
            d.setDate(today.getDate() + i);
            // Allow all days, even Sunday (0) if user wants to force it
            candidates.push(d.toISOString().split('T')[0]);
        }

        // Logic for Commando Cycle:
        // Week 1 starts on a Monday. 
        // We need a reference point. Let's assume Week 1 Day 1 = Zone 1.
        // Simple modulo 7 logic on day index of year?
        // No, let's just use ISO Day of Week (Monday=1...Sunday=7).
        // COMMANDO_ZONES keys match ISO Week Days (1=Monday...7=Sunday/Normal Day).
        // So valid day for Zone X is simply if date.day() == X.
        // Wait, Commando logic implies Monday is ALWAYS Zone 1? Yes.

        for (const date of candidates) {
            const dateObj = new Date(date);
            const isoDay = dateObj.getDay() || 7; // 0=Sun -> 7

            const dayTour = appointmentsByDate[date] || [];

            // Case A: No tour on this day yet.
            if (dayTour.length === 0) {
                // Is this the RIGHT day for this zone?
                const ALLOWED_DAYS_MAP = {
                    1: [1], // Lundi
                    2: [2], // Mardi
                    3: [3], // Mercredi
                    4: [4], // Jeudi
                    5: [5]  // Vendredi
                };
                const allowed = ALLOWED_DAYS_MAP[targetZoneDay] || [];
                const isZoneMatch = allowed.includes(isoDay);

                // CHECK CONTINUITY (User Request: "Si le chauffeur est proche la veille")
                let continuityBonus = false;
                let prevClientName = "";

                try {
                    const prevDate = new Date(dateObj);
                    prevDate.setDate(prevDate.getDate() - 1);
                    const prevDateStr = prevDate.toISOString().split('T')[0];
                    const prevTour = appointmentsByDate[prevDateStr];

                    if (prevTour && prevTour.length > 0) {
                        const lastStop = prevTour[prevTour.length - 1]; // End of previous day
                        // Check distance
                        const distToPrev = getDistanceFromLatLonInKm(lastStop.lat, lastStop.lon, targetCoords.lat, targetCoords.lon);
                        if (distToPrev < 150) { // < 150km : Driver can sleep there and continue
                            continuityBonus = true;
                            prevClientName = lastStop.client;
                        }
                    }
                } catch (e) { console.error(e); }

                // CHECK FORWARD CONTINUITY (Veille de tour suivant)
                let forwardBonus = false;
                let nextClientName = "";

                try {
                    const nextDate = new Date(dateObj);
                    nextDate.setDate(nextDate.getDate() + 1);
                    const nextDateStr = nextDate.toISOString().split('T')[0];
                    const nextTour = appointmentsByDate[nextDateStr];

                    if (nextTour && nextTour.length > 0) {
                        const firstStop = nextTour[0]; // Start of next day
                        const distToNext = getDistanceFromLatLonInKm(targetCoords.lat, targetCoords.lon, firstStop.lat, firstStop.lon);
                        if (distToNext < 150) {
                            forwardBonus = true;
                            nextClientName = firstStop.client;
                        }
                    }
                } catch (e) { console.error(e); }

                let rank = 10;
                let label = null;
                let status = 'RED';
                let reason = "Hors Zone";

                if (continuityBonus) {
                    rank = 98; // WINNER ! Better than Zone Match
                    label = "SUITE LOGIQUE";
                    status = 'GREEN';
                    reason = `Suite J-1 (${prevClientName})`;
                } else if (forwardBonus) {
                    rank = 97;
                    label = "VEILLE DE TOUR";
                    status = 'GREEN';
                    reason = `Avant J+1 (${nextClientName})`;
                } else if (isZoneMatch) {
                    rank = 95;
                    label = "ZONE IDÉALE";
                    status = 'GREEN';
                    reason = "Journée Zone Officielle";
                }

                suggestions[date] = {
                    date,
                    distance: continuityBonus ? 1 : 0,
                    duration: 0,
                    isReal: false,
                    existingClient: reason,
                    sourceCoords: null,
                    tour: [],
                    rank: rank,
                    eta: "08:00",
                    status: status,
                    label: label
                };
                continue;
            }

            // Case B: Existing Tour. Find best insertion TIME SLOT.
            // 1. Sort by time to establish the timeline
            dayTour.sort((a, b) => (a.time || "08:00").localeCompare(b.time || "08:00"));

            // Group appointments by truck for multi-truck detection
            const truckGroups = {};
            dayTour.forEach(a => {
                if (!truckGroups[a.camionId]) truckGroups[a.camionId] = [];
                truckGroups[a.camionId].push(a);
            });

            const TOTAL_TRUCKS = 3; // Flotte de 3 camions
            const usedTrucksCount = Object.keys(truckGroups).length;
            const hasFreeTruck = usedTrucksCount < TOTAL_TRUCKS;

            // --- CAPACITY & FREE TRUCK LOGIC ---
            // If we have a free truck, we can ALWAYS propose a "Nouveau départ"
            if (hasFreeTruck) {
                suggestions[date] = {
                    date,
                    distance: 0,
                    duration: 0,
                    isReal: false,
                    existingClient: "Nouveau départ (Camion libre)",
                    sourceCoords: null,
                    tour: [],
                    rank: 50,
                    eta: "08:00",
                    status: 'GREEN',
                    label: "CAMION DISPO"
                };
            }

            // Helper to parsing HH:mm to minutes
            const parseTime = (t) => {
                if (!t) return 9 * 60;
                const [h, m] = t.split(':').map(Number);
                return h * 60 + m;
            };

            const CAMION_CAPACITIES = {
                '1': 2500,
                '2': 2500,
                '3': 2500
            };

            const newNbLed = parseInt(req.body.nbLed || 0, 10) || 50;
            let bestSlot = null;
            let minDetour = Infinity;

            const JOB_DURATION = type === 'LIVRAISON' ? 45 : 60;
            const DAY_START = 8 * 60; // 08:00
            const DAY_END = 19 * 60; // 19:00

            const isInstallation = type === 'INSTALLATION';
            const LED_CAPACITY_POSEUR = 70;

            for (const [camionId, tour] of Object.entries(truckGroups)) {
                // If it's an installation, the "camionId" might actually represent a poseur group or shared tour
                // But we use the same logic for now.
                const currentTotal = tour.reduce((sum, a) => sum + (a.nbLed || 0), 0);

                // Use 70 for installations, otherwise truck capacity
                const capacityMax = isInstallation ? LED_CAPACITY_POSEUR : (CAMION_CAPACITIES[camionId] || 400);

                if (currentTotal + newNbLed > capacityMax) {
                    continue; // Skip full tours/teams
                }

                // Sort this specific tour
                tour.sort((a, b) => (a.time || "08:00").localeCompare(b.time || "08:00"));

                // 1. BEFORE FIRST
                const first = tour[0];
                const firstStart = parseTime(first.time || "09:00");
                const routeNext = await getRouteData(targetCoords, { lat: first.lat, lon: first.lon });
                if (DAY_START + JOB_DURATION + routeNext.duration <= firstStart) {
                    if (routeNext.dist < minDetour) {
                        minDetour = routeNext.dist;
                        bestSlot = { type: 'start', afterIndex: -1, eta: DAY_START, distCost: routeNext.dist, timeCost: routeNext.duration, prevClient: null, camionId, tour };
                    }
                }

                // 2. BETWEEN & 3. AFTER
                for (let i = 0; i < tour.length; i++) {
                    const current = tour[i];
                    const next = tour[i + 1];
                    const currentEnd = parseTime(current.time || "09:00") + JOB_DURATION;
                    const routeFromCurr = await getRouteData({ lat: current.lat, lon: current.lon }, targetCoords);
                    const proposedStart = currentEnd + routeFromCurr.duration;
                    const proposedEnd = proposedStart + JOB_DURATION;

                    if (next) {
                        const nextStart = parseTime(next.time || "09:00");
                        const routeToNext = await getRouteData(targetCoords, { lat: next.lat, lon: next.lon });
                        if (proposedEnd + routeToNext.duration <= nextStart) {
                            const baseRoute = await getRouteData({ lat: current.lat, lon: current.lon }, { lat: next.lat, lon: next.lon });
                            let addedDist = (routeFromCurr.dist + routeToNext.dist) - baseRoute.dist;
                            if (addedDist < 0) addedDist = 0;
                            if (addedDist < minDetour) {
                                minDetour = addedDist;
                                bestSlot = { type: 'gap', afterIndex: i, eta: proposedStart, distCost: addedDist, timeCost: routeFromCurr.duration + routeToNext.duration, prevClient: current, camionId, tour };
                            }
                        }
                    } else {
                        if (proposedEnd <= DAY_END) {
                            if (routeFromCurr.dist < minDetour) {
                                minDetour = routeFromCurr.dist;
                                bestSlot = { type: 'end', afterIndex: i, eta: proposedStart, distCost: routeFromCurr.dist, timeCost: routeFromCurr.duration, prevClient: current, camionId, tour };
                            }
                        }
                    }
                }
            }

            if (bestSlot) {
                // Format ETA
                const h = Math.floor(bestSlot.eta / 60) % 24;
                const m = Math.floor(bestSlot.eta % 60);
                const etaString = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;

                const proposedTour = [...bestSlot.tour.map(c => ({ ...c }))];
                proposedTour.splice(bestSlot.afterIndex + 1, 0, {
                    lat: targetCoords.lat,
                    lon: targetCoords.lon,
                    client: "NOUVEAU: Client Cible (" + etaString + ")",
                    type: type === 'LIVRAISON' ? 'LIVRAISON' : 'INSTALLATION',
                    isNew: true,
                    time: etaString,
                    camionId: bestSlot.camionId
                });

                // Rank logic: 
                // Existing rank if already set (Nouveau départ) or 100 - detour
                let boost = 0;
                let proximityLabel = null;
                const targetDept = address?.match(/(\d{5})/)?.[1]?.substring(0, 2);
                const targetRegion = getRegionFromDept(targetDept);

                // For insertions, it's easier to check the prevClient or first in tour
                const refClient = bestSlot.prevClient || (dayTour.length > 0 ? dayTour[0] : null);
                if (refClient) {
                    const refDept = (refClient.address || "")?.match(/(\d{5})/)?.[1]?.substring(0, 2);
                    const refRegion = getRegionFromDept(refDept);

                    if (targetDept && targetDept === refDept) boost = 45; // Huge boost for same dept
                    else if (targetRegion && targetRegion === refRegion) boost = 30; // Significant boost for same region
                }

                // NEW: Proximity Bonus (User Request: "Moins de 1h de route" -> approx 70km)
                // If the detour is minimal (meaning we pass very close), giving it HIGH priority
                let proximityRank = 0;
                if (minDetour < 70) {
                    proximityRank = 96; // Just above Zone Ideale (95)
                    proximityLabel = "PROXIMITÉ (-1h)";
                }

                const insertionRank = Math.max((100 - minDetour) + boost, proximityRank);
                const existingRank = suggestions[date]?.rank || 0;

                if (insertionRank > existingRank) {
                    suggestions[date] = {
                        date,
                        distance: parseFloat(minDetour < 10 ? minDetour.toFixed(1) : Math.round(minDetour)),
                        duration: bestSlot.timeCost ? Math.round(bestSlot.timeCost) : 0,
                        isReal: true,
                        existingClient: bestSlot.prevClient ? bestSlot.prevClient.client : "Début de tournée",
                        sourceCoords: bestSlot.prevClient ? { lat: bestSlot.prevClient.lat, lon: bestSlot.prevClient.lon } : null,
                        tour: proposedTour,
                        positionInTour: bestSlot.afterIndex + 2, // 1-based
                        totalClients: dayTour.length + 1,
                        rank: insertionRank,
                        eta: etaString,
                        status: minDetour < 30 ? 'GREEN' : 'ORANGE',
                        label: proximityLabel // Override label
                    }
                }
            }
        }

        const results = Object.values(suggestions)
            .sort((a, b) => b.rank - a.rank)
            .map(s => {
                let status = 'RED';
                if (s.rank > 80) status = 'GREEN';
                else if (s.rank > 40) status = 'ORANGE';

                let label = s.label;
                if (s.rank > 80 && s.distance > 0 && !label) {
                    label = "OPTIMISÉ";
                }
                if (s.distance === 0 && s.existingClient?.includes("Nouveau")) status = 'ORANGE';

                return { ...s, status, label };
            })
            .filter(s => s.status !== 'RED'); // Masquer les dates saturées (RED)

        res.json({ suggestions: results, targetCoords });

    } catch (e) {
        console.error("Scheduler Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- BULK GEOCODING TOOL (Bonus) ---
app.get('/api/admin/geocode-sync', async (req, res) => {
    if (!googleSheetsService) return res.status(503).json({ error: 'Sheets not connected' });

    // Respond immediately so UI doesn't hang
    res.json({
        message: "🔄 Synchronisation GPS lancée en arrière-plan...",
        details: "Le système scanne tout le tableau et remplit les coordonnées manquantes."
    });

    // Run in background
    (async () => {
        try {
            console.log("📡 [ADMIN] Début du scan GPS complet...");
            const response = await googleSheetsService.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'devis!A4:R',
            });
            const rows = response.data.values || [];
            let count = 0;

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const address = row[SHEET_SCHEMA.COL_ADRESSE];
                // Check if LAT (Q) or LON (R) is missing/invalid
                // Note: Index lookup logic: A=0, ... Q=16, R=17
                const lat = row[16];
                const lon = row[17];

                if (address && address.length > 5 && (!lat || !lon || lat.trim() === '' || isNaN(parseFloat(lat.replace(',', '.'))))) {
                    console.log(`📍 [Fix] Traitement ligne ${i + 4}: ${address}`);

                    // Trigger geocode + save (The saving logic is inside getCoordinates via 'sheet-ID')
                    await getCoordinates(address, `sheet-${i}`);
                    count++;

                    // Respect Free Tier Rate Limit (Max 2 req/s -> safe wait 600-1000ms)
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
            console.log(`✅ [ADMIN] Scan GPS terminé. ${count} adresses mises à jour.`);
        } catch (e) {
            console.error("⚠️ [ADMIN] Erreur sync GPS:", e);
        }
    })();
});


// 2.5 GET RESOURCES (Equipes & Camions) - SOURCE DE VÉRITÉ
app.get('/api/resources', async (req, res) => {
    try {
        const { data: equipes, error } = await supabase
            .from('equipes')
            .select('*');

        if (error) throw error;

        // Mapper pour le frontend
        const resources = equipes.map(e => ({
            id: e.id,
            nom: e.nom,
            type: e.type, // 'LIVREUR' ou 'POSEUR'
            capacite: e.capacite_max,
            secteur: e.secteur_defaut,
            couleur: e.couleur
        }));

        res.json(resources);
    } catch (error) {
        console.error("Erreur GET Resources:", error.message);
        // Fallback temporaire si la table est vide ou erreur connexion
        res.json([
            { id: 'camion-1', nom: 'Camion A (20m³) [Fallback]', type: 'LIVREUR', capacite: 20, secteur: 'IDF' },
            { id: 'camion-2', nom: 'Camion B (12m³) [Fallback]', type: 'LIVREUR', capacite: 12, secteur: 'SUD' },
            { id: 'equipe-1', nom: 'Équipe 1 (Lyon) [Fallback]', type: 'POSEUR', capacite: 70, secteur: '69' },
            { id: 'equipe-2', nom: 'Équipe 2 (Paris) [Fallback]', type: 'POSEUR', capacite: 70, secteur: '75' }
        ]);
    }
});


// --- 10. VROOM / OPENROUTESERVICE PROXY ---
app.post('/api/vroom/optimize', async (req, res) => {
    try {
        const { jobs, vehicles, options } = req.body;
        // Use provided key or fallback to known testing key
        const ORS_API_KEY = process.env.ORS_API_KEY || '5b3ce3597851110001cf62480914993c9e614716b19e51b17409dbac';

        console.log(`🚀 VROOM Proxy: Optimizing ${jobs.length} jobs with ${vehicles.length} vehicles...`);

        const payload = {
            jobs,
            vehicles,
            options: { g: true }
        };

        const response = await fetch('https://api.openrouteservice.org/optimization', {
            method: 'POST',
            headers: {
                'Authorization': ORS_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.warn("⚠️ ORS Optimization Error:", errText);
            return res.status(response.status).send(errText); // Return text directly for frontend logs
        }

        const data = await response.json();
        console.log(`✅ CMD Validée, ${data.routes ? data.routes.length : 0} routes générées.`);
        res.json(data);

    } catch (e) {
        console.error("❌ VROOM Proxy Error:", e);
        res.status(500).json({ error: e.message });
    }
});


httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Serveur V2 (Clean Schema) + WebSockets démarré sur port ${PORT}`);
});
