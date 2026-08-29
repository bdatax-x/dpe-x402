import express from "express";
import * as XLSX from "xlsx";
import { paymentMiddleware } from "x402-express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// Nécessaire pour que req.protocol renvoie 'https' quand on est
// derrière le proxy Cloudflare/Render (qui termine le SSL et
// transmet en HTTP interne). Sans ça, le champ 'resource' dans
// la réponse 402 renvoie http:// au lieu de https://.
app.set("trust proxy", true);

// ============================================================================
// CORS OUVERT
//
// Les crawlers de découverte agentique (x402scan, Agentic.Market, etc.)
// lisent nos endpoints publics depuis leur propre navigateur, souvent
// depuis un origin différent. Sans CORS ouvert, ils reçoivent le contenu
// mais ne peuvent pas l'interpréter côté client. On expose donc les
// headers CORS de base sur toutes les routes.
// ============================================================================

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-PAYMENT, Authorization"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Payment-Response, X-PAYMENT-Response"
  );
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// ============================================================================
// TRANSFORMATION x402 v1 -> v2 (au vol)
//
// Le package x402-express@1.2.0 émet ses réponses 402 au format x402 v1
// (champ maxAmountRequired, x402Version=1). Les crawlers modernes de
// découverte agentique comme x402scan.com n'indexent que les APIs qui
// répondent au format v2 (champ amount, x402Version=2).
//
// On intercepte donc res.json() pour transformer la structure à la volée
// sur les seules réponses 402. Le reste du fonctionnement de x402-express
// (parsing du header X-PAYMENT, vérification via facilitator, settlement
// on-chain) reste strictement identique — on ne touche qu'à la carte
// d'exigences renvoyée au client.
// ============================================================================

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (
      res.statusCode === 402 &&
      body &&
      body.x402Version === 1 &&
      Array.isArray(body.accepts)
    ) {
      body = {
        ...body,
        x402Version: 2,
        accepts: body.accepts.map((entree) => {
          const { maxAmountRequired, ...reste } = entree;
          return {
            ...reste,
            amount: maxAmountRequired
          };
        })
      };
    }
    return originalJson(body);
  };
  next();
});

// ============================================================================
// FAVICON — petit SVG inline
//
// Suggéré par x402scan pour l'affichage d'une icône marchand.
// SVG minimal auto-suffisant : carré vert BData X avec un "X" blanc.
// ============================================================================

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="6" fill="#2D5F3D"/>' +
  '<text x="16" y="22" font-family="Arial, sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="#FFFFFF">X</text>' +
  '</svg>';

app.get("/favicon.ico", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(FAVICON_SVG);
});

// ============================================================================
// /llms.txt — convention pour crawlers IA
//
// llms.txt est une convention proposée par Jeremy Howard pour donner aux
// modèles de langage (ChatGPT, Claude, Perplexity, Gemini, etc.) un
// contexte structuré sur un site, lu au moment où un agent cherche à le
// citer ou l'utiliser. Format : Markdown court à la racine du domaine.
//
// Notre /llms.txt annonce : ce qu'est DPE-X402, ce qu'il renvoie, comment
// l'appeler, où trouver la spec machine-lisible, les sources publiques
// utilisées, et le protocole de paiement.
// ============================================================================

const LLMS_TXT_CONTENU = `# DPE-X402

> French Energy Performance Certificate API, enriched with real estate valuation (DVF) and territorial risks (Géorisques), monetized per-request via x402 micropayments on Base mainnet.

DPE-X402 crosses four public French datasets in one paid API call: energy performance certificates (ADEME), real estate transactions (DGFiP/DVF), natural and technological risks (BRGM/Géorisques) and address geocoding (BAN/IGN).

For each search, returns matching DPE records with automatically computed market value estimates (median €/m² of the neighborhood, based on comparable transactions within 200m and ±30% surface) and commune-level risk synthesis. Ideal for autonomous AI agents in real estate, insurance, credit scoring, and real estate tokenization use cases.

Payment: ~0.001 USDC per call via HTTP 402 (x402 v2) on Base mainnet. No account, no API key required — the payment is signed automatically by any x402-compatible client.

## Machine-readable specs

- [OpenAPI 3.1 spec](https://dpe.bdatax.com/openapi.json): full contract with endpoints, parameters, responses, x-payment-info
- [x402 discovery](https://dpe.bdatax.com/.well-known/x402.json): x402 protocol metadata for autonomous agents

## Endpoints

- [GET /dpe](https://dpe.bdatax.com/dpe?cp=75001): search DPE records enriched with DVF + Géorisques. Query by cp, adresse, voie, numero, ville, numeroDPE, lat/lon, or identifiantBAN. Returns JSON, CSV, or XLSX via ?format=.

## Example calls

- \`GET /dpe?cp=75001\` — DPE in Paris 1st arrondissement
- \`GET /dpe?adresse=203 rue Saint-Honoré 75001 Paris\` — free-form address search
- \`GET /dpe?lat=48.864968&lon=2.331665\` — GPS coordinates
- \`GET /dpe?numeroDPE=2175E0465600P\` — direct DPE ID lookup
- \`GET /dpe?cp=75001&format=csv\` — export CSV compatible with French Excel

## Response fields

Each result includes: numeroDPE, adresse, codePostal, codeInsee, surfaceM2, etiquetteDPE (A-G), etiquetteGES (A-G), coutAnnuelTotal (annual heating cost EUR), latitude, longitude, and two enrichment blocks:

- \`dvf\` — { prixMedianM2, prixEstimeTotal, nbTransactionsComparables, derniereTransaction, rayonMetres, ecartSurfacePct }
- \`georisques\` — { commune, codeInsee, risquesNaturels (inondation, seisme, radon, retraitGonflementArgile, mouvementTerrain, remonteeNappe…), risquesTechnologiques (icpe, canalisationsMatieresDangereuses, pollutionSols…), nbRisquesPresents, sourceUrl }

Both blocks return null when the enrichment has insufficient data (fewer than 3 comparable DVF transactions in radius, or no derivable INSEE code for Géorisques). The API is honest about uncertainty rather than guessing.

## Documentation

- [GitHub repository](https://github.com/bdatax-x/dpe-x402): source code, README, examples, license (BSL 1.1, converts to Apache 2.0 in 2030)
- [data.gouv.fr API listing](https://www.data.gouv.fr/dataservices/dpe-x402): official French public data portal listing with Swagger UI
- [data.gouv.fr reuse](https://www.data.gouv.fr/reuses/dpe-x402-api-donnees-immobilieres-francaises-pour-agents-ia): cross-reference on French data portal

## Data sources (all Open Data / Licence Ouverte)

- ADEME DPE (10.4M records): https://data.ademe.fr
- DGFiP DVF geolocalized (1.67M transactions 2024-2025 indexed): https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/
- BRGM Géorisques (natural + technological risks per commune): https://www.georisques.gouv.fr
- IGN Base Adresse Nationale (geocoding): https://adresse.data.gouv.fr

## Payment technology

- Protocol: x402 v2 (HTTP 402 Payment Required extension championed by Coinbase)
- Blockchain: Base mainnet (Ethereum L2)
- Asset: USDC — contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Client library example: [x402-fetch](https://www.npmjs.com/package/x402-fetch) for Node.js

## Provider

BData X — portfolio of French public data APIs monetized via x402 for the machine economy.

## Optional

- [x402 protocol](https://github.com/x402-foundation/x402): open standard for AI agent micropayments
- [Base blockchain](https://base.org): Ethereum L2 by Coinbase
- [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence): French Open Licence covering the upstream public datasets
`;

app.get("/llms.txt", (req, res) => {
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(LLMS_TXT_CONTENU);
});

// ============================================================================
// MIDDLEWARE DE PAIEMENT X402
//
// Protège les routes listées en exigeant un paiement en USDC via le
// protocole x402 (HTTP 402 Payment Required). Les autres routes restent
// gratuites.
//
// Configuration dans .env :
//   RECEIVER_ADDRESS  -> ton wallet qui reçoit les paiements
//   NETWORK           -> base-sepolia (test) ou base (production)
//   FACILITATOR_URL   -> service qui vérifie les paiements
//   PRICE_USDC        -> prix par requête, ex: "$0.001"
// ============================================================================

const RECEIVER_ADDRESS =
  process.env.RECEIVER_ADDRESS;

const NETWORK =
  process.env.NETWORK || "base-sepolia";

const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";

const PRICE_USDC =
  process.env.PRICE_USDC || "$0.001";

if (RECEIVER_ADDRESS) {

  console.log(
    `x402 activé : ${PRICE_USDC} sur ${NETWORK} vers ${RECEIVER_ADDRESS}`
  );

  app.use(
    paymentMiddleware(
      RECEIVER_ADDRESS,
      {
        "GET /dpe": {
          price: PRICE_USDC,
          network: NETWORK
        }
      },
      {
        url: FACILITATOR_URL
      }
    )
  );

} else {

  console.log(
    "x402 désactivé (RECEIVER_ADDRESS non défini dans .env) - toutes les routes sont gratuites"
  );

}

const ADEME_URL =
  "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";

const BAN_URL =
  "https://api-adresse.data.gouv.fr";

// ============================================================================
// NORMALISATION
// ============================================================================

