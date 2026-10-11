# Cap Nord — carnet de route

App web installable (PWA), gratuite, sans compte, qui marche hors-ligne. Tout est stocké sur l'appareil (IndexedDB).

## Lancer sur l'ordinateur
```bash
cd ~/Desktop/Claude/VOYAGE && python3 -m http.server 5173
```
Puis ouvrir http://localhost:5173 (ou http://localhost:5173/phone.html pour l'aperçu au format téléphone)

## Mettre l'app sur le téléphone
Le GPS du navigateur ne fonctionne qu'en **HTTPS**. Le plus simple :
1. Aller sur https://app.netlify.com/drop et glisser le dossier `VOYAGE` → vous obtenez une adresse `https://…netlify.app`
   (ou GitHub Pages).
2. L'ouvrir sur le téléphone, puis l'installer :
   - iPhone : Safari → Partager → « Sur l'écran d'accueil »
   - Android : Chrome → ⋮ → « Installer l'application »

Les données ne quittent jamais l'appareil. Pour passer d'un appareil à l'autre : Réglages → Tout exporter / Importer.

## Services gratuits utilisés (sans clé)
OpenStreetMap (carte + recherche de lieux), OSRM (routes), Open-Meteo (météo), Frankfurter (taux de change), Esri (satellite).

## Limite à connaître
Comme toute app web, le suivi GPS s'interrompt quand l'écran est verrouillé (surtout sur iPhone).
Activez « Garder l'écran allumé » dans l'onglet Live pendant les trajets.
