# 📋 CAHIER DES CHARGES - PROJET PANEL PAC (Pompe à Chaleur)

## 1. CONTEXTE ET OBJECTIFS

### 1.1 Contexte
Le projet consiste à **dupliquer et adapter** l'architecture logicielle existante du "Panel LED" (Arkos Logistics) pour créer une solution dédiée à la gestion des **Pompes à Chaleur (PAC)**.

La solution actuelle a fait ses preuves sur la logistique des LEDs (gestion de stock, livraisons, installations, rapports). L'objectif est de capitaliser sur cette base technique tout en intégrant les spécificités métiers des PAC (matériel volumineux, numéros de série, fluides frigorigènes, CERFA).

### 1.2 Objectifs Principaux
1.  **Centraliser** les dossiers clients PAC (de la vente à la mise en service).
2.  **Planifier** efficacement les équipes (livreurs et techniciens frigoristes).
3.  **Tracer** le matériel (gestion strict des numéros de série et garanties).
4.  **Simplifier** le terrain (Application mobile pour validation livraison et PV de mise en service).
5.  **Reporter** l'activité (Suivi des chantiers, consommation de stock).

---

## 2. STACK TECHNIQUE (Architecture)
Nous conservons l'architecture moderne et performante du Panel LED.

*   **Frontend Web & Mobile** : React (Vite), TypeScript, Tailwind CSS, Shadcn UI.
*   **Base de Données & Backend** : Supabase (PostgreSQL, Realtime, Auth).
*   **Cartographie** : Leaflet / Mapbox (Optimisation de tournées).
*   **Authentification** : Gestion des rôles (Admin, Dispatch, Livreur, Technicien).
*   **Hébergement** : Vercel / Netlify.
*   **Support Offline** : PWA (Progressive Web App) avec synchronisation (via `dexie.js` ou équivalent comme déjà implémenté).

---

## 3. FONCTIONNALITÉS CŒUR (ADAPTATION LED -> PAC)

### 3.1 Gestion des Clients et Chantiers
| Feature Panel LED | Adaptation Panel PAC |
| :--- | :--- |
| **Fiche Client** | Identique (Nom, Adresse, Tél, Zone). |
| **Donnée Technique** | Remplacer "Nombre de LEDs" par **"Type de PAC"** (Air/Air, Air/Eau), **Puissance** (kW), **Marque/Modèle**. |
| **Statuts** | Ajout d'étapes critiques : *Visite Technique*, *Mise en Service*. |
| **Documents** | Ajout de section pour upload (Devis, Photos Visite Technique, CERFA). |

### 3.2 Gestion Logistique (Livraison)
*   **Planification** : Calendrier des livraisons (Gros volumes = moins de slots par camion que des LEDs).
*   **Feuille de Route** : Optimisation des tournées (Waze/Google Maps integration).
*   **Validation Livraison** :
    *   Signature électronique client.
    *   **SCAN OBLIGATOIRE** des numéros de série (Unité Intérieure + Unité Extérieure) via appareil photo mobile.
    *   Photo de la livraison (preuve de dépôt).

### 3.3 Gestion Technique (Installation & Mise en Service)
C'est la partie qui diffère le plus de la pose de LEDs simple.

*   **Planning Techniciens** : Gestion des compétences (Besoin d'un frigoriste certifié pour la mise en service ?).
*   **Rapport d'Intervention Mobile** :
    *   Checklist de conformité (Raccordements électriques, étanchéité, tirage au vide).
    *   Relevé des pressions / Températures.
    *   Validation de la mise en service.
    *   Signature du PV de réception.

### 3.4 Gestion de Stock Avancée
Contrairement aux LEDs (vrac/quantité), les PAC nécessitent une gestion unitaire.

*   **Stock par Dépôt** : (Semblable aux zones géographiques actuelles).
*   **Tracking Unitaire** : Chaque machine a un N° de Série unique. Entrée en stock -> Assignation Client -> Sortie.
*   **Alertes** : Seuil de réapprovisionnement par référence (ex: Manque de 12kW Split).

---

## 4. STRUCTURE DE DONNÉES (Ébauche Schéma BDD)

### Table `clients_pac` (Evolution de `clients`)
```sql
CREATE TABLE clients_pac (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Info Client Basic
  nom TEXT,
  prenom TEXT,
  adresse_complete TEXT,
  telephone TEXT,
  email TEXT,
  zone_geo TEXT, -- 'FR', 'IDF', 'SUD', etc.

  -- Info Technique PAC
  type_installation TEXT, -- 'AIR_EAU', 'AIR_AIR', 'BALLON_THERMO'
  marque_ref TEXT,        -- ex: 'DAIKIN ALTHERMA 3'
  puissance_kw NUMERIC,   -- ex: 12.5
  
  -- Numéros de Série (Remplis à la livraison/install)
  serial_unite_ext TEXT,
  serial_unite_int TEXT,

  -- Statuts
  statut_dossier TEXT, -- 'RDV_PRIS', 'VISITE_TECH_OK', 'LIVRE', 'INSTALLE', 'EN_SERVICE'
  
  -- Planning
  date_visite_tech TIMESTAMPTZ,
  date_livraison TIMESTAMPTZ,
  livreur_id UUID,
  date_installation_debut TIMESTAMPTZ,
  date_installation_fin TIMESTAMPTZ,
  equipe_id UUID
);
```

### Table `stock_pac`
```sql
CREATE TABLE stock_pac (
  id UUID PRIMARY KEY,
  modele TEXT,
  type TEXT, -- 'UI' (Unité Intérieure), 'UE' (Unité Extérieure)
  quantite_dispo INTEGER,
  seuil_alerte INTEGER,
  depot_localisation TEXT
);
```

---

## 5. USER STORIES (SCÉNARIOS UTILISATEURS)

### Scénario 1 : Le Dispatcher (Bureau)
> "Je reçois un dossier validé. Je vérifie le stock de la machine demandée (Daikin 12kW). Je planifie la livraison pour le camion A mardi, et l'équipe de pose B pour mercredi/jeudi."

### Scénario 2 : Le Livreur (Mobile)
> "J'arrive chez le client. Je décharge la palette. Je scanne le code barre du carton pour confirmer que c'est bien la bonne machine. Je fais signer le client sur mon téléphone. La photo et les numéros de série remontent instantanément au bureau."

### Scénario 3 : Le Technicien (Mobile)
> "Je finis l'installation. Sur l'app, je coche 'Tirage au vide OK', je rentre la quantité de fluide rajoutée (si besoin). Je valide la mise en service. Un email 'Bienvenue' part au client avec sa garantie activée."

---

## 6. LIVRABLES ATTENDUS
1.  **Code Source** : Repository Git complet (similaire à Panel LED).
2.  **Base de Données** : Scripts SQL Supabase adaptés.
3.  **Application Web** : Dashboard Admin/Dispatch.
4.  **Application PWA** : Interface simplifiée pour Livreurs/Techs.
5.  **Documentation** : Guide de déploiement.
