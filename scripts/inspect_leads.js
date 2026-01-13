
import { qhareManager } from '../server/qhare_manager.js';

async function inspectLeads() {
    console.log("🕵️ Inspection approfondie de GET /leads ...");

    // Test GET /leads
    try {
        const url = `${qhareManager.baseUrl}/leads?access_token=${qhareManager.apiKey}`;
        console.log(`URL: ${url}`);

        const res = await fetch(url);
        console.log(`Status: ${res.status} ${res.statusText}`);

        const text = await res.text();
        console.log("Contenu brut reçu (500 premiers caractères):");
        console.log(text.substring(0, 500));

        try {
            const json = JSON.parse(text);
            console.log("✅ C'est du JSON valide !");
            console.log("Nombre d'éléments:", Array.isArray(json) ? json.length : 'Objet');
        } catch (e) {
            console.log("⚠️ Ce n'est pas du JSON valide.");
        }

    } catch (e) {
        console.error("Erreur:", e.message);
    }
}

inspectLeads();
