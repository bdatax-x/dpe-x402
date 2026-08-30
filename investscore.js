// ============================================================================
// INVESTSCORE v1 — BData X / DPE-X402
//
// Transforme les données déjà croisées (DPE + DVF + Géorisques + INSEE) en
// UNE décision chiffrée : "ce bien, bon investissement locatif ? Note /100".
//
// C'est le différenciateur face à Normi & co : on ne vend pas la donnée,
// on vend la DÉCISION. La formule ci-dessous est l'IP propriétaire — elle
// se calibre et s'affine, mais sa logique reste transparente et auditable.
//
// InvestScore = moyenne pondérée de 4 sous-scores (chacun 0-100) :
//   - Rendement locatif ...... 35 %   (cash-flow : le nerf de l'investissement)
//   - Énergie / DPE .......... 25 %   (coût réno + interdiction location F/G/E)
//   - Risque (Géorisques) .... 20 %   (valeur, assurance, revente)
//   - Tension / liquidité .... 20 %   (facilité de revente, demande locale)
//
// Si une donnée manque, son sous-score est exclu et les poids sont
// renormalisés sur les composantes disponibles. Le champ `confiance`
// indique combien des 4 composantes ont pu être calculées.
//
// ⚠️ v1 : le rendement locatif est ESTIMÉ à partir du prix/m² (relation
// empirique prix↔rendement en France) tant que la "carte des loyers" n'est
// pas branchée. Passer `loyerM2Mois` en option calcule le vrai rendement.
// C'est la première donnée à brancher pour rendre le score précis
// (cf. carnet 11.2-bis, axe VALEUR/RENDEMENT).
// ============================================================================

// ---------------------------------------------------------------------------
// POIDS DES COMPOSANTES (somme = 1). Modifiables ici pour recalibrer.
// ---------------------------------------------------------------------------
const POIDS = {
  rendement: 0.35,
  energie:   0.25,
  risque:    0.20,
  tension:   0.20,
};

// ---------------------------------------------------------------------------
// A. SOUS-SCORE RENDEMENT LOCATIF
//
// Rendement brut = (loyer mensuel/m² × 12 × surface) / prix estimé total
//                = (loyer mensuel/m² × 12) / prix au m²
//
// Faute de données de loyers en v1, on estime le rendement à partir du
// prix/m² : en France le rendement brut est inversement corrélé au prix
// (Paris ~2,5-3 %, petites villes ~7-9 %). Barème empirique transparent.
// ---------------------------------------------------------------------------

function estimerRendementDepuisPrix(prixM2) {
  // Rendement brut annuel estimé (%) par palier de prix/m².
  if (!Number.isFinite(prixM2) || prixM2 <= 0) return null;
  if (prixM2 < 1500)  return 8.5;
  if (prixM2 < 2500)  return 7.0;
  if (prixM2 < 4000)  return 5.5;
  if (prixM2 < 6000)  return 4.2;
  if (prixM2 < 9000)  return 3.3;
  return 2.8;
}

// Renvoie { rendementBrutPct, loyerM2Mois, estime }
function calculerRendement(prixM2, loyerM2Mois) {
  if (Number.isFinite(loyerM2Mois) && loyerM2Mois > 0 && Number.isFinite(prixM2) && prixM2 > 0) {
    const rendementBrutPct = (loyerM2Mois * 12) / prixM2 * 100;
    return {
      rendementBrutPct: Math.round(rendementBrutPct * 100) / 100,
      loyerM2Mois: Math.round(loyerM2Mois * 100) / 100,
      estime: false,
    };
  }
  const rdt = estimerRendementDepuisPrix(prixM2);
  if (rdt === null) return null;
  return {
    rendementBrutPct: rdt,
    loyerM2Mois: Math.round((rdt / 100 * prixM2) / 12 * 100) / 100,
    estime: true,
  };
}

