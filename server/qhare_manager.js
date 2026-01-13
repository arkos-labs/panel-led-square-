
import fetch from 'node-fetch';

/**
 * Manager pour l'API Qhare CRM (RSH Digital)
 * Remplace progressivement Google Sheets pour la gestion des leads.
 */
class QhareManager {
    constructor() {
        this.apiKey = "tMebdKJBpI_ozc3XHoi-MMpgxG4QZOJXUWTCByekScI";
        this.baseUrl = "https://qhare.fr/api";
        this.defaultCategory = "Relamping"; // CHANGEMENT: Catégorie LED
    }

    /**
     * Crée un nouveau lead dans Qhare
     * @param {Object} clientData Données du client (format interne App)
     * @returns {Promise<Object>} Réponse de l'API Qhare
     */
    async createLead(clientData) {
        const payload = this._mapClientToQhare(clientData);
        console.log("📤 [Qhare] Envoi nouveau lead (Force URL Encoded)...", payload.nom);

        try {
            // On force le mode URL Encoded qui semble plus robuste pour cette API
            return await this._retryWithUrlEncoded('/lead/create', payload);
        } catch (error) {
            console.error("❌ [Qhare] Erreur réseau/connexion:", error.message);
            throw error;
        }
    }

    /**
     * Met à jour un lead existant
     * @param {string} qhareId ID Qhare du lead
     * @param {Object} clientData Données à mettre à jour
     */
    async updateLead(qhareId, clientData) {
        if (!qhareId) throw new Error("ID Qhare manquant pour la mise à jour");

        const payload = this._mapClientToQhare(clientData);
        payload.id = qhareId; // Ajout ID requis pour update

        console.log(`📤 [Qhare] Mise à jour lead ${qhareId}...`);

        try {
            // endpoint update selon doc: https://qhare.fr/api/lead/update
            // TENTATIVE 1: Token dans URL aussi
            const urlWithToken = `${this.baseUrl}/lead/update?access_token=${this.apiKey}`;

            const response = await fetch(urlWithToken, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (result.error) {
                console.error("❌ [Qhare] Erreur Update:", result.error);
                throw new Error(result.error);
            }

            console.log("✅ [Qhare] Lead mis à jour.");
            return result;
        } catch (error) {
            console.error("❌ [Qhare] Erreur Update:", error.message);
            return this._retryWithUrlEncoded('/lead/update', payload);
        }
    }

    /**
     * Récupère la liste des leads depuis Qhare
     * @returns {Promise<Array>} Liste des leads
     */
    async fetchLeads() {
        console.log("📥 [Qhare] Récupération des leads...");
        try {
            const url = `${this.baseUrl}/leads?access_token=${this.apiKey}`;
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`Erreur HTTP ${response.status}`);
            }

            const data = await response.json();

            // Le format peut être { leads: [...] } ou [...] ou { data: [...] }
            // Adaptation dynamique selon ce qu'on a vu (Objet)
            let leads = [];
            if (Array.isArray(data)) {
                leads = data;
            } else if (data.leads && Array.isArray(data.leads)) {
                leads = data.leads;
            } else if (data.data && Array.isArray(data.data)) {
                leads = data.data;
            } else {
                // Fallback: retourne l'objet brut dans un tableau si unique, ou log pour debug
                console.warn("⚠️ [Qhare] Structure de liste inconnue, renvoi brut");
                leads = [data];
            }

            console.log(`✅ [Qhare] ${leads.length} leads récupérés.`);
            return leads;
        } catch (error) {
            console.error("❌ [Qhare] Erreur Fetch:", error.message);
            throw error;
        }
    }

    /**
     * Méthode de secours si JSON n'est pas accepté (souvent le cas sur vieilles API PHP)
     */
    async _retryWithUrlEncoded(endpoint, data) {
        console.log("🔄 [Qhare] Tentative format x-www-form-urlencoded...");
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(data)) {
            if (value !== undefined && value !== null) {
                params.append(key, value);
            }
        }

        // URL avec token
        const finalUrl = `${this.baseUrl}${endpoint}?access_token=${this.apiKey}`;

        const response = await fetch(finalUrl, {
            method: 'POST',
            body: params
        });

        // Si ça fail ici aussi, on renvoie l'erreur brute
        if (!response.ok) {
            const text = await response.text();
            console.error(`❌ [Qhare] Erreur HTTP ${response.status}:`, text);
            throw new Error(`Qhare API Error ${response.status}`);
        }

        const result = await response.json();
        console.log("✅ [Qhare] Succès en mode form-urlencoded.");
        return result;
    }

    /**
     * Mappe les données internes vers le format Qhare
     */
    _mapClientToQhare(client) {
        // Extraction adresse si format string unique
        let addressParts = {};
        if (client.adresse && !client.code_postal) {
            // Essai de parsing basique pour extraire CP (5 chiffres)
            const cpMatch = client.adresse.match(/\b\d{5}\b/);
            if (cpMatch) {
                addressParts.code_postal = cpMatch[0];
                // On pourrait essayer d'extraire la ville mais c'est risqué sans géocodeur
            }
        }

        return {
            access_token: this.apiKey, // Obligatoire
            categorie: this.defaultCategory, // Obligatoire
            nom: client.nom || "Inconnu", // Obligatoire
            prenom: client.prenom || "",
            telephone: client.telephone || client.telephone_portable || "", // Obligatoire
            email: client.email || "",

            // Adresse
            adresse: client.adresse || "",
            code_postal: client.code_postal || client.codePostal || addressParts.code_postal || "",
            ville: client.ville || "",
            departement: client.departement || (client.code_postal ? client.code_postal.substring(0, 2) : ""), // Obligatoire selon doc

            // Infos métier
            chauffage: client.chauffage || "",
            source: "API Panel",

            // Commentaires / Champs libres
            commentaire_1: `Import depuis Panel. ID Interne: ${client.id || 'N/A'}`,
            commentaire_2: client.commentaire || ""

            // TODO: Ajouter champs BtoB si besoin (siret, raison_sociale)
        };
    }
}

export const qhareManager = new QhareManager();
