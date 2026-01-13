
import fetch from 'node-fetch';

async function simulateWebhook() {
    console.log("🧪 Simulation d'un Webhook Qhare entrant vers LOCALHOST...");

    // Données fictives comme si elles venaient de Qhare
    const fakePayload = {
        id: "TEST_SIMU_" + Date.now(),
        nom: "TEST SIMULATION",
        prenom: "Client",
        etat: "SIGNÉ", // Important
        email: "test.simu@example.com",
        telephone: "0600000000",
        adresse: "10 Rue de la Paix",
        code_postal: "75001",
        ville: "Paris"
    };

    try {
        const response = await fetch('http://localhost:3001/api/webhook/qhare', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fakePayload)
        });

        const result = await response.json();
        console.log("Réponse du serveur:", result);

        if (result.status === 'created' || result.status === 'exists') {
            console.log("✅ SUCCÈS : Le client devrait être visible dans le Panel !");
        } else {
            console.log("❌ ÉCHEC : ", result);
        }

    } catch (e) {
        console.error("Erreur connexion:", e.message);
    }
}

simulateWebhook();