// Rendement brut → score 0-100 (linéaire : 2 % → 0, 8 % → 100).
function scoreRendement(rendementBrutPct) {
  if (!Number.isFinite(rendementBrutPct)) return null;
  const min = 2, max = 8;
  const pct = (rendementBrutPct - min) / (max - min) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// ---------------------------------------------------------------------------
// B. SOUS-SCORE ÉNERGIE / DPE
//
// L'étiquette DPE n'est pas cosmétique pour un investisseur : la loi Climat
// interdit progressivement la MISE EN LOCATION des passoires thermiques —
// G interdit depuis 2025, F en 2028, E en 2034. Un bien G/F est donc une
// FUTURE impossibilité locative + un coût de rénovation. C'est un facteur
// de décision réel, pas un détail.
// ---------------------------------------------------------------------------

const ETIQUETTE_SCORES = {
  A: 100,
  B: 88,
  C: 74,
  D: 58,
  E: 38,   // sous le seuil, location interdite à partir de 2034
  F: 18,   // location interdite à partir de 2028
  G: 0,    // location déjà interdite (2025)
};

function scoreEnergie(etiquetteDPE) {
  if (!etiquetteDPE) return null;
  const lettre = String(etiquetteDPE).trim().toUpperCase().charAt(0);
  const s = ETIQUETTE_SCORES[lettre];
  return (s === undefined) ? null : s;
}

// ---------------------------------------------------------------------------
// C. SOUS-SCORE RISQUE (Géorisques)
//
// On part de 100 et on retranche une pénalité par risque présent, pondérée
// par la sévérité. Plus il y a de risques et plus ils sont sévères, plus le
// score baisse (impact sur valeur, prime d'assurance, revente).
// ---------------------------------------------------------------------------

const PENALITE_NIVEAU = {
  important: 18,
  existant:  10,
  concerne:  10,
  present:   8,
  faible:    4,
};

function scoreRisque(georisques) {
  if (!georisques) return null;
  let penalite = 0;

  const compter = (bloc) => {
    if (!bloc) return;
    for (const niveau of Object.values(bloc)) {
      const n = String(niveau).toLowerCase();
      penalite += PENALITE_NIVEAU[n] ?? 6;
    }
  };

  compter(georisques.risquesNaturels);
  compter(georisques.risquesTechnologiques);

  return Math.max(0, Math.min(100, Math.round(100 - penalite)));
}

// ---------------------------------------------------------------------------
// D. SOUS-SCORE TENSION / LIQUIDITÉ DE MARCHÉ
//
// Proxy de la facilité de revente et de la demande locale :
//   - nb de transactions comparables (marché actif = liquide)
//   - ancienneté de la dernière transaction (récent = marché vivant)
//   - revenu médian INSEE (demande solvable stable dans la zone)
//
// Ce n'est PAS le rendement (une zone chère et liquide a un score de
// tension élevé mais un rendement faible) : c'est la sécurité/liquidité.
// ---------------------------------------------------------------------------

function scoreTension(dvf, insee) {
  const parts = [];

  // 1. Volume de comparables : 3 → ~40, 30+ → 100
  if (dvf && Number.isFinite(dvf.nbTransactionsComparables)) {
    const n = dvf.nbTransactionsComparables;
    const s = Math.max(0, Math.min(100, Math.round(40 + (n - 3) / (30 - 3) * 60)));
    parts.push(s);
  }

  // 2. Fraîcheur de la dernière transaction (année) : <1 an → 100, >5 ans → 20
  if (dvf && dvf.derniereTransaction) {
    const annee = parseInt(String(dvf.derniereTransaction).slice(0, 4), 10);
    if (Number.isFinite(annee)) {
      const ageAns = new Date().getFullYear() - annee;
      const s = Math.max(20, Math.min(100, Math.round(100 - ageAns * 16)));
      parts.push(s);
    }
  }

  // 3. Revenu médian INSEE (demande solvable) : 15k€ → 30, 35k€+ → 100
  if (insee && Number.isFinite(insee.revenuMedianNiveauVie)) {
    const r = insee.revenuMedianNiveauVie;
    const s = Math.max(20, Math.min(100, Math.round(30 + (r - 15000) / (35000 - 15000) * 70)));
    parts.push(s);
  }

  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

// ---------------------------------------------------------------------------
// LETTRE GLOBALE + LIBELLÉ
// ---------------------------------------------------------------------------

function noteVersLettre(note) {
  if (note >= 80) return "A";
  if (note >= 65) return "B";
  if (note >= 50) return "C";
  if (note >= 35) return "D";
  return "E";
}

const LIBELLES = {
  A: "Excellent potentiel d'investissement locatif",
  B: "Bon potentiel, quelques réserves",
  C: "Potentiel correct, à étudier de près",
  D: "Potentiel faible, vigilance requise",
  E: "Investissement risqué ou peu rentable",
};

// ---------------------------------------------------------------------------
// FONCTION PRINCIPALE
//
// `resultat` = un DPE enrichi (avec .etiquetteDPE, .surfaceM2, .dvf,
//              .insee, .georisques) tel qu'assemblé dans la route /dpe.
// `options`  = { loyerM2Mois? } pour calculer le vrai rendement si connu.
//
// Renvoie null si AUCUNE composante n'est calculable (données trop pauvres).
// ---------------------------------------------------------------------------

function calculerInvestScore(resultat, options = {}) {
  if (!resultat) return null;

  const dvf = resultat.dvf || null;
  const insee = resultat.insee || null;
  const georisques = resultat.georisques || null;
  const prixM2 = dvf && Number.isFinite(dvf.prixMedianM2) ? dvf.prixMedianM2 : null;

  // --- A. Rendement ---
  const rendement = calculerRendement(prixM2, options.loyerM2Mois);
  const sRendement = rendement ? scoreRendement(rendement.rendementBrutPct) : null;

  // --- B. Énergie ---
  const sEnergie = scoreEnergie(resultat.etiquetteDPE);

  // --- C. Risque ---
  const sRisque = scoreRisque(georisques);

  // --- D. Tension ---
  const sTension = scoreTension(dvf, insee);

  // --- Agrégation avec renormalisation sur les composantes disponibles ---
  const composantes = [
    { cle: "rendement", score: sRendement, poids: POIDS.rendement },
    { cle: "energie",   score: sEnergie,   poids: POIDS.energie },
    { cle: "risque",    score: sRisque,    poids: POIDS.risque },
    { cle: "tension",   score: sTension,   poids: POIDS.tension },
  ].filter(c => c.score !== null);

  if (composantes.length === 0) return null;

  const poidsTotal = composantes.reduce((a, c) => a + c.poids, 0);
  const note = Math.round(
    composantes.reduce((a, c) => a + c.score * c.poids, 0) / poidsTotal
  );

  const lettre = noteVersLettre(note);

  // --- Drivers : les 2 forces et 2 faiblesses les plus marquantes ---
  const tries = [...composantes].sort((a, b) => b.score - a.score);
  const forces = tries.filter(c => c.score >= 65).slice(0, 2).map(c => c.cle);
  const faiblesses = tries.filter(c => c.score < 50).slice(-2).map(c => c.cle);

  return {
    note,                        // 0-100
    lettre,                      // A-E
    libelle: LIBELLES[lettre],
    confiance: `${composantes.length}/4`,  // nb de composantes calculées
    sousScores: {
      rendement: sRendement,
      energie:   sEnergie,
      risque:    sRisque,
      tension:   sTension,
    },
    drivers: { forces, faiblesses },
    details: {
      rendementBrutPct: rendement ? rendement.rendementBrutPct : null,
      loyerM2MoisUtilise: rendement ? rendement.loyerM2Mois : null,
      loyerEstime: rendement ? rendement.estime : null,
      prixMedianM2: prixM2,
      etiquetteDPE: resultat.etiquetteDPE ?? null,
      nbRisquesPresents: georisques ? georisques.nbRisquesPresents : null,
    },
    methodologie: "InvestScore v1 — BData X. Pondération : rendement 35% (estimé du prix/m² en v1), énergie/DPE 25%, risque 20%, tension marché 20%.",
  };
}

export { calculerInvestScore };

// exportés pour les tests unitaires
export const _internes = {
  calculerRendement,
  scoreRendement,
  scoreEnergie,
  scoreRisque,
  scoreTension,
  noteVersLettre,
  POIDS,
  ETIQUETTE_SCORES,
};
