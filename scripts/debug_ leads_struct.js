
import { qhareManager } from '../server/qhare_manager.js';

async function debugLeads() {
    console.log("🕵️ DEBUG COMPLET QHARE LEADS");

    try {
        // 1. Appel direct brut
        const url = `${qhareManager.baseUrl}/leads?access_token=${qhareManager.apiKey}`;
        const res = await fetch(url);
        const json = await res.json();

        // 2. Dump de la structure
        console.log("Type de réponse:", typeof json);
        if (Array.isArray(json)) {
            console.log("C'est un ARRAY de", json.length, "éléments");
            if (json.length > 0) {
                console.log("Exemple élément 1:", JSON.stringify(json[0], null, 2));
                console.log("Etat élément 1:", json[0].etat);
            }
        } else {
            console.log("C'est un OBJET. Clés disponibles:", Object.keys(json));
            // Si c'est un objet, est-ce que les leads sont dedans ?
            if (json.leads) console.log("-> Contient clé 'leads' (" + json.leads.length + ")");
            if (json.data) console.log("-> Contient clé 'data' (" + json.data.length + ")");

            // Affichons tout pour comprendre
            console.log("DUMP:", JSON.stringify(json, null, 2).substring(0, 1000));
        }

    } catch (e) {
        console.error("Erreur:", e);
    }
}

debugLeads();
