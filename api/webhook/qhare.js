
import { createClient } from '@supabase/supabase-js';

// Configuration Supabase (En dur pour Vercel)
const supabaseUrl = "https://hldxvcwowkltwznumqsd.supabase.co";
const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhsZHh2Y3dvd2tsdHd6bnVtcXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU4MzU0NjUsImV4cCI6MjA1MTQxMTQ2NX0.v1o_1Lg9sM0tK4_4y3_2w5y6u7v8x9z0A1B2C3D4E5";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default async function handler(req, res) {
    // CORS pour être gentil (même si Qhare s'en fiche)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const lead = req.body;

        console.log("📥 [Webhook Vercel] Reçu:", lead ? lead.nom : "Vide");

        if (!lead || (!lead.nom && !lead.id)) {
            return res.status(400).json({ error: "Payload invalide" });
        }

        // 1. FILTRE "SIGNÉ"
        const etat = (lead.etat || '').toUpperCase();
        const estSigne = etat.includes('SIGNÉ') || etat.includes('SIGNE') || etat.includes('VALID'); // J'élargis un peu au cas où

        if (!estSigne) {
            return res.status(200).json({ status: 'ignored', reason: 'not_signed', etat_recu: etat });
        }

        // 2. INSERTION SUPABASE
        // Mapping des données
        const newClient = {
            source: 'Qhare Webhook (Vercel)',
            nom: lead.nom,
            prenom: lead.prenom,
            email: lead.email,
            telephone: lead.telephone || lead.telephone_portable,
            adresse_brute: `${lead.adresse || ''} ${lead.code_postal || ''} ${lead.ville || ''}`.trim(),
            code_postal: lead.code_postal,
            ville: lead.ville,
            departement: lead.departement,
            statut_client: 'NON_PLANIFIÉ',
            nb_led: 0,
            chauffage: lead.chauffage,
            commentaire: `Import Webhook ID: ${lead.id}`
        };

        // Upsert (Insert ou Update si email existe)
        const { data, error } = await supabase
            .from('clients')
            .upsert(newClient, { onConflict: 'email' })
            .select()
            .single();

        if (error) {
            console.error("Erreur Supabase:", error);
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ status: 'success', id: data.id, client: data.nom });

    } catch (e) {
        console.error("Erreur Handler:", e);
        return res.status(500).json({ error: e.message });
    }
}
