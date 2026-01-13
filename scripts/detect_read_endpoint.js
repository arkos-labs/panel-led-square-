
import { qhareManager } from '../server/qhare_manager.js';

async function bruteforceRead() {
    console.log("🕵️ Recherche automatique de la commande de lecture (Bruteforce)...");

    // Liste des tentatives courantes pour les APIs type PHP/Qhare
    const candidates = [
        { url: '/lead/list', method: 'POST' },
        { url: '/lead/get', method: 'POST' },
        { url: '/lead/search', method: 'POST' },
        { url: '/lead/filter', method: 'POST' },
        { url: '/leads', method: 'GET' },
        { url: '/leads/list', method: 'GET' },
        { url: '/api/leads', method: 'GET' }, // Parfois /api est doublé
        { url: '/export/leads', method: 'GET' },
        { url: '/export/leads', method: 'POST' }
    ];

    const payload = {
        access_token: qhareManager.apiKey,
        limit: 5,
        page: 1
    };

    for (const cand of candidates) {
        try {
            const url = `${qhareManager.baseUrl}${cand.url}`;
            // console.log(`Test: ${cand.method} ${cand.url}`);

            let options = {
                method: cand.method,
                headers: { 'Content-Type': 'application/json' }
            };

            if (cand.method === 'POST') {
                options.body = JSON.stringify(payload);
                // On test aussi avec l'URL param pour être sûr
                const urlWithToken = `${url}?access_token=${qhareManager.apiKey}`;
                const res = await fetch(urlWithToken, options);
                if (res.ok) {
                    console.log(`🎉 TROUVÉ ! Commande valide : [${cand.method}] ${cand.url}`);
                    const data = await res.json();
                    console.log("Exemple de réponse:", JSON.stringify(data).substring(0, 200));
                    return;
                }
            } else {
                const urlWithToken = `${url}?access_token=${qhareManager.apiKey}`;
                const res = await fetch(urlWithToken, options);
                if (res.ok) {
                    console.log(`🎉 TROUVÉ ! Commande valide : [${cand.method}] ${cand.url}`);
                    const data = await res.json();
                    console.log("Exemple de réponse:", JSON.stringify(data).substring(0, 200));
                    return;
                }
            }

            // Si 401, c'est que l'endpoint existe mais auth foireuse (donc c'est une piste)
            // Si 404, n'existe pas.
            // Si 405, mauvaise méthode (ex GET au lieu de POST)

        } catch (e) {
            // Ignorer erreurs réseau
        }
    }
    console.log("❌ Aucune commande standard n'a fonctionné. Il faut vraiment la documentation 'Lister/Récupérer'.");
}

bruteforceRead();