function normaliser(texte) {
  if (texte === null || texte === undefined) return "";

  return String(texte)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2019']/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// NORMALISATION DE RUE
//
// Comme normaliser(), mais retire aussi les types de voie génériques (rue,
// avenue, boulevard, etc.) pour que "Saint-Honoré" corresponde parfaitement
// à "Rue Saint-Honoré". Ne pas utiliser pour comparer des adresses complètes
// ou des villes — uniquement pour comparer un nom de rue.
// ============================================================================

const TYPES_DE_VOIE = new Set([
  "rue",
  "avenue",
  "av",
  "ave",
  "boulevard",
  "boul",
  "bd",
  "bld",
  "place",
  "pl",
  "impasse",
  "imp",
  "chemin",
  "ch",
  "route",
  "rte",
  "allee",
  "all",
  "quai",
  "cours",
  "voie",
  "square",
  "sq",
  "passage",
  "pass",
  "villa",
  "cite",
  "rond",
  "point",
  "sente",
  "sentier",
  "faubourg",
  "fbg"
]);

function normaliserRue(texte) {
  const base = normaliser(texte);

  if (!base) return "";

  return base
    .split(" ")
    .filter(
      (mot) => !TYPES_DE_VOIE.has(mot)
    )
    .join(" ")
    .trim();
}

// ============================================================================
// EXTRACTION DE LA RECHERCHE
// ============================================================================

function construireRecherche(req) {
  const adresse = req.query.adresse ?? null;
  const cp = req.query.cp ?? null;
  const ville = req.query.ville ?? null;
  const voie = req.query.voie ?? req.query.rue ?? null;
  const numero = req.query.numero ?? req.query.numeroVoie ?? null;
  const numeroDPE = req.query.numeroDPE ?? null;
  const identifiantBAN = req.query.identifiantBAN ?? null;

  const lat =
    req.query.lat !== undefined
      ? Number(req.query.lat)
      : null;

  const lon =
    req.query.lon !== undefined
      ? Number(req.query.lon)
      : req.query.lng !== undefined
        ? Number(req.query.lng)
        : null;

  const rayon =
    req.query.rayon !== undefined
      ? Number(req.query.rayon)
      : 100;

  const surface =
    req.query.surface !== undefined
      ? Number(req.query.surface)
      : null;

  return {
    adresse,
    cp,
    ville,
    voie,
    numero,
    numeroDPE,
    identifiantBAN,

    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,

    rayon: Number.isFinite(rayon) ? rayon : 100,

    surface:
      Number.isFinite(surface) && surface > 0
        ? surface
        : null
  };
}

// ============================================================================
// ANALYSE DE L'ADRESSE
// ============================================================================

function analyserAdresse(adresse) {
  if (!adresse) {
    return {
      numero: null,
      cp: null
    };
  }

  const texte = String(adresse);

  const cpMatch =
    texte.match(/\b(\d{5})\b/);

  const numeroMatch =
    texte.match(/^\s*(\d+[A-Za-z]?)\s+/i);

  return {
    numero:
      numeroMatch
        ? numeroMatch[1]
        : null,

    cp:
      cpMatch
        ? cpMatch[1]
        : null
  };
}

// ============================================================================
// DPE -> OBJET PROPRE
// ============================================================================

function nettoyerDPE(d) {
  let latitude = null;
  let longitude = null;

  if (d._geopoint) {
    const morceaux =
      String(d._geopoint).split(",");

    if (morceaux.length === 2) {
      latitude = Number(morceaux[0]);
      longitude = Number(morceaux[1]);

      if (!Number.isFinite(latitude)) {
        latitude = null;
      }

      if (!Number.isFinite(longitude)) {
        longitude = null;
      }
    }
  }

  return {
    numeroDPE:
      d.numero_dpe ?? null,

    date:
      d.date_etablissement_dpe ?? null,

    adresse:
      d.adresse_ban ??
      d.adresse_brut ??
      null,

    adresseBrute:
      d.adresse_brut ??
      null,

    numeroVoie:
      d.numero_voie_ban ??
      null,

    nomRue:
      d.nom_rue_ban ??
      null,

    ville:
      d.nom_commune_ban ??
      d.nom_commune_brut ??
      null,

    codePostal:
      d.code_postal_ban ??
      d.code_postal_brut ??
      null,

    departement:
      d.code_departement_ban ??
      null,

    typeBatiment:
      d.type_batiment ??
      null,

    surfaceM2:
      d.surface_habitable_logement ??
      d.surface_habitable_immeuble ??
      null,

    etiquetteDPE:
      d.etiquette_dpe ??
      null,

    etiquetteGES:
      d.etiquette_ges ??
      null,

    consoKwhM2An:
      d.conso_5_usages_par_m2_ep ??
      null,

    energieChauffage:
      d.type_energie_principale_chauffage ??
      null,

    anneeConstruction:
      d.annee_construction ??
      null,

    periodeConstruction:
      d.periode_construction ??
      null,

    coutAnnuelTotal:
      d.cout_total_5_usages ??
      null,

    coutChauffage:
      d.cout_chauffage ??
      null,

    latitude,
    longitude,

    idRNB:
      d.id_rnb ??
      null,

    identifiantBAN:
      d.identifiant_ban ??
      null,

    // Code INSEE de la commune. Sources par ordre de priorité :
    //   1. Champ direct ADEME (si présent)
    //   2. Les 5 premiers caractères de identifiantBAN qui suit
    //      le format "{codeInsee}_{voie}_{numero}" (ex: "75101_8635_00203")
    codeInsee:
      d.code_commune_ban ??
      d.code_insee_ban ??
      d.code_insee_commune_ban ??
      (
        d.identifiant_ban
          ? (() => {
              const morceaux = String(d.identifiant_ban).split("_");
              const insee = morceaux[0];
              // Format 5 chiffres OU corse (2A/2B suivis de 3 chiffres)
              if (/^\d{5}$/.test(insee) || /^2[AB]\d{3}$/.test(insee)) {
                return insee;
              }
              return null;
            })()
          : null
      ),

    dateFinValidite:
      d.date_fin_validite_dpe ??
      null
  };
}

// ============================================================================
// DISTANCE GPS
// ============================================================================

function distanceMetres(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371000;

  const p1 =
    (lat1 * Math.PI) / 180;

  const p2 =
    (lat2 * Math.PI) / 180;

  const dp =
    ((lat2 - lat1) * Math.PI) / 180;

  const dl =
    ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
      Math.cos(p2) *
      Math.sin(dl / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

// ============================================================================
// SCORE
// ============================================================================

function calculerScore(
  dpe,
  recherche
) {
  let score = 0;

  const adresseDPE =
    normaliser(dpe.adresse);

  const adresseBrute =
    normaliser(dpe.adresseBrute);

  const rueDPE =
    normaliserRue(dpe.nomRue);

  const villeDPE =
    normaliser(dpe.ville);

  const adresseRecherche =
    normaliser(recherche.adresse);

  const voieRecherche =
    normaliserRue(recherche.voie);

  const villeRecherche =
    normaliser(recherche.ville);

  // --------------------------------------------------------------------------
  // NUMERO DPE
  // --------------------------------------------------------------------------

  if (
    recherche.numeroDPE &&
    dpe.numeroDPE &&
    normaliser(dpe.numeroDPE) ===
      normaliser(recherche.numeroDPE)
  ) {
    score += 5000;
  }

  // --------------------------------------------------------------------------
  // IDENTIFIANT BAN
  // --------------------------------------------------------------------------

  if (
    recherche.identifiantBAN &&
    dpe.identifiantBAN &&
    normaliser(dpe.identifiantBAN) ===
      normaliser(recherche.identifiantBAN)
  ) {
    score += 4500;
  }

  // --------------------------------------------------------------------------
  // CODE POSTAL
  // --------------------------------------------------------------------------

  if (
    recherche.cp &&
    dpe.codePostal &&
    String(dpe.codePostal) ===
      String(recherche.cp)
  ) {
    score += 500;
  }

  // --------------------------------------------------------------------------
  // NUMERO
  // --------------------------------------------------------------------------

  if (
    recherche.numero &&
    dpe.numeroVoie &&
    normaliser(dpe.numeroVoie) ===
      normaliser(recherche.numero)
  ) {
    score += 1000;
  }

  // --------------------------------------------------------------------------
  // RUE
  // --------------------------------------------------------------------------

  if (voieRecherche) {
    if (rueDPE === voieRecherche) {
      score += 1000;
    } else if (
      rueDPE.includes(voieRecherche) ||
      voieRecherche.includes(rueDPE)
    ) {
      score += 600;
    }
  }

  // --------------------------------------------------------------------------
  // COMBO NUMERO + VOIE + CP
  //
  // Si les trois critères correspondent exactement, on ajoute un bonus
  // supplémentaire pour que ce résultat sorte nettement devant les matchs
  // partiels (ex: bon numéro et bonne rue mais mauvais CP, ou l'inverse).
  // --------------------------------------------------------------------------

  if (
    recherche.numero &&
    recherche.voie &&
    recherche.cp &&
    dpe.numeroVoie &&
    dpe.nomRue &&
    dpe.codePostal &&
    normaliser(dpe.numeroVoie) ===
      normaliser(recherche.numero) &&
    (
      rueDPE === voieRecherche ||
      rueDPE.includes(voieRecherche) ||
      voieRecherche.includes(rueDPE)
    ) &&
    String(dpe.codePostal) ===
      String(recherche.cp)
  ) {
    score += 2000;
  }

  // --------------------------------------------------------------------------
  // ADRESSE COMPLETE
  // --------------------------------------------------------------------------

  if (adresseRecherche) {
    if (
      adresseDPE ===
      adresseRecherche
    ) {
      score += 2500;

    } else if (
      adresseDPE.includes(
        adresseRecherche
      )
    ) {
      score += 1800;

    } else if (
      adresseBrute.includes(
        adresseRecherche
      )
    ) {
      score += 1500;
    }

    const morceaux =
      adresseRecherche.split(" ");

    for (const morceau of morceaux) {
      if (
        morceau.length >= 3 &&
        adresseDPE.includes(morceau)
      ) {
        score += 30;
      }
    }
  }

  // --------------------------------------------------------------------------
  // VILLE
  // --------------------------------------------------------------------------

  if (villeRecherche) {
    if (
      villeDPE ===
      villeRecherche
    ) {
      score += 500;

    } else if (
      villeDPE.includes(
        villeRecherche
      )
    ) {
      score += 300;
    }
  }

  // --------------------------------------------------------------------------
  // GPS
  // --------------------------------------------------------------------------

  if (
    recherche.lat !== null &&
    recherche.lon !== null &&
    dpe.latitude !== null &&
    dpe.longitude !== null
  ) {
    const distance =
      distanceMetres(
        recherche.lat,
        recherche.lon,
        dpe.latitude,
        dpe.longitude
      );

    if (
      distance <= recherche.rayon
    ) {
      score += Math.max(
        0,
        2000 - distance
      );
    }
  }

  return score;
}

// ============================================================================
// REQUETE ADEME
// ============================================================================

async function rechercherADEME(
  query,
  size = 100
) {
  const url =
    `${ADEME_URL}` +
    `?size=${encodeURIComponent(size)}` +
    `&q=${encodeURIComponent(query)}`;

  console.log(
    "ADEME :",
    query
  );

  // Timeout de 8 secondes : si l'ADEME est lente, on abandonne
  // proprement plutôt que de laisser l'agent client poireauter
  // (et partir sans payer).
  const response =
    await fetch(url, {
      signal: AbortSignal.timeout(8000)
    });

  if (!response.ok) {
    throw new Error(
      `ADEME HTTP ${response.status}`
    );
  }

  return await response.json();
}

// ============================================================================
// GEOCODAGE BAN
// ============================================================================

async function geocoderBAN(
  adresse,
  recherche
) {
  const url =
    `${BAN_URL}/search/` +
    `?q=${encodeURIComponent(adresse)}` +
    `&limit=5`;

  console.log(
    "BAN recherche :",
    adresse
  );

  const response =
    await fetch(url);

  if (!response.ok) {
    console.log(
      "BAN HTTP :",
      response.status
    );

    return null;
  }

  const data =
    await response.json();

  if (
    !data.features ||
    data.features.length === 0
  ) {
    console.log(
      "BAN : aucun résultat"
    );

    return null;
  }

  // ==========================================================================
  // SELECTION DU BON RESULTAT BAN
  // ==========================================================================

  const cpRecherche =
    normaliser(recherche.cp);

  const villeRecherche =
    normaliser(recherche.ville);

  const voieRecherche =
    normaliserRue(recherche.voie);

  const numeroRecherche =
    normaliser(recherche.numero);

  let meilleur = null;
  let meilleurScore = -1;

  for (const feature of data.features) {
    const properties =
      feature.properties ?? {};

    const coordinates =
      feature.geometry?.coordinates;

    if (
      !coordinates ||
      coordinates.length < 2
    ) {
      continue;
    }

    const postcode =
      normaliser(
        properties.postcode
      );

    const city =
      normaliser(
        properties.city
      );

    const street =
      normaliserRue(
        properties.street
      );

    const housenumber =
      normaliser(
        properties.housenumber
      );

    let score = 0;

    // CP
    if (
      cpRecherche &&
      postcode === cpRecherche
    ) {
      score += 1000;
    }

    // CP différent = rejet
    if (
      cpRecherche &&
      postcode &&
      postcode !== cpRecherche
    ) {
      continue;
    }

    // Ville
    if (
      villeRecherche &&
      city === villeRecherche
    ) {
      score += 500;
    }

    // Ville différente = rejet
    if (
      villeRecherche &&
      city &&
      city !== villeRecherche
    ) {
      continue;
    }

    // Rue
    if (
      voieRecherche &&
      street === voieRecherche
    ) {
      score += 400;
    } else if (
      voieRecherche &&
      (
        street.includes(
          voieRecherche
        ) ||
        voieRecherche.includes(street)
      )
    ) {
      score += 200;
    }

    // Numéro
    if (
      numeroRecherche &&
      housenumber === numeroRecherche
    ) {
      score += 500;
    }

    if (score > meilleurScore) {
      meilleurScore = score;

      meilleur = {
        longitude:
          Number(coordinates[0]),

        latitude:
          Number(coordinates[1]),

        label:
          properties.label ??
          null,

        postcode:
          properties.postcode ??
          null,

        city:
          properties.city ??
          null,

        street:
          properties.street ??
          null,

        housenumber:
          properties.housenumber ??
          null,

        id:
          properties.id ??
          null,

        scoreBAN:
          score
      };
    }
  }

  if (!meilleur) {
    console.log(
      "BAN : résultat rejeté car incohérent avec la recherche"
    );

    return null;
  }

  console.log(
    "BAN accepté :",
    meilleur.label,
    "| score :",
    meilleur.scoreBAN
  );

  return meilleur;
}

// ============================================================================
// GEOCODAGE INVERSE BAN (GPS -> adresse)
//
// Prend un couple lat/lon et interroge l'API BAN à l'envers pour récupérer
// l'adresse la plus proche : numéro, rue, code postal, ville, identifiantBAN.
// Utilisé quand l'utilisateur ne fournit que du GPS et rien d'autre.
// ============================================================================

async function geocoderBANInverse(lat, lon) {
  const url =
    `${BAN_URL}/reverse/` +
    `?lon=${encodeURIComponent(lon)}` +
    `&lat=${encodeURIComponent(lat)}` +
    `&limit=1`;

  console.log(
    "BAN reverse :",
    lat,
    lon
  );

  const response = await fetch(url);

  if (!response.ok) {
    console.log(
      "BAN reverse HTTP :",
      response.status
    );
    return null;
  }

  const data = await response.json();

  if (
    !data.features ||
    data.features.length === 0
  ) {
    console.log(
      "BAN reverse : aucun résultat"
    );
    return null;
  }

  const feature = data.features[0];
  const properties = feature.properties ?? {};

  return {
    label:
      properties.label ?? null,
    postcode:
      properties.postcode ?? null,
    city:
      properties.city ?? null,
    street:
      properties.street ?? null,
    housenumber:
      properties.housenumber ?? null,
    id:
      properties.id ?? null
  };
}

// ============================================================================
// CONSTRUCTION DES REQUETES ADEME
// ============================================================================

function construireRequetes(
  recherche
) {
  const requetes = [];

  const cp =
    recherche.cp;

  const voie =
    recherche.voie;

  const numero =
    recherche.numero;

  const ville =
    recherche.ville;

  const adresse =
    recherche.adresse;

  // Recherche très précise
  if (
    numero &&
    voie &&
    cp
  ) {
    requetes.push(
      `${numero} ${voie} ${cp}`
    );
  }

  if (
    adresse &&
    cp
  ) {
    requetes.push(
      `${adresse} ${cp}`
    );
  }

  if (
    voie &&
    cp
  ) {
    requetes.push(
      `${voie} ${cp}`
    );
  }

  if (
    ville &&
    cp
  ) {
    requetes.push(
      `${ville} ${cp}`
    );
  }

  if (cp) {
    requetes.push(cp);
  }

  if (
    numeroDPEValide(
      recherche.numeroDPE
    )
  ) {
    requetes.unshift(
      recherche.numeroDPE
    );
  }

  if (
    adresse &&
    !cp
  ) {
    requetes.push(adresse);
  }

  if (
    voie &&
    !cp
  ) {
    requetes.push(voie);
  }

  if (
    ville &&
    !cp
  ) {
    requetes.push(ville);
  }

  return [
    ...new Set(
      requetes
        .map((x) =>
          String(x).trim()
        )
        .filter(Boolean)
    )
  ];
}

function numeroDPEValide(
  numeroDPE
) {
  return (
    numeroDPE &&
    String(numeroDPE)
      .trim()
      .length >= 5
  );
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

function dedupliquer(
  resultats
) {
  const map = new Map();

  for (const dpe of resultats) {
    const cle =
      dpe.numeroDPE ||
      [
        dpe.numeroVoie,
        dpe.nomRue,
        dpe.codePostal,
        dpe.surfaceM2,
        dpe.date
      ]
        .map((x) =>
          String(x ?? "")
        )
        .join("|");

    const ancien =
      map.get(cle);

    if (
      !ancien ||
      dpe.scoreRecherche >
        ancien.scoreRecherche
    ) {
      map.set(
        cle,
        dpe
      );
    }
  }

  return Array.from(
    map.values()
  );
}

// ============================================================================
// EXPORT CSV
//
// Transforme un tableau de résultats DPE en chaine CSV compatible Excel.
// Séparateur : point-virgule (par défaut Excel FR).
// BOM UTF-8 en tête pour qu'Excel affiche correctement les accents.
// ============================================================================

const COLONNES_EXPORT = [
  "numeroDPE",
  "date",
  "adresse",
  "codePostal",
  "ville",
  "typeBatiment",
  "surfaceM2",
  "etiquetteDPE",
  "etiquetteGES",
  "consoKwhM2An",
  "energieChauffage",
  "anneeConstruction",
  "periodeConstruction",
  "coutAnnuelTotal",
  "coutChauffage",
  "latitude",
  "longitude",
  "identifiantBAN",
  "dateFinValidite",
  "scoreRecherche",
  "distanceMetres"
];

function echapperCSV(valeur) {
  if (valeur === null || valeur === undefined) return "";
  const texte = String(valeur);
  if (
    texte.includes(";") ||
    texte.includes("\"") ||
    texte.includes("\n") ||
    texte.includes("\r")
  ) {
    return `"${texte.replace(/"/g, '""')}"`;
  }
  return texte;
}

function resultatsVersCSV(resultats) {
  const BOM = "\uFEFF";

  const entetes =
    COLONNES_EXPORT.join(";");

  const lignes = resultats.map((dpe) =>
    COLONNES_EXPORT
      .map((colonne) => echapperCSV(dpe[colonne]))
      .join(";")
  );

  return BOM + entetes + "\r\n" + lignes.join("\r\n") + "\r\n";
}

// ============================================================================
// EXPORT XLSX
//
// Utilise la librairie xlsx (SheetJS) pour générer un vrai fichier Excel.
// ============================================================================

function resultatsVersXLSX(resultats) {
  const donnees = resultats.map((dpe) => {
    const ligne = {};
    for (const colonne of COLONNES_EXPORT) {
      ligne[colonne] = dpe[colonne] ?? null;
    }
    return ligne;
  });

  const feuille =
    XLSX.utils.json_to_sheet(donnees, {
      header: COLONNES_EXPORT
    });

  const classeur = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    classeur,
    feuille,
    "DPE"
  );

  return XLSX.write(classeur, {
    type: "buffer",
    bookType: "xlsx"
  });
}

// ============================================================================
// HORODATAGE POUR NOMS DE FICHIERS
// ============================================================================

function horodatageFichier() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// ============================================================================
// CALCUL ECART SURFACE
// ============================================================================

function calculerEcartSurface(
  dpe,
  surfaceCible
) {
  if (
    surfaceCible === null ||
    dpe.surfaceM2 === null ||
    dpe.surfaceM2 === undefined
  ) {
    return null;
  }

  const surface =
    Number(dpe.surfaceM2);

  if (!Number.isFinite(surface)) {
    return null;
  }

  return Math.abs(
    surface - surfaceCible
  );
}

// ============================================================================
// CLASSEMENT FINAL 0.5.0
// ============================================================================

function classerResultats(
  resultats,
  surfaceCible
) {
  const enrichis =
    resultats.map(
      (dpe) => ({
        ...dpe,

        ecartSurfaceM2:
          calculerEcartSurface(
            dpe,
            surfaceCible
          )
      })
    );

  const LOIN =
    Number.MAX_SAFE_INTEGER;

  enrichis.sort(
    (a, b) => {

      // ----------------------------------------------------------------------
      // 1. SCORE D'ADRESSE
      // ----------------------------------------------------------------------

      const differenceScore =
        (b.scoreRecherche ?? 0) -
        (a.scoreRecherche ?? 0);

      if (
        differenceScore !== 0
      ) {
        return differenceScore;
      }

      // ----------------------------------------------------------------------
      // 2. SURFACE SI DEMANDEE
      // ----------------------------------------------------------------------

      if (
        surfaceCible !== null
      ) {
        const ecartA =
          a.ecartSurfaceM2 ??
          LOIN;

        const ecartB =
          b.ecartSurfaceM2 ??
          LOIN;

        if (
          ecartA !== ecartB
        ) {
          return (
            ecartA -
            ecartB
          );
        }
      }

      // ----------------------------------------------------------------------
      // 3. DATE LA PLUS RECENTE
      // ----------------------------------------------------------------------

      const dateA =
        String(
          a.date ?? ""
        );

      const dateB =
        String(
          b.date ?? ""
        );

      const comparaisonDate =
        dateB.localeCompare(
          dateA
        );

      if (
        comparaisonDate !== 0
      ) {
        return comparaisonDate;
      }

      // ----------------------------------------------------------------------
      // 4. SURFACE LA PLUS GRANDE
      //    Départage supplémentaire si tout le reste est identique.
      // ----------------------------------------------------------------------

      const surfaceA =
        Number.isFinite(
          Number(a.surfaceM2)
        )
          ? Number(a.surfaceM2)
          : -1;

      const surfaceB =
        Number.isFinite(
          Number(b.surfaceM2)
        )
          ? Number(b.surfaceM2)
          : -1;

      return (
        surfaceB -
        surfaceA
      );
    }
  );

  return enrichis;
}

// ============================================================================
// ENRICHISSEMENT DVF (Demandes de Valeurs Foncières)
//
// Pour chaque DPE renvoyé, on ajoute (quand c'est possible) une estimation
// de la valeur marchande de son quartier, basée sur les transactions
// immobilières réelles publiées par la DGFiP :
//
//   dvf: {
//     prixMedianM2:              12400,        // euros / m²
//     prixEstimeTotal:           283960,       // = prixMedianM2 × surfaceM2
//     nbTransactionsComparables: 8,            // taille de l'échantillon
//     derniereTransaction:       "2025-11-14",
//     rayonMetres:               200,
//     ecartSurfacePct:           30
//   }
//
// Renvoie null si l'échantillon est trop faible (< 3 transactions) ou si
// le département n'est pas couvert par l'index.
//
// Les données sont pré-calculées par build-dvf-index.js et stockées dans
// data/dvf/{dept}.json. Chaque département est chargé à la première
// requête qui en a besoin, puis gardé en RAM (cache LRU max 10 dépts).
// ============================================================================

const DVF_DIR = "data/dvf";
const DVF_RAYON_METRES = 200;    // Rayon de recherche autour du DPE
const DVF_ECART_SURFACE = 0.30;  // ±30% de surface acceptée
const DVF_MIN_ECHANTILLON = 3;   // Minimum de transactions pour renvoyer un chiffre
const DVF_CACHE_MAX_DEPTS = 10;  // Éviction LRU au-delà de ce nombre

// Cache mémoire : dept -> { transactions, lastAccess }
const dvfCache = new Map();

// Départements pour lesquels on a déjà constaté l'absence de fichier
// (évite de faire un fs.existsSync à chaque requête pour un dept non couvert).
const dvfMissing = new Set();

function chargerDVFDept(dept) {
  if (dvfMissing.has(dept)) return null;

  const enCache = dvfCache.get(dept);
  if (enCache) {
    enCache.lastAccess = Date.now();
    return enCache.transactions;
  }

  const chemin = path.join(DVF_DIR, `${dept}.json`);
  if (!fs.existsSync(chemin)) {
    dvfMissing.add(dept);
    return null;
  }

  let transactions;
  try {
    transactions = JSON.parse(fs.readFileSync(chemin, "utf8"));
  } catch (e) {
    console.error(`⚠️  DVF : impossible de charger ${chemin} — ${e.message}`);
    dvfMissing.add(dept);
    return null;
  }

  // Éviction LRU si le cache est plein
  if (dvfCache.size >= DVF_CACHE_MAX_DEPTS) {
    let plusVieux = null;
    let plusVieuxDate = Infinity;
    for (const [d, entry] of dvfCache) {
      if (entry.lastAccess < plusVieuxDate) {
        plusVieuxDate = entry.lastAccess;
        plusVieux = d;
      }
    }
    if (plusVieux) dvfCache.delete(plusVieux);
  }

  dvfCache.set(dept, { transactions, lastAccess: Date.now() });
  console.log(`💰 DVF chargé pour dept ${dept} : ${transactions.length} transactions`);
  return transactions;
}

function medianeNombres(nombres) {
  if (nombres.length === 0) return null;
  const tries = [...nombres].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 !== 0
    ? tries[milieu]
    : (tries[milieu - 1] + tries[milieu]) / 2;
}

function deptDepuisDPE(dpe) {
  // Priorité 1 : département fourni par la BAN (le plus fiable)
  if (dpe.departement) return String(dpe.departement);

  // Priorité 2 : dérivé du code postal
  const cp = dpe.codePostal ? String(dpe.codePostal) : null;
  if (!cp || cp.length < 2) return null;

  // DROM : Guadeloupe 971, Martinique 972, Guyane 973, Réunion 974, Mayotte 976
  if (cp.startsWith("97") || cp.startsWith("98")) return cp.slice(0, 3);

  // Corse : 200xx et 201xx → 2A (Corse-du-Sud), 202xx et 206xx → 2B (Haute-Corse)
  // Approximation acceptable ; les vrais cas limites sont rares.
  if (cp.startsWith("20")) {
    const suite = parseInt(cp.slice(2, 4), 10);
    return suite <= 19 ? "2A" : "2B";
  }

  return cp.slice(0, 2);
}

function enrichirAvecDVF(dpe) {
  if (!dpe || !Number.isFinite(dpe.latitude) || !Number.isFinite(dpe.longitude)) {
    return null;
  }

  const dept = deptDepuisDPE(dpe);
  if (!dept) return null;

  const transactions = chargerDVFDept(dept);
  if (!transactions || transactions.length === 0) return null;

  // Type de bâtiment côté DPE → correspondance avec les codes DVF
  // typeBatiment peut valoir "maison", "appartement", "immeuble", null, ...
  const typeBatimentLower = String(dpe.typeBatiment || "").toLowerCase();
  const typeAttendu = typeBatimentLower.includes("maison") ? "M" : "A";

  const surfaceDPE = Number(dpe.surfaceM2) || 0;
  const surfaceMin = surfaceDPE > 0 ? surfaceDPE * (1 - DVF_ECART_SURFACE) : 0;
  const surfaceMax = surfaceDPE > 0 ? surfaceDPE * (1 + DVF_ECART_SURFACE) : Infinity;

  // Filtrage : type + surface + géographique (rayon 200 m)
  const comparables = [];
  for (const t of transactions) {
    if (t.t !== typeAttendu) continue;
    if (surfaceDPE > 0 && (t.s < surfaceMin || t.s > surfaceMax)) continue;
    const d = distanceMetres(dpe.latitude, dpe.longitude, t.la, t.lo);
    if (d > DVF_RAYON_METRES) continue;
    comparables.push(t);
  }

  if (comparables.length < DVF_MIN_ECHANTILLON) return null;

  const prixM2 = comparables.map(t => t.p / t.s);
  const median = medianeNombres(prixM2);

  const derniereTransaction = comparables
    .map(t => t.d)
    .sort()
    .pop();

  return {
    prixMedianM2: Math.round(median),
    prixEstimeTotal: surfaceDPE > 0 ? Math.round(median * surfaceDPE) : null,
    nbTransactionsComparables: comparables.length,
    derniereTransaction,
    rayonMetres: DVF_RAYON_METRES,
    ecartSurfacePct: DVF_ECART_SURFACE * 100,
  };
}

// ============================================================================
// ENRICHISSEMENT GÉORISQUES (v0.7.1)
//
// Pour chaque DPE renvoyé, on ajoute (quand c'est possible) une synthèse
// des risques naturels et technologiques qui pèsent sur sa commune :
//
//   georisques: {
//     commune: "PARIS 1ER ARRONDISSEMENT",
//     codeInsee: "75101",
//     risquesNaturels: {
//       inondation: "existant",
//       seisme: "faible",
//       retraitGonflementArgile: "important",
//       radon: "faible",
//       mouvementTerrain: "existant",
//       remonteeNappe: "existant"
//     },
//     risquesTechnologiques: {
//       icpe: "concerne",
//       canalisationsMatieresDangereuses: "concerne",
//       pollutionSols: "concerne"
//     },
//     nbRisquesPresents: 9,
//     sourceUrl: "https://www.georisques.gouv.fr/mes-risques/..."
//   }
//
// Données servies par l'API officielle Géorisques (BRGM + Ministère de la
// Transition écologique). Endpoint /resultats_rapport_risque, un appel par
// commune, résultat mis en cache 24h en RAM (une même commune n'est appelée
// qu'une fois par jour même si des centaines de DPEs y sont traités).
//
// Renvoie null si le codeInsee n'a pas pu être dérivé du DPE, si l'API
// répond en erreur, ou si le timeout de 5s est dépassé. L'échec est silencieux
// côté API DPE-X402 : les autres champs restent servis, seul `georisques`
// vaut null pour ce résultat.
// ============================================================================

const GEORISQUES_URL = "https://www.georisques.gouv.fr/api/v1";
const GEORISQUES_TIMEOUT_MS = 10000;                    // 10s, laisse de la marge
const GEORISQUES_CACHE_MAX = 2000;                      // ~2000 communes en RAM
const GEORISQUES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;    // 24h de fraîcheur

const georisquesCache = new Map();     // codeInsee -> { data, timestamp }
const georisquesInFlight = new Map();  // codeInsee -> Promise (request coalescing)

// Extrait le niveau depuis libelleStatutCommune :
//   "Risque Existant - faible"     -> "faible"
//   "Risque Existant - important"  -> "important"
//   "Risque Existant"              -> "existant"
//   "Risque Concerne"              -> "concerne"
//   null / present=false           -> null (risque absent)
function niveauRisqueGeorisques(risque) {
  if (!risque || risque.present !== true) return null;
  const s = String(risque.libelleStatutCommune || "");
  const m = s.match(/-\s*(.+)$/);
  if (m) return m[1].trim().toLowerCase();
  if (s.includes("Concerne")) return "concerne";
  if (s.includes("Existant")) return "existant";
  return "present";
}

function synthetiserGeorisques(brut) {
  if (!brut) return null;

  const naturels = {};
  const technologiques = {};
  let nbTotal = 0;

  if (brut.risquesNaturels) {
    for (const [key, val] of Object.entries(brut.risquesNaturels)) {
      const n = niveauRisqueGeorisques(val);
      if (n !== null) {
        naturels[key] = n;
        nbTotal++;
      }
    }
  }

  if (brut.risquesTechnologiques) {
    for (const [key, val] of Object.entries(brut.risquesTechnologiques)) {
      const n = niveauRisqueGeorisques(val);
      if (n !== null) {
        technologiques[key] = n;
        nbTotal++;
      }
    }
  }

  return {
    commune: brut.commune?.libelle ?? null,
    codeInsee: brut.commune?.codeInsee ?? null,
    risquesNaturels: naturels,
    risquesTechnologiques: technologiques,
    nbRisquesPresents: nbTotal,
    sourceUrl: brut.url ?? null,
  };
}

async function enrichirAvecGeorisques(dpe) {
  if (!dpe || !dpe.codeInsee) return null;

  const insee = String(dpe.codeInsee);

  // 1. Cache LRU 24h
  const enCache = georisquesCache.get(insee);
  if (enCache && Date.now() - enCache.timestamp < GEORISQUES_CACHE_TTL_MS) {
    // Rafraîchit l'ordre LRU
    georisquesCache.delete(insee);
    georisquesCache.set(insee, enCache);
    return enCache.data;
  }

  // 2. Request coalescing : si un appel pour ce INSEE est déjà en vol,
  // on partage sa Promise au lieu de lancer un doublon. Ça garantit
  // exactement 1 appel réseau par INSEE dans une requête, peu importe
  // combien de DPEs sont enrichis (20 DPEs à Paris 1er = 1 appel, pas 20).
  if (georisquesInFlight.has(insee)) {
    return georisquesInFlight.get(insee);
  }

  // 3. Nouvel appel API
  const url =
    `${GEORISQUES_URL}/resultats_rapport_risque?code_insee=${encodeURIComponent(insee)}`;

  const promesse = (async () => {
    try {
      const reponse = await fetch(url, {
        signal: AbortSignal.timeout(GEORISQUES_TIMEOUT_MS),
        headers: {
          "Accept": "application/json",
          "User-Agent": "DPE-X402/0.7.1 (https://github.com/bdatax-x/dpe-x402)"
        }
      });

      if (!reponse.ok) {
        // Null soft pour éviter de retenter à chaque requête (24h)
        georisquesCache.set(insee, { data: null, timestamp: Date.now() });
        return null;
      }

      const brut = await reponse.json();
      const synthese = synthetiserGeorisques(brut);

      georisquesCache.set(insee, { data: synthese, timestamp: Date.now() });

      // Éviction LRU si le cache dépasse le plafond
      if (georisquesCache.size > GEORISQUES_CACHE_MAX) {
        const clefPlusVieille = georisquesCache.keys().next().value;
        georisquesCache.delete(clefPlusVieille);
      }

      return synthese;
    } catch (e) {
      const causeMsg = e.cause?.message ?? e.cause?.code ?? "";
      console.error(
        `⚠️  Géorisques INSEE ${insee} :`,
        e.name || "",
        e.message,
        causeMsg ? `(cause: ${causeMsg})` : ""
      );
      return null;
    } finally {
      // Libère toujours la clé in-flight, succès ou échec
      georisquesInFlight.delete(insee);
    }
  })();

  georisquesInFlight.set(insee, promesse);
  return promesse;
}

// ============================================================================
// ROUTE /.well-known/x402.json
//
// Convention de découverte x402 : permet aux crawlers et aux agents IA
// autonomes de trouver automatiquement les endpoints payables et leurs
// tarifs sur ce domaine. Sert de « carte d'identité » de l'API.
//
// Génération dynamique depuis les variables .env — si tu changes RECEIVER
// ou NETWORK, le fichier reflète immédiatement le nouveau setup.
// ============================================================================

const USDC_CONTRACT = {
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

app.get(
  "/.well-known/x402.json",
  (req, res) => {
    const protocol = req.protocol;
    const host = req.get("host");
    const baseUrl = `${protocol}://${host}`;

    res.json({
      version: 1,
      apiVersion: "0.7.1",

      // ------------------------------------------------------------------
      // Provider — identité de la marque qui publie ces APIs
      // ------------------------------------------------------------------
      provider: {
        name: "BData X",
        description:
          "Portfolio d'APIs françaises monétisées x402 sur données publiques " +
          "(immobilier, énergie, risques, économie).",
        website: "https://bdatax.com",
        contact: {
          github: "https://github.com/bdatax-x/dpe-x402",
          type: "github-issue"
        },
        license: "BSL-1.1",
        licenseUrl: `${baseUrl.replace(/\/$/, "")}/LICENSE`,
        country: "FR",
        language: "fr"
      },

      // ------------------------------------------------------------------
      // Categories & tags — champs libres pour aider les crawlers et
      // annuaires (x402scan, Agentic.Market, Pay.sh, ampersend, etc.)
      // à classer et à indexer par mots-clés.
      // ------------------------------------------------------------------
      categories: [
        "real-estate",
        "energy",
        "public-data",
        "geospatial",
        "france",
        "risk-assessment",
        "property-valuation"
      ],
      tags: [
        "dpe",
        "diagnostic-performance-energetique",
        "energy-performance-certificate",
        "immobilier",
        "real-estate",
        "ademe",
        "dvf",
        "valeur-fonciere",
        "property-price",
        "georisques",
        "flood-risk",
        "seismic-risk",
        "radon",
        "ban",
        "geocoding",
        "france",
        "insurance",
        "lending",
        "tokenization",
        "ai-agents",
        "machine-economy"
      ],

      // ------------------------------------------------------------------
      // Ressources exposées, avec exigences de paiement et méta.
      // ------------------------------------------------------------------
      resources: [
        {
          path: "/dpe",
          method: "GET",
          url: `${baseUrl}/dpe`,
          name: "DPE + valeur marchande + risques",
          description:
            "Recherche DPE (Diagnostic de Performance Énergétique) sur la base " +
            "publique ADEME France, enrichie automatiquement avec : (1) estimation " +
            "de la valeur marchande basée sur les transactions immobilières réelles " +
            "DVF/DGFiP (prix médian €/m², nombre de comparables 2024-2025, date de " +
            "la dernière transaction du quartier), (2) synthèse des risques naturels " +
            "et technologiques de la commune via l'API officielle Géorisques BRGM " +
            "(inondation, séisme, radon, retrait-gonflement argile, ICPE, pollution " +
            "des sols, canalisations matières dangereuses, etc.). Modes de recherche : " +
            "adresse libre, code postal, GPS, numéro DPE, identifiant BAN, nom de rue.",

          payment: {
            scheme: "exact",
            network: NETWORK,
            asset: USDC_CONTRACT[NETWORK] ?? null,
            price: PRICE_USDC,
            payTo: RECEIVER_ADDRESS ?? null,
            extra: {
              name: "USDC",
              version: "2"
            }
          },

          input: {
            type: "http",
            method: "GET",
            queryParams: [
              { name: "cp", type: "string", description: "Code postal (5 chiffres)" },
              { name: "adresse", type: "string", description: "Adresse libre" },
              { name: "voie", type: "string", description: "Nom de rue" },
              { name: "numero", type: "string", description: "Numéro de voie" },
              { name: "ville", type: "string", description: "Nom de commune" },
              { name: "numeroDPE", type: "string", description: "Identifiant DPE ADEME" },
              { name: "lat", type: "number", description: "Latitude GPS (WGS84)" },
              { name: "lon", type: "number", description: "Longitude GPS (WGS84)" },
              { name: "surface", type: "number", description: "Surface m² (tri par proximité)" },
              { name: "format", type: "string", description: "csv | xlsx | json (défaut json)" },
              { name: "size", type: "number", description: "Nombre max de résultats (1-100, défaut 20)" }
            ]
          },

          output: {
            type: "application/json",
            description:
              "Objet JSON contenant : meilleurResultat (le DPE le plus pertinent), " +
              "resultats (tableau classé), dpeLePlusRecent, geocodageBAN, requetesADEME. " +
              "Chaque résultat porte : étiquette DPE/GES, surface, coût annuel, énergie, " +
              "GPS, dvf { prixMedianM2, prixEstimeTotal, nbTransactionsComparables }, " +
              "georisques { risquesNaturels, risquesTechnologiques, nbRisquesPresents }."
          },

          features: [
            "dpe-search",
            "dvf-enrichment",
            "georisques-enrichment",
            "reverse-geocoding",
            "csv-export",
            "xlsx-export"
          ],

          coverage: {
            country: "FR",
            geographic: "national",
            datasetsCount: 4
          },

          performance: {
            typicalResponseTimeMs: 800,
            rateLimit: "none"
          },

          discoverable: true,
          examples: [
            `${baseUrl}/dpe?cp=75001`,
            `${baseUrl}/dpe?adresse=203 rue Saint-Honoré 75001 Paris`,
            `${baseUrl}/dpe?numeroDPE=2175E0465600P`,
            `${baseUrl}/dpe?lat=48.864968&lon=2.331665`,
            `${baseUrl}/dpe?cp=75001&format=csv`
          ]
        }
      ],

      // ------------------------------------------------------------------
      // Data sources — bases publiques réutilisées (pour transparence)
      // ------------------------------------------------------------------
      dataSources: [
        {
          name: "ADEME - DPE existants",
          type: "energy-performance-certificate",
          url: "https://data.ademe.fr",
          license: "Open Data"
        },
        {
          name: "DGFiP - DVF géolocalisées",
          type: "real-estate-transactions",
          url: "https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/",
          license: "Licence Ouverte"
        },
        {
          name: "BRGM - Géorisques",
          type: "natural-technological-risks",
          url: "https://www.georisques.gouv.fr",
          license: "Open Data"
        },
        {
          name: "IGN - Base Adresse Nationale",
          type: "geocoding",
          url: "https://adresse.data.gouv.fr",
          license: "ODbL"
        }
      ]
    });
  }
);

// ============================================================================
// ROUTE RACINE
// ============================================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      service:
        "DPE-X402 API",

      statut:
        "OK",

      version:
        "0.6.5",

      endpoints: {
        dpe:
          "/dpe",

        rechercheAdresse:
          "/dpe?adresse=203 rue Saint-Honoré 75001 Paris",

        rechercheCP:
          "/dpe?cp=75001",

        rechercheRue:
          "/dpe?voie=Saint-Honoré&cp=75001",

        rechercheNumero:
          "/dpe?numero=203&voie=Saint-Honoré&cp=75001",

        rechercheDPE:
          "/dpe?numeroDPE=2175E0465600P",

        rechercheGPS:
          "/dpe?lat=48.864968&lon=2.331665",

        rechercheSurface:
          "/dpe?adresse=203 rue Saint-Honoré&cp=75001&ville=Paris&surface=77",

        exportCSV:
          "/dpe?cp=75001&format=csv",

        exportXLSX:
          "/dpe?cp=75001&format=xlsx",

        telechargementJSON:
          "/dpe?cp=75001&format=json&download=true"
      }
    });
  }
);

