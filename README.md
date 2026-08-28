# DPE-X402

**API française sur les diagnostics de performance énergétique (DPE), monétisée en USDC via le protocole x402 pour les agents IA autonomes.**

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://dpe.bdatax.com)
[![Network](https://img.shields.io/badge/network-base--mainnet-blue)](https://basescan.org)
[![x402](https://img.shields.io/badge/x402-enabled-A05A2C)](https://x402.org)
[![Version](https://img.shields.io/badge/version-0.7.1-informational)](./CHANGELOG.md)

> 🌐 **URL de production** : https://dpe.bdatax.com
> 📄 **Découverte automatique** : https://dpe.bdatax.com/.well-known/x402.json

---

## Ce que fait cette API

Interrogation intelligente de la base publique [ADEME](https://data.ademe.fr) sur les DPE (Diagnostics de Performance Énergétique) en France, avec :

- **7 modes de recherche** : adresse libre, code postal, GPS, numéro DPE, identifiant BAN, etc.
- **Géocodage automatique** via l'API [BAN](https://adresse.data.gouv.fr) (avec sélection stricte pour éviter les faux positifs)
- **Enrichissement DVF** *(v0.7.0)* : chaque résultat est complété par une estimation de valeur marchande basée sur les transactions immobilières réelles publiées par la DGFiP (prix médian €/m², estimation totale, nombre de comparables, date de la dernière transaction du quartier)
- **Enrichissement Géorisques** *(v0.7.1)* : chaque résultat est enrichi de la synthèse des risques naturels et technologiques de la commune (inondation, séisme, radon, retrait-gonflement argile, mouvement de terrain, ICPE, canalisations matières dangereuses, pollution des sols…), servie par l'API officielle Géorisques (BRGM + Ministère Transition écologique)
- **Scoring intelligent** de la pertinence de chaque résultat
- **Déduplication et classement multi-critères** (score, surface, date)
- **3 formats d'export** : JSON (défaut), CSV, XLSX
- **Paiement à la requête** via le protocole x402 (HTTP 402) sur **Base mainnet** — **~0,001 USDC par appel**

Conçu pour être utilisé par des **agents IA autonomes** qui payent en crypto sans intervention humaine (Machine Economy), mais aussi utilisable directement par un humain avec `curl` ou un navigateur.

---

## Quick start

### 1. Voir ce que l'API expose (gratuit)

```bash
curl https://dpe.bdatax.com/
```

### 2. Interroger l'API sans payer (renvoie 402)

```bash
curl -i "https://dpe.bdatax.com/dpe?cp=75001"
```

Réponse :

```
HTTP/1.1 402 Payment Required
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxAmountRequired": "1000",
    "payTo": "0xc0a484b32798dEefcA38Ced6c6Aa780660c752A4"
  }]
}
```

### 3. Payer et récupérer les DPE (avec un client x402)

Voir [`test-client.js`](./test-client.js) pour un exemple complet en Node.js utilisant [`x402-fetch`](https://www.npmjs.com/package/x402-fetch) et [`viem`](https://viem.sh).

---

## Endpoints disponibles

| Endpoint | Prix | Description |
|---|---|---|
| `GET /` | Gratuit | Page d'accueil, liste des endpoints |
| `GET /.well-known/x402.json` | Gratuit | Fichier de découverte pour crawlers x402 |
| `GET /dpe?cp=75001` | 0,001 USDC | Recherche par code postal |
| `GET /dpe?adresse=203 rue Saint-Honoré 75001 Paris` | 0,001 USDC | Recherche par adresse libre |
| `GET /dpe?voie=Saint-Honoré&cp=75001` | 0,001 USDC | Recherche par nom de rue |
| `GET /dpe?numero=203&voie=Saint-Honoré&cp=75001` | 0,001 USDC | Recherche par numéro + rue + CP |
| `GET /dpe?numeroDPE=2175E0465600P` | 0,001 USDC | Recherche par identifiant DPE |
| `GET /dpe?lat=48.864968&lon=2.331665` | 0,001 USDC | Recherche par coordonnées GPS |
| `GET /dpe?cp=75001&format=csv` | 0,001 USDC | Export CSV (compatible Excel FR) |
| `GET /dpe?cp=75001&format=xlsx` | 0,001 USDC | Export Excel natif |

Chaque appel `/dpe` renvoie un JSON structuré avec `meilleurResultat`, `resultats` (tableau classé), `dpeLePlusRecent`, et des métadonnées de recherche.

---

## Enrichissement DVF *(nouveau en v0.7.0)*

Chaque DPE renvoyé est automatiquement enrichi (sans surcoût) avec des données de marché immobilier issues de la base publique **DVF** (Demandes de Valeurs Foncières, DGFiP) :

```json
{
  "adresse": "14 rue Vauvilliers 75001 Paris",
  "etiquetteDPE": "F",
  "surfaceM2": 22.9,
  "coutAnnuelTotal": 1168,
  "dvf": {
    "prixMedianM2": 12400,
    "prixEstimeTotal": 283960,
    "nbTransactionsComparables": 8,
    "derniereTransaction": "2025-11-14",
    "rayonMetres": 200,
    "ecartSurfacePct": 30
  }
}
```

**Méthode** : pour chaque DPE géolocalisé, on cherche dans un rayon de 200 m les transactions immobilières récentes (2024-2025), du même type (appartement / maison), avec une surface comparable (±30 %). On calcule ensuite la médiane des prix au m² et on l'applique à la surface du DPE.

`dvf` vaut `null` si l'échantillon est trop faible (moins de 3 transactions comparables) ou si le département n'est pas encore indexé — le champ apparaît toujours pour que les consommateurs de l'API puissent tester sa présence de façon uniforme.

**Couverture** : France entière (métropole + DROM), transactions publiées jusqu'à la dernière mise à jour semestrielle DGFiP.

**Mise à jour de l'index DVF** : deux fois par an (avril et octobre), en lançant localement `node build-dvf-index.js` après avoir téléchargé le nouveau fichier `full.csv.gz` depuis [data.gouv.fr](https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/), puis en pushant `data/dvf/`.

---

## Enrichissement Géorisques *(nouveau en v0.7.1)*

Chaque DPE renvoyé est aussi enrichi (sans surcoût pour l'utilisateur) avec une synthèse des risques naturels et technologiques qui pèsent sur sa commune, via l'API officielle **Géorisques** maintenue par le BRGM et le Ministère de la Transition écologique :

```json
{
  "adresse": "203 Rue Saint-Honoré 75001 Paris",
  "etiquetteDPE": "F",
  "codeInsee": "75101",
  "georisques": {
    "commune": "PARIS 1ER ARRONDISSEMENT",
    "codeInsee": "75101",
    "risquesNaturels": {
      "inondation": "existant",
      "seisme": "faible",
      "retraitGonflementArgile": "important",
      "radon": "faible",
      "mouvementTerrain": "existant",
      "remonteeNappe": "existant"
    },
    "risquesTechnologiques": {
      "icpe": "concerne",
      "canalisationsMatieresDangereuses": "concerne",
      "pollutionSols": "concerne"
    },
    "nbRisquesPresents": 9,
    "sourceUrl": "https://www.georisques.gouv.fr/mes-risques/..."
  }
}
```

**Méthode** : le code INSEE de la commune est dérivé du champ `identifiantBAN` du DPE, puis on interroge l'endpoint `/api/v1/resultats_rapport_risque` de Géorisques. La réponse est mise en cache 24 h en RAM par code INSEE — même 1000 DPE dans une même commune ne génèrent qu'**un seul appel API par jour**.

`georisques` vaut `null` si le codeInsee n'a pas pu être dérivé (DPE sans identifiantBAN), si l'API Géorisques répond en erreur, ou si le timeout de 5 s est dépassé. Comportement gracieux : les autres champs de la réponse (DPE + DVF) restent servis normalement.

**Cas d'usage typique** : assureurs (calcul de prime), banques (analyse de risque de crédit immobilier), plateformes de tokenisation immobilière (due diligence automatisée), agents IA immobiliers autonomes.

---

## Utilisation avec un client Node.js

Installation :

```bash
npm install x402-fetch viem
```

Utilisation :

```javascript
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPayment(fetch, account, BigInt(10_000));

const response = await fetchWithPayment(
  "https://dpe.bdatax.com/dpe?cp=75001"
);
const data = await response.json();
console.log(data.meilleurResultat);
```

Un exemple complet et commenté est disponible dans [`test-client.js`](./test-client.js).

Pour tester, il faut :
1. Un wallet EVM avec quelques centimes d'USDC sur **Base mainnet** (bridge depuis Arbitrum, Ethereum, ou achat direct sur Coinbase)
2. Créer un fichier `client.env` avec `PRIVATE_KEY=...` (jamais commit !)
3. Lancer : `node --env-file=client.env test-client.js`

---

## Architecture

Pipeline en 11 étapes pour chaque requête `/dpe` :

1. Middleware x402 (paiement)
2. Extraction des critères de recherche
3. Analyse automatique de l'adresse (regex)
4. Géocodage inverse BAN (GPS → adresse)
5. Géocodage direct BAN (adresse → GPS, avec validation stricte CP/ville)
6. Requêtes ADEME parallélisées (Promise.all)
7. Scoring de chaque DPE (barème calibré)
8. Déduplication et classement multi-critères
9. **Enrichissement DVF** — pour chaque résultat, lookup local des transactions immobilières comparables (cache LRU en mémoire)
10. **Enrichissement Géorisques** — appel API `/resultats_rapport_risque` par code INSEE (cache RAM 24 h)
11. Sortie au format demandé (JSON/CSV/XLSX)

Temps de réponse typique : **< 800 ms** (l'appel Géorisques ajoute ~200-400 ms au premier appel par commune, ensuite servi depuis le cache).

---

## Roadmap

- **v0.7.0** ✅ Enrichissement DVF (transactions immobilières, prix médian €/m²)
- **v0.7.1** ✅ Enrichissement Géorisques (inondation, sismique, radon, pollutions, ICPE, argile…)
- **v0.7.2** : Enrichissement INSEE IRIS (revenu médian, densité, catégorie socio-pro)
- **v0.8.x** : Scores propriétaires (rénovation, confort d'été, attractivité globale)
- **v0.9.x** : Endpoint `/dpe/enrichi` à tarif différencié (~0,02 USDC)
- **v1.0** : Consolidation, SLA public, dashboards partenaires

---

## Attribution

- Données DPE : [ADEME](https://data.ademe.fr) — Open Data
- Données de valeurs foncières (DVF) : [DGFiP / Etalab](https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/) — Open Data
- Risques naturels et technologiques : [Géorisques](https://www.georisques.gouv.fr) — BRGM et Ministère de la Transition écologique
- Géocodage : [Base Adresse Nationale](https://adresse.data.gouv.fr) — Open Data
- Protocole de paiement : [x402](https://x402.org) — standard HTTP 402 poussé par Coinbase

---

## Stack

- **Runtime** : Node.js + [Express 5](https://expressjs.com)
- **Paiement** : [x402-express](https://www.npmjs.com/package/x402-express) sur [Base](https://base.org)
- **Export Excel** : [SheetJS](https://sheetjs.com)
- **Hébergement** : [Render.com](https://render.com) (Frankfurt)
- **DNS** : [Cloudflare](https://cloudflare.com)

---

## Marque

[**BData X**](https://bdatax.com) — Portfolio d'APIs françaises monétisées x402 sur données publiques.

---

## Licence

Ce projet est distribué sous **Business Source License 1.1** (BSL) — voir [`LICENSE`](./LICENSE).

**En résumé** :

- ✅ Tu peux **étudier, forker, modifier** le code librement
- ✅ Tu peux l'utiliser pour tes projets **personnels ou internes**
- ✅ Tu peux **contribuer** via des pull requests
- ❌ Tu ne peux **PAS** en faire une **SaaS commercial concurrent** de dpe.bdatax.com

Le **27 août 2030**, cette licence bascule automatiquement en **Apache 2.0** (totalement libre).

Pour un usage commercial concurrent avant cette date, contact via le repo.
