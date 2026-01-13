
Pour basculer sur Qhare CRM et abandonner Google Sheets, voici la procédure :

1.  **Tester la connexion**
    J'ai créé un script de test. Lancez cette commande dans votre terminal :
    `node scripts/test_qhare.js`
    
    Si cela affiche "Succès" et un ID, la connexion fonctionne.

2.  **Migrer vos clients existants**
    J'ai préparé un script "intelligent" qui va prendre tous vos clients actuels dans le panel et les envoyer vers Qhare un par un.
    Lancez :
    `node scripts/migrate_to_qhare.js`
    
    *Ce script crée un fichier `migration_qhare_log.json` pour se souvenir de ce qui a été fait (vous pouvez donc l'arrêter et le relancer sans tout dupliquer).*

3.  **Prochaine étape (Integration Totale)**
    Une fois la migration faite, je pourrai modifier le logiciel pour qu'il ne lise plus le Google Sheet mais directement votre compte Qhare.