// ============================================================================
// ROUTE /openapi.json
//
// Spécification OpenAPI 3.1.0 conforme aux exigences de découverte de
// x402scan.com (et compatible avec les autres crawlers agentiques qui
// suivent la même convention IETF étendue).
//
// Sert de contrat machine-lisible officiel : les agents IA autonomes
// utilisent ce fichier pour comprendre les endpoints, les paramètres,
// les réponses possibles et les modalités de paiement en une seule
// lecture, sans avoir à interroger le serveur.
//
// x-payment-info suit la convention x402scan :
//   - price.amount est en USD décimal (ex: "0.001000")
//   - le runtime x402 v2 lui, exige des token atomic units (1000 pour 0.001 USDC)
//
// Cette dualité est voulue par la spec et permet aux agents de comparer
// des prix entre APIs de façon uniforme sans avoir à convertir les décimales.
// ============================================================================

app.get(
  "/openapi.json",
  (req, res) => {
    const protocol = req.protocol;
    const host = req.get("host");
    const baseUrl = `${protocol}://${host}`;

    // Prix en USD décimal pour la spec statique (ex: "0.001000")
    // PRICE_USDC arrive sous forme "$0.001" -> on retire le $ et on formate à 6 décimales
    const priceUsdDecimal = (() => {
      const brut = String(PRICE_USDC || "$0.001").replace(/^\$/, "");
      const num = parseFloat(brut);
      return isNaN(num) ? "0.001000" : num.toFixed(6);
    })();

    res.json({
      openapi: "3.1.0",
      info: {
        title: "DPE-X402",
        version: "0.7.1",
        summary:
          "API française sur les diagnostics de performance énergétique, " +
          "enrichie de la valeur marchande immobilière et des risques du " +
          "quartier, monétisée en USDC via x402.",
        description:
          "DPE-X402 croise en un seul appel payant : (1) les Diagnostics de " +
          "Performance Énergétique publiés par l'ADEME (10,4 millions), (2) " +
          "l'estimation de valeur marchande basée sur les transactions " +
          "immobilières DVF/DGFiP (1,67 million de ventes 2024-2025 " +
          "géolocalisées, filtrées à ±30 % de surface dans un rayon de " +
          "200 m), (3) la synthèse des risques naturels et technologiques " +
          "de la commune via l'API officielle Géorisques du BRGM " +
          "(inondation, séisme, radon, retrait-gonflement des argiles, " +
          "ICPE, canalisations matières dangereuses, pollution des sols). " +
          "Idéal pour agents IA immobiliers, assureurs, plateformes de " +
          "crédit immobilier, et due diligence pour la tokenisation " +
          "immobilière.",
        "x-guidance":
          "Appelle GET /dpe avec au moins un critère de recherche parmi : " +
          "code postal (cp=75001), adresse libre (adresse=203 rue Saint-Honoré " +
          "75001 Paris), coordonnées GPS (lat=48.864968&lon=2.331665), " +
          "identifiant DPE (numeroDPE=2175E0465600P), ou nom de voie " +
          "(voie=Saint-Honoré&cp=75001). La réponse est un JSON avec " +
          "'meilleurResultat' (le DPE le plus pertinent), 'resultats' " +
          "(tableau trié par score de pertinence), 'dpeLePlusRecent'. Chaque " +
          "résultat DPE porte automatiquement les champs 'dvf' (prix médian " +
          "€/m² du quartier, estimation totale, nombre de comparables, date " +
          "de la dernière transaction) et 'georisques' (risques naturels et " +
          "technologiques par niveau : faible, existant, important, concerne). " +
          "Le paiement se fait automatiquement via un client x402-compatible : " +
          "0.001 USDC par appel sur Base mainnet. Toutes les données sont " +
          "issues de bases publiques françaises (ADEME, DGFiP, BRGM, IGN).",
        contact: {
          name: "BData X",
          email: "comeben@gmail.com",
          url: "https://github.com/bdatax-x/dpe-x402"
        },
        license: {
          name: "Business Source License 1.1 (BSL)",
          url: `${baseUrl}/LICENSE`
        },
        termsOfService: "https://github.com/bdatax-x/dpe-x402#licence"
      },

      servers: [
        { url: baseUrl, description: "Production (Base mainnet)" }
      ],

      tags: [
        { name: "dpe",         description: "Diagnostics de Performance Énergétique (données ADEME)" },
        { name: "real-estate", description: "Immobilier français" },
        { name: "france",      description: "Données publiques France" },
        { name: "energy",      description: "Performance énergétique du bâti" }
      ],

      paths: {
        "/dpe": {
          get: {
            operationId: "searchDPE",
            summary:
              "Rechercher des DPE français enrichis avec valeur marchande et risques",
            description:
              "Retourne une liste de DPE (Diagnostic de Performance Énergétique) " +
              "français correspondant aux critères de recherche, classés par " +
              "pertinence. Chaque DPE est automatiquement enrichi avec (1) une " +
              "estimation de valeur marchande basée sur les transactions " +
              "immobilières comparables de la DGFiP dans un rayon de 200 m, " +
              "(2) la synthèse des risques naturels et technologiques de la " +
              "commune via l'API officielle Géorisques. Aucun paramètre de " +
              "recherche n'est obligatoire individuellement, mais au moins un " +
              "doit être fourni.",
            tags: ["dpe", "real-estate", "france"],
            "x-payment-info": {
              price: {
                mode: "fixed",
                currency: "USD",
                amount: priceUsdDecimal
              },
              protocols: [
                { "x402": {} }
              ]
            },
            parameters: [
              { name: "cp",         in: "query", required: false, schema: { type: "string", pattern: "^\\d{5}$" }, description: "Code postal français (5 chiffres). Ex: 75001", example: "75001" },
              { name: "adresse",    in: "query", required: false, schema: { type: "string" }, description: "Adresse libre. Numéro, rue, code postal et ville tous mélangés. Ex: '203 rue Saint-Honoré 75001 Paris'", example: "203 rue Saint-Honoré 75001 Paris" },
              { name: "voie",       in: "query", required: false, schema: { type: "string" }, description: "Nom de rue (sans le type : 'Saint-Honoré' au lieu de 'Rue Saint-Honoré')", example: "Saint-Honoré" },
              { name: "numero",     in: "query", required: false, schema: { type: "string" }, description: "Numéro dans la voie. Ex: '203'", example: "203" },
              { name: "ville",      in: "query", required: false, schema: { type: "string" }, description: "Nom de la commune. Ex: 'Paris'", example: "Paris" },
              { name: "numeroDPE",  in: "query", required: false, schema: { type: "string" }, description: "Identifiant DPE ADEME. Ex: '2175E0465600P'", example: "2175E0465600P" },
              { name: "lat",        in: "query", required: false, schema: { type: "number", minimum: -90,  maximum: 90 },  description: "Latitude WGS84. Ex: 48.864968", example: 48.864968 },
              { name: "lon",        in: "query", required: false, schema: { type: "number", minimum: -180, maximum: 180 }, description: "Longitude WGS84. Ex: 2.331665",  example: 2.331665 },
              { name: "surface",    in: "query", required: false, schema: { type: "number", minimum: 1 },  description: "Surface habitable en m² — active un tri secondaire par proximité de surface", example: 45 },
              { name: "size",       in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 }, description: "Nombre maximum de résultats renvoyés" },
              { name: "format",     in: "query", required: false, schema: { type: "string", enum: ["json", "csv", "xlsx"], default: "json" }, description: "Format de sortie" }
            ],
            responses: {
              "200": {
                description: "Résultats DPE enrichis (paiement validé)",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["service", "version", "trouve", "nombreResultats", "resultats"],
                      properties: {
                        service:               { type: "string", example: "DPE-X402" },
                        version:               { type: "string", example: "0.7.1" },
                        trouve:                { type: "boolean" },
                        nombreResultats:       { type: "integer" },
                        recherche:             { type: "object", description: "Récapitulatif des critères effectivement utilisés" },
                        geocodageBAN:          { type: ["object", "null"], description: "Résultat du géocodage direct BAN" },
                        geocodageBANInverse:   { type: ["object", "null"], description: "Résultat du géocodage inverse BAN" },
                        requetesADEME:         { type: "array", items: { type: "string" }, description: "Requêtes effectuées sur l'API ADEME" },
                        totalADEME:            { type: "integer", description: "Nombre total de correspondances ADEME (non tronquées)" },
                        critereDeTri:          { type: "string" },
                        meilleurResultat:      { $ref: "#/components/schemas/ResultatDPE" },
                        dpeLePlusRecent:       { $ref: "#/components/schemas/ResultatDPE" },
                        resultats:             { type: "array", items: { $ref: "#/components/schemas/ResultatDPE" } },
                        meta:                  { type: "object", properties: { tempsMs: { type: "integer" } } }
                      }
                    }
                  },
                  "text/csv": {
                    schema: { type: "string", description: "Export CSV compatible Excel FR (BOM UTF-8, séparateur point-virgule)" }
                  },
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
                    schema: { type: "string", format: "binary", description: "Export XLSX natif" }
                  }
                }
              },
              "400": {
                description: "Requête invalide : aucun critère de recherche fourni",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        erreur:   { type: "string" },
                        exemples: { type: "array", items: { type: "string" } }
                      }
                    }
                  }
                }
              },
              "402": {
                description: "Payment Required — le paiement x402 n'a pas été fourni ou n'est pas valide"
              },
              "500": {
                description: "Erreur serveur",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        erreur: { type: "string" },
                        detail: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      components: {
        schemas: {
          ResultatDPE: {
            type: "object",
            description:
              "Un DPE nettoyé et enrichi. Champs 'dvf' et 'georisques' peuvent " +
              "valoir null si l'enrichissement n'a pas trouvé assez de données " +
              "comparables (moins de 3 transactions DVF dans le rayon, ou " +
              "commune sans code INSEE dérivable pour Géorisques).",
            properties: {
              numeroDPE:               { type: ["string", "null"] },
              date:                    { type: ["string", "null"], format: "date" },
              adresse:                 { type: ["string", "null"] },
              ville:                   { type: ["string", "null"] },
              codePostal:              { type: ["string", "null"] },
              codeInsee:               { type: ["string", "null"] },
              departement:             { type: ["string", "null"] },
              typeBatiment:            { type: ["string", "null"] },
              surfaceM2:               { type: ["number", "null"] },
              etiquetteDPE:            { type: ["string", "null"], enum: ["A", "B", "C", "D", "E", "F", "G", null] },
              etiquetteGES:            { type: ["string", "null"], enum: ["A", "B", "C", "D", "E", "F", "G", null] },
              consoKwhM2An:            { type: ["number", "null"] },
              energieChauffage:        { type: ["string", "null"] },
              anneeConstruction:       { type: ["integer", "null"] },
              periodeConstruction:     { type: ["string", "null"] },
              coutAnnuelTotal:         { type: ["number", "null"], description: "Coût annuel total 5 usages en euros" },
              coutChauffage:           { type: ["number", "null"] },
              latitude:                { type: ["number", "null"] },
              longitude:               { type: ["number", "null"] },
              distanceMetres:          { type: ["integer", "null"], description: "Distance au point de recherche si GPS fourni" },
              scoreRecherche:          { type: ["number", "null"] },
              dvf: {
                type: ["object", "null"],
                description: "Enrichissement DVF (transactions immobilières DGFiP dans les 200m)",
                properties: {
                  prixMedianM2:               { type: "integer", description: "Prix médian au m² en euros" },
                  prixEstimeTotal:            { type: ["integer", "null"], description: "prixMedianM2 × surfaceM2" },
                  nbTransactionsComparables:  { type: "integer" },
                  derniereTransaction:        { type: "string", format: "date" },
                  rayonMetres:                { type: "integer", example: 200 },
                  ecartSurfacePct:            { type: "number", example: 30 }
                }
              },
              georisques: {
                type: ["object", "null"],
                description: "Synthèse des risques naturels et technologiques (BRGM Géorisques)",
                properties: {
                  commune:                { type: "string" },
                  codeInsee:              { type: "string" },
                  risquesNaturels:        { type: "object", additionalProperties: { type: "string", enum: ["faible", "existant", "important", "concerne", "present"] } },
                  risquesTechnologiques:  { type: "object", additionalProperties: { type: "string", enum: ["faible", "existant", "important", "concerne", "present"] } },
                  nbRisquesPresents:      { type: "integer" },
                  sourceUrl:              { type: "string", format: "uri", description: "Lien direct vers le rapport officiel Géorisques" }
                }
              }
            }
          }
        }
      },

      externalDocs: {
        url: "https://github.com/bdatax-x/dpe-x402",
        description: "Code source et documentation complète"
      }
    });
  }
);

