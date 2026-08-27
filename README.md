# DPE-X402

**API française sur les diagnostics de performance énergétique (DPE), monétisée en USDC via le protocole x402 pour les agents IA autonomes.**

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://dpe.bdatax.com)
[![Network](https://img.shields.io/badge/network-base--sepolia-blue)](https://sepolia.basescan.org)
[![x402](https://img.shields.io/badge/x402-enabled-A05A2C)](https://x402.org)

> 🌐 **URL de production** : https://dpe.bdatax.com
> 📄 **Découverte automatique** : https://dpe.bdatax.com/.well-known/x402.json

---

## Ce que fait cette API

Interrogation intelligente de la base publique [ADEME](https://data.ademe.fr) sur les DPE (Diagnostics de Performance Énergétique) en France, avec :

- **7 modes de recherche** : adresse libre, code postal, GPS, numéro DPE, identifiant BAN, etc.
- **Géocodage automatique** via l'API [BAN](https://adresse.data.gouv.fr) (avec sélection stricte pour éviter les faux positifs)
- **Scoring intelligent** de la pertinence de chaque résultat
- **Déduplication et classement multi-critères** (score, surface, date)
- **3 formats d'export** : JSON (défaut), CSV, XLSX
- **Paiement à la requête** via le protocole x402 (HTTP 402) sur Base Sepolia — **~0,001 USDC par appel**

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
    "network": "base-sepolia",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "maxAmountRequired": "1000",
    "payTo": "0x891f3EE754Fac3ECd9e125c3e9317099468A1E7E"
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
1. Un wallet EVM avec de l'USDC sur Base Sepolia (faucet : https://faucet.circle.com/)
2. Créer un fichier `client.env` avec `PRIVATE_KEY=...` (jamais commit !)
3. Lancer : `node --env-file=client.env test-client.js`

---

## Architecture

Pipeline en 9 étapes pour chaque requête `/dpe` :

1. Middleware x402 (paiement)
2. Extraction des critères de recherche
3. Analyse automatique de l'adresse (regex)
4. Géocodage inverse BAN (GPS → adresse)
5. Géocodage direct BAN (adresse → GPS, avec validation stricte CP/ville)
6. Requêtes ADEME parallélisées (Promise.all)
7. Scoring de chaque DPE (barème calibré)
8. Déduplication et classement multi-critères
9. Sortie au format demandé (JSON/CSV/XLSX)

Temps de réponse typique : **< 500 ms**.

---

## Roadmap

- **v0.7.x** : Enrichissement DVF (prix de vente réels) + Géorisques + INSEE
- **v0.8.x** : Scores propriétaires (rénovation, confort d'été, attractivité globale)
- **v0.9.x** : Endpoint `/dpe/enrichi` à tarif différencié (~0,02 USDC)
- **v1.0** : Passage en Base Mainnet, production commerciale

---

## Attribution

- Données DPE : [ADEME](https://data.ademe.fr) — Open Data
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
