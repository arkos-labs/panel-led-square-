
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { qhareManager } from '../server/qhare_manager.js';

// Load Env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

async function migrate() {
    console.log("🚀 Démarrage de la migration vers Qhare CRM...");

    // Modification: Lecture depuis Google Sheets car DB vide
    console.log("📂 Lecture depuis Google Sheets (Source de vérité)...");

    // Import dynamique pour éviter les dépendances circulaires
    const { googleManager } = await import('../server/google_manager.js');
    await googleManager.connect();

    const tabsStr = "fr metropole ,Guadeloupe,Martinique,Guyane,Reunion,Mayotte,Corse";
    const tabs = tabsStr.split(',');

    let allClients = [];

    // Mapping colonnes Sheet (standard)
    const COL = {
        NOM: 0,
        PRENOM: 1,
        ADRESSE: 2,
        TEL: 3,
        EMAIL: 4,
        STATUT: 5,
        NB_LED: 9 // Vérifier si c'est la bonne colonne pour nb led
    };

    for (const tab of tabs) {
        console.log(`📄 Lecture onglet: ${tab}...`);
        try {
            const res = await googleManager.sheetsGet({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `'${tab}'!A4:Z1000` // On lit large
            });

            const rows = res.data.values || [];
            rows.forEach((row, index) => {
                // On ignore les lignes vides ou sans nom ou Headers
                if (!row[0] || !row[0].trim() || row[0].includes('NOM')) return;

                // On reconstruit un objet client propre
                const client = {
                    id: `${tab}_${index + 4}`, // ID temporaire pour le log
                    source_sheet: tab,
                    nom: row[COL.NOM],
                    prenom: row[COL.PRENOM],
                    adresse: row[COL.ADRESSE],
                    telephone: row[COL.TEL],
                    email: row[COL.EMAIL],
                    // Nettoyage nb_led (enlève les espaces, texte, etc)
                    nb_led: row[COL.NB_LED] ? parseInt(row[COL.NB_LED].replace(/\D/g, '') || '0') : 0,
                    statut_client: row[COL.STATUT], // Statut global

                    // Code Postal / Ville (Extraction brute si possible)
                    adresse_brute: row[COL.ADRESSE]
                };
                allClients.push(client);
            });
        } catch (e) {
            console.warn(`⚠️ Impossible de lire ${tab}:`, e.message);
        }
    }

    const clients = allClients;
    console.log(`📊 ${clients.length} clients trouvés dans le Google Sheet.`);

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;

    // Fichier de mapping pour garder une trace (ID Local -> ID Qhare)
    const mappingFile = path.join(__dirname, 'migration_qhare_log.json');
    let mapping = {};
    if (fs.existsSync(mappingFile)) {
        mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
    }

    for (const client of clients) {
        // Filtrer les clients vides ou invalides
        if (!client.nom || client.nom.includes("NOM_")) {
            skipCount++;
            continue;
        }

        // Vérifier si déjà migré
        if (mapping[client.id]) {
            // console.log(`⏭️ Client déjà migré: ${client.nom}`);
            skipCount++;
            continue;
        }

        process.stdout.write(`📤 Envoi de ${client.nom} ${client.prenom || ''}... `);

        try {
            // Pause pour éviter de spammer l'API (Rate Limit) - Important pour Qhare
            await new Promise(r => setTimeout(r, 1000));

            const res = await qhareManager.createLead(client);

            if (res && (res.id || res.message === 'Lead créé')) {
                console.log(`✅ OK ID: ${res.id}`);
                mapping[client.id] = res.id;
                successCount++;

                // Sauvegarde incrémentale
                fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
            } else {
                console.log(`⚠️ ERREUR INIT:`, res);
                failCount++;
            }

        } catch (e) {
            console.log(`❌ ERREUR EXCEPTION:`, e.message);
            failCount++;
        }
    }

    console.log("\n🏁 MIGRATION TERMINÉE");
    console.log(`✅ Succès: ${successCount}`);
    console.log(`❌ Echecs: ${failCount}`);
    console.log(`⏭️ Ignorés/Déjà fait: ${skipCount}`);
    console.log(`📂 Log de mapping sauvegardé dans: ${mappingFile}`);
}

migrate();