// ============================================================================
// ROUTE DPE
// ============================================================================

app.get(
  "/dpe",
  async (req, res) => {
    const debut =
      Date.now();

    // ------------------------------------------------------------------------
    // DÉFENSE EN PROFONDEUR — 402 avant tout le reste
    //
    // paymentMiddleware (x402-express) est supposé intercepter avant nous.
    // Mais certains crawlers de découverte (notamment le probe backend de
    // x402scan.com) semblent le contourner dans certains cas limites, et
    // se retrouvent à recevoir notre 400 "aucun critère fourni" plutôt
    // que le 402 attendu. Résultat : ils marquent l'endpoint comme
    // non-conforme x402.
    //
    // On répond donc 402 nous-mêmes si le header X-PAYMENT est absent,
    // avant même la validation des paramètres. La structure retournée
    // suit strictement le format x402 v2 (accepts[].amount en unités
    // atomiques du token, x402Version = 2).
    // ------------------------------------------------------------------------
    if (
      !req.headers["x-payment"] &&
      !req.headers["X-PAYMENT"]
    ) {
      return res.status(402).json({
        x402Version: 2,
        error: "X-PAYMENT header is required",
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: "1000",
            resource: `${req.protocol}://${req.get("host")}/dpe`,
            description: "",
            mimeType: "",
            payTo: RECEIVER_ADDRESS ?? null,
            maxTimeoutSeconds: 60,
            asset: USDC_CONTRACT[NETWORK] ?? null,
            outputSchema: {
              input: {
                type: "http",
                method: "GET",
                discoverable: true
              }
            },
            extra: {
              name: "USD Coin",
              version: "2"
            }
          }
        ]
      });
    }

    try {

      // ----------------------------------------------------------------------
      // CONSTRUCTION RECHERCHE
      // ----------------------------------------------------------------------

      const recherche =
        construireRecherche(req);

      // ----------------------------------------------------------------------
      // ANALYSE AUTOMATIQUE ADRESSE
      // ----------------------------------------------------------------------

      if (recherche.adresse) {

        const analyse =
          analyserAdresse(
            recherche.adresse
          );

        if (
          !recherche.numero &&
          analyse.numero
        ) {
          recherche.numero =
            analyse.numero;
        }

        if (
          !recherche.cp &&
          analyse.cp
        ) {
          recherche.cp =
            analyse.cp;
        }
      }

      // ----------------------------------------------------------------------
      // GEOCODAGE INVERSE BAN (GPS -> adresse)
      //
      // Si l'utilisateur ne fournit que lat + lon, on récupère l'adresse
      // correspondante via la BAN. Le reste du flux (construireRequetes,
      // ADEME, scoring) fonctionne alors normalement.
      // ----------------------------------------------------------------------

      let geocodageInverse = null;

      if (
        recherche.lat !== null &&
        recherche.lon !== null &&
        !recherche.adresse &&
        !recherche.cp &&
        !recherche.voie &&
        !recherche.ville &&
        !recherche.numeroDPE
      ) {
        try {
          geocodageInverse =
            await geocoderBANInverse(
              recherche.lat,
              recherche.lon
            );

          if (geocodageInverse) {
            if (
              !recherche.adresse &&
              geocodageInverse.label
            ) {
              recherche.adresse =
                geocodageInverse.label;
            }
            if (
              !recherche.cp &&
              geocodageInverse.postcode
            ) {
              recherche.cp =
                geocodageInverse.postcode;
            }
            if (
              !recherche.ville &&
              geocodageInverse.city
            ) {
              recherche.ville =
                geocodageInverse.city;
            }
            if (
              !recherche.voie &&
              geocodageInverse.street
            ) {
              recherche.voie =
                geocodageInverse.street;
            }
            if (
              !recherche.numero &&
              geocodageInverse.housenumber
            ) {
              recherche.numero =
                geocodageInverse.housenumber;
            }
            if (
              !recherche.identifiantBAN &&
              geocodageInverse.id
            ) {
              recherche.identifiantBAN =
                geocodageInverse.id;
            }
          }
        } catch (error) {
          console.error(
            "Erreur BAN reverse :",
            error.message
          );
        }
      }

      // ----------------------------------------------------------------------
      // GEOCODAGE BAN
      // ----------------------------------------------------------------------

      let geocodage =
        null;

      if (
        recherche.adresse &&
        recherche.lat === null &&
        recherche.lon === null
      ) {

        try {

          geocodage =
            await geocoderBAN(
              recherche.adresse,
              recherche
            );

          // ------------------------------------------------------------------
          // On utilise les coordonnées BAN uniquement si le résultat est
          // cohérent avec la recherche.
          // ------------------------------------------------------------------

          if (geocodage) {

            recherche.lat =
              geocodage.latitude;

            recherche.lon =
              geocodage.longitude;

            if (
              !recherche.cp &&
              geocodage.postcode
            ) {
              recherche.cp =
                geocodage.postcode;
            }

            if (
              !recherche.ville &&
              geocodage.city
            ) {
              recherche.ville =
                geocodage.city;
            }

            if (
              !recherche.voie &&
              geocodage.street
            ) {
              recherche.voie =
                geocodage.street;
            }

            if (
              !recherche.numero &&
              geocodage.housenumber
            ) {
              recherche.numero =
                geocodage.housenumber;
            }

            if (
              !recherche.identifiantBAN &&
              geocodage.id
            ) {
              recherche.identifiantBAN =
                geocodage.id;
            }
          }

        } catch (error) {

          console.error(
            "Erreur BAN :",
            error.message
          );

          geocodage =
            null;
        }
      }

      // ----------------------------------------------------------------------
      // VERIFICATION CRITERES
      // ----------------------------------------------------------------------

      if (
        !recherche.cp &&
        !recherche.adresse &&
        !recherche.voie &&
        !recherche.ville &&
        !recherche.numeroDPE &&
        (recherche.lat === null || recherche.lon === null)
      ) {

        return res
          .status(400)
          .json({
            erreur:
              "Il faut fournir au moins un critère de recherche.",

            exemples: [

              "/dpe?cp=75001",

              "/dpe?adresse=203 rue Saint-Honoré",

              "/dpe?voie=Saint-Honoré&cp=75001",

              "/dpe?numero=203&voie=Saint-Honoré&cp=75001",

              "/dpe?ville=Paris",

              "/dpe?numeroDPE=2175E0465600P",

              "/dpe?lat=48.864968&lon=2.331665",

              "/dpe?adresse=203 rue Saint-Honoré&cp=75001&ville=Paris&surface=77"
            ]
          });
      }

      // ----------------------------------------------------------------------
      // REQUETES ADEME
      // ----------------------------------------------------------------------

      const requetes =
        construireRequetes(
          recherche
        );

      // Les requêtes sont lancées en parallèle avec Promise.all().
      // Temps total = temps de la requête la plus lente (au lieu de
      // la somme séquentielle). Une requête qui échoue n'interrompt
      // pas les autres : elle est simplement ignorée.

      const reponses = await Promise.all(
        requetes.map(
          (query) =>
            rechercherADEME(query, 100)
              .catch(
                (error) => {
                  console.error(
                    `Erreur requête ADEME "${query}" :`,
                    error.message
                  );
                  return null;
                }
              )
        )
      );

      let resultatsBruts = [];
      let totalADEME = 0;

      for (const data of reponses) {

        if (!data) continue;

        totalADEME =
          Math.max(
            totalADEME,
            Number(data.total) || 0
          );

        if (
          Array.isArray(data.results)
        ) {
          resultatsBruts.push(
            ...data.results
          );
        }
      }

      // ----------------------------------------------------------------------
      // NETTOYAGE + SCORE
      // ----------------------------------------------------------------------

      let resultats =
        resultatsBruts
          .map(nettoyerDPE)
          .map((dpe) => ({
            ...dpe,

            scoreRecherche:
              calculerScore(
                dpe,
                recherche
              )
          }));

      // ----------------------------------------------------------------------
      // DEDUPLICATION
      // ----------------------------------------------------------------------

      resultats =
        dedupliquer(
          resultats
        );

      // ----------------------------------------------------------------------
      // DISTANCE GPS
      // ----------------------------------------------------------------------

      if (
        recherche.lat !== null &&
        recherche.lon !== null
      ) {

        resultats =
          resultats.map(
            (dpe) => {

              if (
                dpe.latitude === null ||
                dpe.longitude === null
              ) {
                return dpe;
              }

              return {
                ...dpe,

                distanceMetres:
                  Math.round(
                    distanceMetres(
                      recherche.lat,
                      recherche.lon,
                      dpe.latitude,
                      dpe.longitude
                    )
                  )
              };
            }
          );
      }

      // ----------------------------------------------------------------------
      // CLASSEMENT 0.5.0
      //
      // 1. Score adresse
      // 2. Surface la plus proche si surface demandée
      // 3. Date la plus récente
      // 4. Surface la plus grande en dernier départage
      // ----------------------------------------------------------------------

      resultats =
        classerResultats(
          resultats,
          recherche.surface
        );

      // ----------------------------------------------------------------------
      // DPE LE PLUS RECENT
      //
      // Ce résultat est indépendant de la surface demandée.
      // ----------------------------------------------------------------------

      // On ne considère que les DPE dont le score est proche du
      // meilleur (moins de 500 points d'écart). Ça évite qu'un DPE
      // hors-sujet mais récent se retrouve désigné comme "le plus
      // récent" alors qu'il n'a rien à voir avec la recherche.

      const meilleurScore =
        resultats.length > 0
          ? (resultats[0].scoreRecherche ?? 0)
          : 0;

      const seuilPertinence =
        meilleurScore - 500;

      const dpeLePlusRecent =
        [...resultats]
          .filter(
            (dpe) =>
              (dpe.scoreRecherche ?? 0) >=
              seuilPertinence
          )
          .sort(
            (a, b) =>
              String(
                b.date ?? ""
              ).localeCompare(
                String(
                  a.date ?? ""
                )
              )
          )[0] ?? null;

      // ----------------------------------------------------------------------
      // LIMITATION
      // ----------------------------------------------------------------------

      const size =
        Math.min(
          Math.max(
            Number(
              req.query.size
            ) || 20,
            1
          ),
          100
        );

      resultats =
        resultats.slice(
          0,
          size
        );

      // ----------------------------------------------------------------------
      // ENRICHISSEMENT DVF + GÉORISQUES (v0.7.0 + v0.7.1)
      //
      // On enrichit uniquement les résultats qui seront réellement renvoyés
      // (après le slice), pour ne pas gaspiller de CPU / d'appels API sur
      // les DPE écartés.
      //
      // enrichirAvecDVF        : sync, lookup local dans data/dvf/{dept}.json
      // enrichirAvecGeorisques : async, appel API georisques.gouv.fr avec
      //                          cache RAM 24h par code INSEE (donc au max
      //                          1 appel par commune par jour, même si 100
      //                          DPEs y sont enrichis).
      //
      // Les deux tournent en parallèle via Promise.all. Une commune Paris
      // avec 20 DPE = 1 appel Géorisques + 20 lookups DVF = quelques ms.
      // ----------------------------------------------------------------------

      resultats = await Promise.all(
        resultats.map(async (dpe) => ({
          ...dpe,
          dvf: enrichirAvecDVF(dpe),
          georisques: await enrichirAvecGeorisques(dpe)
        }))
      );

      // Idem pour dpeLePlusRecent (calculé avant le slice) : on l'enrichit
      // aussi pour la cohérence de la réponse.
      const dpeLePlusRecentEnrichi =
        dpeLePlusRecent
          ? {
              ...dpeLePlusRecent,
              dvf: enrichirAvecDVF(dpeLePlusRecent),
              georisques: await enrichirAvecGeorisques(dpeLePlusRecent)
            }
          : null;

      // ----------------------------------------------------------------------
      // MEILLEUR RESULTAT
      // ----------------------------------------------------------------------

      const meilleur =
        resultats.length > 0
          ? resultats[0]
          : null;

      // ----------------------------------------------------------------------
      // CRITERE DE TRI
      // ----------------------------------------------------------------------

      const critereDeTri =
        recherche.surface !== null
          ? "score adresse, puis surface la plus proche, puis date la plus récente"
          : "score adresse, puis date la plus récente";

      // ----------------------------------------------------------------------
      // REPONSE
      // ----------------------------------------------------------------------

      // ----------------------------------------------------------------------
      // EXPORT DES RESULTATS SELON LE PARAMETRE format
      //
      // format=csv   -> fichier CSV pour Excel/Google Sheets
      // format=xlsx  -> fichier Excel natif
      // format=json (+ download=true) -> JSON forcé en téléchargement
      // pas de format -> comportement historique (JSON dans le navigateur)
      // ----------------------------------------------------------------------

      const format =
        String(req.query.format ?? "").toLowerCase();

      const horodatage = horodatageFichier();

      if (format === "csv") {
        const csv = resultatsVersCSV(resultats);
        res.setHeader(
          "Content-Type",
          "text/csv; charset=utf-8"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="dpe_${horodatage}.csv"`
        );
        return res.send(csv);
      }

      if (format === "xlsx") {
        const buffer = resultatsVersXLSX(resultats);
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="dpe_${horodatage}.xlsx"`
        );
        return res.send(buffer);
      }

      const downloadJSON =
        String(req.query.download ?? "").toLowerCase() === "true";

      if (downloadJSON) {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="dpe_${horodatage}.json"`
        );
      }

      res.json({

        service:
          "DPE-X402",

        version:
          "0.7.1",

        trouve:
          resultats.length > 0,

        recherche,

        geocodageBAN:
          geocodage,

        geocodageBANInverse:
          geocodageInverse,

        requetesADEME:
          requetes,

        totalADEME,

        nombreResultats:
          resultats.length,

        surfaceDemandee:
          recherche.surface,

        critereDeTri,

        dpeLePlusRecent:
          dpeLePlusRecentEnrichi,

        meilleurResultat:
          meilleur,

        resultats,

        meta: {
          tempsMs:
            Date.now() -
            debut
        }
      });

    } catch (error) {

      console.error(
        "ERREUR SERVEUR :",
        error
      );

      res
        .status(500)
        .json({

          erreur:
            "Erreur lors de la recherche DPE",

          detail:
            error.message
        });
    }
  }
);

// ============================================================================
// SERVEUR
// ============================================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Serveur DPE-X402 lancé sur http://localhost:${PORT}`
    );

  }
);