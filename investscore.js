// ============================================================================
// INVESTSCORE v2 — BData X / DPE-X402  (deux scores séparés)
//
// Transforme les données croisées (DPE + DVF + Géorisques + INSEE) en DEUX
// décisions chiffrées complémentaires — l'investisseur arbitre selon son angle :
//
//   • RendementScore /100  → "combien ça rapporte ?" (cash-flow)
//        - Rendement locatif brut ... 70 %
//        - Énergie / DPE ............ 30 %  (une passoire F/G est bientôt
//                                            interdite à la location → le
//                                            rendement théorique devient nul)
//
//   • SécuritéScore /100   → "à quel point c'est sûr et liquide ?"
//        - Risque (Géorisques) ...... 45 %
//        - Liquidité de marché ...... 35 %  (volume + fraîcheur des ventes)
//        - Contexte socio-éco ....... 20 %  (revenu médian = demande solvable)
//
// Un bien peut être excellent sur un axe et mauvais sur l'autre : c'est tout
// l'intérêt de séparer. Ex. Paris = rendement faible mais sécurité correcte ;
// petite ville = fort rendement mais liquidité plus faible.
//
// C'est le différenciateur face à Normi & co : on ne vend pas la donnée, on
// vend la DÉCISION. La formule est l'IP propriétaire — transparente, auditable,
// calibrable. Si une donnée manque, sa composante est exclue et les poids sont
// renormalisés. `confiance` indique combien de composantes ont été calculées.
//
// ⚠️ v2 : le rendement est ESTIMÉ depuis le prix/m² tant que la "carte des
// loyers" n'est pas branchée. Passer loyerM2Mois calcule le vrai rendement.
// ============================================================================

// ---------------------------------------------------------------------------
// POIDS (chaque groupe somme à 1). Modifiables ici pour recalibrer.
// ---------------------------------------------------------------------------
const POIDS_RENDEMENT = { rendement: 0.70, energie: 0.30 };
const POIDS_SECURITE  = { risque: 0.45, liquidite: 0.35, socioEco: 0.20 };

// ===========================================================================
// A. RENDEMENT LOCATIF
// ===========================================================================

// Rendement brut annuel estimé (%) par palier de prix/m² (relation empirique
// inverse prix↔rendement en France : Paris ~2,8 %, petites villes ~8,5 %).
function estimerRendementDepuisPrix(prixM2) {
  if (!Number.isFinite(prixM2) || prixM2 <= 0) return null;
  if (prixM2 < 1500)  return 8.5;
  if (prixM2 < 2500)  return 7.0;
  if (prixM2 < 4000)  return 5.5;
  if (prixM2 < 6000)  return 4.2;
  if (prixM2 < 9000)  return 3.3;
  return 2.8;
}

