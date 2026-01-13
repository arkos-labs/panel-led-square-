
// CRON JOB pour importation automatique Qhare -> Panel
// S'exécute toutes les X minutes

import { qhareManager } from './qhare_manager.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function syncQhareToPanel() {
    console.log("⏰ [Auto-Import] Vérification nouveaux leads Qhare...");

    try {
        const leads = await qhareManager.fetchLeads();
        let newCount = 0;

        for (const lead of leads) {
            // FILTRE: On n'importe QUE les dossiers "SIGNÉ"
            // On vérifie le champ 'etat' (ou 'sous_etat' si besoin)
            const etat = (lead.etat || '').toUpperCase();

            // On accepte "SIGNÉ", "SIGNE", "VALIDE", etc. Ajustez selon le terme exact Qhare
            if (!etat.includes('SIGNÉ') && !etat.includes('SIGNE')) {
                // console.log(`⏭️ Ignoré (Pas signé): ${lead.nom} [Etat: ${lead.etat}]`);
                continue;
            }

            // Unicité basée sur l'email ou le téléphone pour éviter doublons

            // 1. Vérif existence
            const { data: existing } = await supabase
                .from('clients')
                .select('id')
                .or(`email.eq.${lead.email},telephone.eq.${lead.telephone},nom.eq.${lead.nom}`)
                .maybeSingle();

            if (existing) {
                // Déjà là, on skip (ou on update si besoin)
                continue;
            }

            // 2. Création
            console.log(`✨ Nouveau Lead détecté : ${lead.nom} ${lead.prenom}`);

            const newClient = {
                source: 'Qhare Auto',
                nom: lead.nom,
                prenom: lead.prenom,
                email: lead.email,
                telephone: lead.telephone || lead.telephone_portable,
                adresse_brute: `${lead.adresse || ''} ${lead.code_postal || ''} ${lead.ville || ''}`.trim(),
                code_postal: lead.code_postal,
                ville: lead.ville,
                departement: lead.departement,
                // Statut par défaut
                statut_client: 'NON_PLANIFIÉ',
                nb_led: 0, // A définir selon champs métier Qhare si dispo
                chauffage: lead.chauffage,
                commentaire: `Import Qhare ID: ${lead.id}`
            };

            const { error } = await supabase.from('clients').insert(newClient);
            if (error) {
                console.error("Erreur Insert Supabase:", error.message);
            } else {
                newCount++;
            }
        }

        if (newCount > 0) {
            console.log(`✅ [Auto-Import] ${newCount} nouveaux clients importés !`);
        } else {
            console.log("💤 [Auto-Import] Aucun nouveau client.");
        }

    } catch (e) {
        console.error("❌ [Auto-Import] Erreur:", e.message);
    }
}

// Export pour être appelé par le serveur principal
export default function startAutoImport(intervalMinutes = 10) {
    console.log(`🚀 Démarrage tâche de fond : Import Qhare toutes les ${intervalMinutes} min.`);

    // Premier run immédiat (après 5s pour laisser le serveur boot)
    setTimeout(syncQhareToPanel, 5000);

    // Intervalle
    setInterval(syncQhareToPanel, intervalMinutes * 60 * 1000);
}
