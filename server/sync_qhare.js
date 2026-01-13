
import { qhareManager } from './qhare_manager.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper pour synchroniser avec Qhare en arrière-plan
async function syncToQhare(clientId, type, clientData = null) {
    try {
        console.log(`📡 [Sync] Synchronisation Qhare demandée pour ${clientId} (${type})`);

        // 1. Si on n'a pas les données complètes, on les récupère de Supabase
        let fullClient = clientData;
        if (!fullClient) {
            const { data, error } = await supabase
                .from('clients')
                .select('*')
                .eq('id', clientId)
                .single();
            if (error || !data) {
                console.warn(`⚠️ [Sync] Impossible de lire client ${clientId} pour sync Qhare`);
                return;
            }
            fullClient = data;
        }

        // 2. Déterminer les statuts Qhare en fonction de l'action
        let qhareUpdates = {};

        switch (type) {
            case 'livraison':
                qhareUpdates = {
                    etat: 'Livraison', // Adapter selon vos statuts Qhare réels
                    sous_etat: 'Livré',
                    commentaire_1: `Livraison validée le ${new Date().toLocaleDateString()}`
                };
                break;
            case 'chantier-debut':
                qhareUpdates = {
                    etat: 'Installation',
                    sous_etat: 'En cours',
                    commentaire_1: `Installation débutée le ${new Date().toLocaleDateString()}`
                };
                break;
            case 'chantier': // Fin chantier
                qhareUpdates = {
                    etat: 'Installation',
                    sous_etat: 'Terminé',
                    commentaire_1: `Installation terminée le ${new Date().toLocaleDateString()}`
                };
                break;
            case 'planification': // Quand on choisit une date dans le Panel
                qhareUpdates = {
                    // etat: 'Installation', // A voir si on change l'état principal ou pas
                    sous_etat: 'Client planifié',
                    commentaire_1: `Planifié via Panel le ${new Date().toLocaleDateString()}`
                };
                break;
            default:
                // Pour une update générique, on laisse Qhare gérer ou on mappe les statuts existants
                // TODO: Mapper fullClient.statut_client vers qhareUpdates.etat si besoin
                break;
        }

        // 3. Envoyer à Qhare
        // On tente une mise à jour directe. Si on n'a pas l'ID Qhare stocké (on devrait l'avoir dans une colonne qhare_id idéalement, 
        // mais pour l'instant on va faire une recherche ou tentative de création ?)

        // LIMITATION ACTUELLE : On ne stocke pas encore l'ID Qhare dans Supabase column `qhare_id`.
        // SOLUTION TEMPORAIRE : On tente de créer (qui fera office d'update ou créera un doublon qu'on peut gérer plus tard).
        // Mieux : qhareManager.createLead renvoie l'ID.

        // On merge les updates avec les données clients
        const payload = { ...fullClient, ...qhareUpdates };

        // On utilise createLead qui est en fait capable de créer, et si on pouvait update on le ferait.
        // Mais comme on n'a pas l'ID, on recrée souvent. 
        // ASTUCE: Si vous avez activé le dédoublonnage sur Qhare par EMAIL ou TEL, ça va juste update ou rejeter.

        // Idéalement, il faudrait stocker l'ID Qhare dans Supabase lors de la migration.
        // Je vais supposer que vous voulez juste "pousser" l'info.

        await qhareManager.createLead(payload);
        console.log(`✅ [Sync] Données envoyées à Qhare pour ${fullClient.nom}`);

    } catch (e) {
        console.error(`❌ [Sync] Echec synchronisation Qhare: ${e.message}`);
    }
}

export default syncToQhare;