// { rendementBrutPct, loyerM2Mois, estime }
function calculerRendement(prixM2, loyerM2Mois) {
  if (Number.isFinite(loyerM2Mois) && loyerM2Mois > 0 && Number.isFinite(prixM2) && prixM2 > 0) {
    return {
      rendementBrutPct: Math.round((loyerM2Mois * 12) / prixM2 * 100 * 100) / 100,
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

// Rendement brut → 0-100 (2 % → 0, 8 % → 100).
function scoreRendement(rendementBrutPct) {
  if (!Number.isFinite(rendementBrutPct)) return null;
  const pct = (rendementBrutPct - 2) / (8 - 2) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// ===========================================================================
// B. ÉNERGIE / DPE
//
// Décisif pour un investisseur : la loi Climat interdit la MISE EN LOCATION
// des passoires — G interdit depuis 2025, F en 2028, E en 2034.
// ===========================================================================

const ETIQUETTE_SCORES = { A: 100, B: 88, C: 74, D: 58, E: 38, F: 18, G: 0 };

function scoreEnergie(etiquetteDPE) {
  if (!etiquetteDPE) return null;
  const lettre = String(etiquetteDPE).trim().toUpperCase().charAt(0);
  const s = ETIQUETTE_SCORES[lettre];
  return (s === undefined) ? null : s;
}

// ===========================================================================
// C. RISQUE (Géorisques)
//
// On part de 100 et on retranche une pénalité par risque présent, pondérée
// par sévérité, avec un plancher (un bien n'est jamais "0 sécurité" à cause
// des seuls risques : beaucoup de communes ont plusieurs risques faibles
// ubiquistes comme l'argile). Renvoie aussi le détail pour calibrage.
// ===========================================================================

const PENALITE_NIVEAU = {
  important: 15,
  existant:  7,
  concerne:  7,
  present:   6,
  faible:    2,
};

const PLANCHER_RISQUE = 20;   // le risque seul ne descend pas sous 20/100

function analyserRisque(georisques) {
  if (!georisques) return { score: null, detail: null };
  let penalite = 0;
  const detail = { naturels: {}, technologiques: {} };

  const compter = (bloc, cible) => {
    if (!bloc) return;
    for (const [cle, niveau] of Object.entries(bloc)) {
      const n = String(niveau).toLowerCase();
      penalite += PENALITE_NIVEAU[n] ?? 5;
      cible[cle] = n;
    }
  };
  compter(georisques.risquesNaturels, detail.naturels);
  compter(georisques.risquesTechnologiques, detail.technologiques);

  const score = Math.max(PLANCHER_RISQUE, Math.min(100, Math.round(100 - penalite)));
  return { score, detail, nbPresents: georisques.nbRisquesPresents ?? null };
}

// ===========================================================================
// D. LIQUIDITÉ DE MARCHÉ (volume + fraîcheur des transactions)
// ===========================================================================

function scoreLiquidite(dvf) {
  if (!dvf) return null;
  const parts = [];

  if (Number.isFinite(dvf.nbTransactionsComparables)) {
    const n = dvf.nbTransactionsComparables;
    parts.push(Math.max(0, Math.min(100, Math.round(40 + (n - 3) / (30 - 3) * 60))));
  }
  if (dvf.derniereTransaction) {
    const annee = parseInt(String(dvf.derniereTransaction).slice(0, 4), 10);
    if (Number.isFinite(annee)) {
      const age = new Date().getFullYear() - annee;
      parts.push(Math.max(20, Math.min(100, Math.round(100 - age * 16))));
    }
  }
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

// ===========================================================================
// E. CONTEXTE SOCIO-ÉCONOMIQUE (revenu médian = demande solvable)
// ===========================================================================

function scoreSocioEco(insee) {
  if (!insee || !Number.isFinite(insee.revenuMedianNiveauVie)) return null;
  const r = insee.revenuMedianNiveauVie;
  return Math.max(20, Math.min(100, Math.round(30 + (r - 15000) / (35000 - 15000) * 70)));
}

// ===========================================================================
// AGRÉGATION
// ===========================================================================

function noteVersLettre(note) {
  if (note >= 80) return "A";
  if (note >= 65) return "B";
  if (note >= 50) return "C";
  if (note >= 35) return "D";
  return "E";
}

const LIBELLES_RENDEMENT = {
  A: "Excellent rendement locatif",
  B: "Bon rendement",
  C: "Rendement correct",
  D: "Rendement faible",
  E: "Rendement très faible",
};

const LIBELLES_SECURITE = {
  A: "Placement très sûr et liquide",
  B: "Placement sûr",
  C: "Sécurité correcte",
  D: "Sécurité fragile",
  E: "Placement risqué / peu liquide",
};

// Combine des composantes {score, poids} en renormalisant sur celles présentes.
function agreger(composantes) {
  const dispo = composantes.filter(c => c.score !== null && c.score !== undefined);
  if (dispo.length === 0) return { note: null, nbComposantes: 0 };
  const poidsTotal = dispo.reduce((a, c) => a + c.poids, 0);
  const note = Math.round(dispo.reduce((a, c) => a + c.score * c.poids, 0) / poidsTotal);
  return { note, nbComposantes: dispo.length };
}

// ===========================================================================
// FONCTION PRINCIPALE
//
// `resultat` = DPE enrichi (.etiquetteDPE, .surfaceM2, .dvf, .insee,
//              .georisques). `options.loyerM2Mois` → rendement réel.
// Renvoie null si AUCUNE composante n'est calculable.
// ===========================================================================

function calculerInvestScore(resultat, options = {}) {
  if (!resultat) return null;

  const dvf = resultat.dvf || null;
  const insee = resultat.insee || null;
  const georisques = resultat.georisques || null;
  const prixM2 = dvf && Number.isFinite(dvf.prixMedianM2) ? dvf.prixMedianM2 : null;

  // Composantes brutes
  const rendement = calculerRendement(prixM2, options.loyerM2Mois);
  const sRendement = rendement ? scoreRendement(rendement.rendementBrutPct) : null;
  const sEnergie   = scoreEnergie(resultat.etiquetteDPE);
  const risque     = analyserRisque(georisques);
  const sLiquidite = scoreLiquidite(dvf);
  const sSocioEco  = scoreSocioEco(insee);

  // --- RendementScore ---
  const aggRdt = agreger([
    { score: sRendement, poids: POIDS_RENDEMENT.rendement },
    { score: sEnergie,   poids: POIDS_RENDEMENT.energie },
  ]);

  // --- SécuritéScore ---
  const aggSec = agreger([
    { score: risque.score, poids: POIDS_SECURITE.risque },
    { score: sLiquidite,   poids: POIDS_SECURITE.liquidite },
    { score: sSocioEco,    poids: POIDS_SECURITE.socioEco },
  ]);

  if (aggRdt.note === null && aggSec.note === null) return null;

  const rendementScore = aggRdt.note === null ? null : {
    note: aggRdt.note,
    lettre: noteVersLettre(aggRdt.note),
    libelle: LIBELLES_RENDEMENT[noteVersLettre(aggRdt.note)],
    composantes: { rendement: sRendement, energie: sEnergie },
    details: {
      rendementBrutPct: rendement ? rendement.rendementBrutPct : null,
      loyerM2Mois: rendement ? rendement.loyerM2Mois : null,
      loyerEstime: rendement ? rendement.estime : null,
      prixMedianM2: prixM2,
      etiquetteDPE: resultat.etiquetteDPE ?? null,
    },
  };

  const securiteScore = aggSec.note === null ? null : {
    note: aggSec.note,
    lettre: noteVersLettre(aggSec.note),
    libelle: LIBELLES_SECURITE[noteVersLettre(aggSec.note)],
    composantes: { risque: risque.score, liquidite: sLiquidite, socioEco: sSocioEco },
    details: {
      nbRisquesPresents: risque.nbPresents,
      risquesDetail: risque.detail,
      revenuMedianCommune: insee ? insee.revenuMedianNiveauVie : null,
    },
  };

  const nbTotal = aggRdt.nbComposantes + aggSec.nbComposantes;

  return {
    rendementScore,
    securiteScore,
    confiance: `${nbTotal}/5`,   // 2 composantes rendement + 3 sécurité
    methodologie:
      "InvestScore v2 — BData X. RendementScore = rendement 70% (estimé du prix/m² en v2) + énergie 30%. " +
      "SécuritéScore = risque 45% + liquidité 35% + socio-éco 20%.",
  };
}

export { calculerInvestScore };

// exportés pour les tests unitaires
export const _internes = {
  calculerRendement,
  scoreRendement,
  scoreEnergie,
  analyserRisque,
  scoreLiquidite,
  scoreSocioEco,
  noteVersLettre,
  agreger,
  POIDS_RENDEMENT,
  POIDS_SECURITE,
  ETIQUETTE_SCORES,
};
