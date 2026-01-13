
import { qhareManager } from '../server/qhare_manager.js';
import fs from 'fs';

// Test simple de création de lead
async function test() {
    console.log("🚀 Lancement du test API Qhare...");

    const fakeClient = {
        nom: "TEST_API_ANTIGRAVITY",
        prenom: "Jean-Michel",
        telephone: "0600000000",
        email: "test.antigravity@example.com",
        adresse: "10 Rue de la Paix, 75001 Paris",
        code_postal: "75001",
        ville: "Paris",
        departement: "75",
        chauffage: "Electrique",
        commentaire: "Ceci est un test automatique via script nodeJS"
    };

    try {
        const result = await qhareManager.createLead(fakeClient);
        console.log("RESULTAT SUCCES:", JSON.stringify(result, null, 2));
    } catch (e) {
        console.log("ECHEC DU TEST.");
        const failLog = `
        Time: ${new Date().toISOString()}
        Error: ${e.message}
        Stack: ${e.stack}
        `;
        fs.writeFileSync('qhare_test_error.log', failLog);
        console.log("Erreur écrite dans qhare_test_error.log");
    }
}

test();
