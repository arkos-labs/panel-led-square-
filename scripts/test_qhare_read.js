
import { qhareManager } from '../server/qhare_manager.js';

async function testRead() {
    console.log("🕵️ Tentative de lecture des leads depuis Qhare...");

    // Essai 1: Endpoint standard /lead/list
    try {
        const url = `${qhareManager.baseUrl}/lead/list?access_token=${qhareManager.apiKey}`;
        console.log(`📡 Test GET ${url}...`);

        const res = await fetch(url, { method: 'GET' });
        if (res.ok) {
            const data = await res.json();
            console.log("✅ Réponse reçue (GET /lead/list):");
            console.log(JSON.stringify(data).substring(0, 500) + "...");
            return;
        } else {
            console.log(`❌ Echec GET: ${res.status} ${res.statusText}`);
        }
    } catch (e) {
        console.log("❌ Erreur GET:", e.message);
    }

    // Essai 2: Endpoint POST /lead/list (Souvent utilisé par ces APIs)
    try {
        const url = `${qhareManager.baseUrl}/lead/list?access_token=${qhareManager.apiKey}`;
        console.log(`📡 Test POST ${url}...`);

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: qhareManager.apiKey })
        });

        if (res.ok) {
            const data = await res.json();
            console.log("✅ Réponse reçue (POST /lead/list):");
            console.log(JSON.stringify(data).substring(0, 500) + "...");
        } else {
            console.log(`❌ Echec POST: ${res.status} ${res.statusText}`);
        }
    } catch (e) {
        console.log("❌ Erreur POST:", e.message);
    }
}

testRead();
