
import { qhareManager } from '../server/qhare_manager.js';

async function huntReadEndpoint() {
    console.log("🕵️ CHASSE AU TRÉSOR API READ ...");
    const targetId = '1666226'; // ID vu sur votre écran

    const candidates = [
        // GET avec ID dans URL
        { url: `/lead/${targetId}`, method: 'GET' },
        { url: `/leads/${targetId}`, method: 'GET' },
        { url: `/lead/get/${targetId}`, method: 'GET' },

        // POST avec ID dans Body
        { url: `/lead/get`, method: 'POST', body: { id: targetId } },
        { url: `/lead/read`, method: 'POST', body: { id: targetId } },
        { url: `/lead/details`, method: 'POST', body: { id: targetId } },

        // Export général
        { url: `/export`, method: 'GET' },
        { url: `/leads/export`, method: 'GET' }
    ];

    for (const cand of candidates) {
        try {
            console.log(`Test: ${cand.method} ${cand.url}...`);
            const opts = { method: cand.method };
            if (cand.body) {
                opts.body = JSON.stringify({ ...cand.body, access_token: qhareManager.apiKey });
                opts.headers = { 'Content-Type': 'application/json' };
            }
            const fullUrl = `${qhareManager.baseUrl}${cand.url}?access_token=${qhareManager.apiKey}`;

            const res = await fetch(fullUrl, opts);
            if (res.ok) {
                const text = await res.text();
                // Si ça renvoie just "44" ou un petit truc, c'est pas bon
                if (text.length > 50) {
                    console.log(`🎉 BINGO ! ${cand.url} a renvoyé du contenu !`);
                    console.log(text.substring(0, 300));
                    return;
                }
            } else {
                // console.log(`   -> ${res.status}`);
            }
        } catch (e) { }
    }
    console.log("❌ Toujours rien. L'API semble très fermée en lecture.");
}

huntReadEndpoint();
