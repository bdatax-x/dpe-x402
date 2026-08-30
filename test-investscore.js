// Tests unitaires InvestScore — cas réalistes basés sur des données produit.
const { calculerInvestScore, _internes } = require("./investscore");

function ligne(titre) { console.log("\n" + "=".repeat(70) + "\n" + titre + "\n" + "=".repeat(70)); }
function afficher(nom, r) {
  if (!r) { console.log(`  ${nom} → null (données insuffisantes)`); return; }
  console.log(`  ${nom}`);
  console.log(`     Note: ${r.note}/100  (${r.lettre}) — ${r.libelle}  [confiance ${r.confiance}]`);
  console.log(`     Sous-scores:`, JSON.stringify(r.sousScores));
  console.log(`     Rendement: ${r.details.rendementBrutPct}% ${r.details.loyerEstime ? "(estimé)" : "(réel)"}  Loyer/m²/mois: ${r.details.loyerM2MoisUtilise}€  DPE: ${r.details.etiquetteDPE}  Risques: ${r.details.nbRisquesPresents}`);
  console.log(`     Forces: [${r.drivers.forces}]  Faiblesses: [${r.drivers.faiblesses}]`);
}

// --- Cas 1 : Paris 1er, appartement cher, bon DPE, peu de risques ---
// Prix élevé → rendement faible ; DPE C ; marché très liquide.
ligne("CAS 1 — Paris 1er (cher, liquide, DPE C)");
afficher("200 rue de Rivoli", calculerInvestScore({
  etiquetteDPE: "C",
  surfaceM2: 45,
  dvf: { prixMedianM2: 11800, prixEstimeTotal: 531000, nbTransactionsComparables: 28, derniereTransaction: "2025-06-15" },
  insee: { revenuMedianNiveauVie: 29730, tauxPauvrete: 16 },
  georisques: { risquesNaturels: { retraitGonflementArgile: "faible", remonteeNappe: "existant" }, risquesTechnologiques: {}, nbRisquesPresents: 2 },
}));

// --- Cas 2 : ville moyenne, prix bas, bon rendement, DPE D ---
ligne("CAS 2 — Ville moyenne (prix bas, bon rendement, DPE D)");
afficher("Limoges centre", calculerInvestScore({
  etiquetteDPE: "D",
  surfaceM2: 70,
  dvf: { prixMedianM2: 1350, prixEstimeTotal: 94500, nbTransactionsComparables: 12, derniereTransaction: "2025-02-10" },
  insee: { revenuMedianNiveauVie: 21500, tauxPauvrete: 14 },
  georisques: { risquesNaturels: { inondation: "existant" }, risquesTechnologiques: {}, nbRisquesPresents: 1 },
}));

// --- Cas 3 : passoire thermique G, zone à risques ---
ligne("CAS 3 — Passoire G, zone à risques (mauvais cas)");
afficher("Maison G inondable", calculerInvestScore({
  etiquetteDPE: "G",
  surfaceM2: 90,
  dvf: { prixMedianM2: 2100, prixEstimeTotal: 189000, nbTransactionsComparables: 5, derniereTransaction: "2022-09-01" },
  insee: { revenuMedianNiveauVie: 18200, tauxPauvrete: 22 },
  georisques: { risquesNaturels: { inondation: "important", retraitGonflementArgile: "important", mouvementTerrain: "existant" }, risquesTechnologiques: { pollutionSols: "concerne" }, nbRisquesPresents: 4 },
}));

// --- Cas 4 : avec loyer réel fourni (rendement précis) ---
ligne("CAS 4 — Même bien que cas 2 mais avec loyer réel fourni");
afficher("Limoges + loyer 9,5€/m²", calculerInvestScore({
  etiquetteDPE: "D",
  surfaceM2: 70,
  dvf: { prixMedianM2: 1350, prixEstimeTotal: 94500, nbTransactionsComparables: 12, derniereTransaction: "2025-02-10" },
  insee: { revenuMedianNiveauVie: 21500 },
  georisques: { risquesNaturels: { inondation: "existant" }, risquesTechnologiques: {}, nbRisquesPresents: 1 },
}, { loyerM2Mois: 9.5 }));

// --- Cas 5 : données partielles (pas de DVF) → confiance réduite ---
ligne("CAS 5 — Données partielles (DPE + risques seulement)");
afficher("DPE B sans DVF", calculerInvestScore({
  etiquetteDPE: "B",
  surfaceM2: 60,
  dvf: null,
  insee: null,
  georisques: { risquesNaturels: {}, risquesTechnologiques: {}, nbRisquesPresents: 0 },
}));

// --- Cas 6 : aucune donnée exploitable → null ---
ligne("CAS 6 — Aucune donnée → null attendu");
afficher("Vide", calculerInvestScore({ etiquetteDPE: null, dvf: null, insee: null, georisques: null }));

// --- Sanity checks sur les sous-fonctions ---
ligne("SANITY CHECKS");
const s = _internes;
console.log("  scoreEnergie A/D/G :", s.scoreEnergie("A"), s.scoreEnergie("D"), s.scoreEnergie("G"));
console.log("  scoreRendement 2%/5%/8% :", s.scoreRendement(2), s.scoreRendement(5), s.scoreRendement(8));
console.log("  Somme des poids =", Object.values(s.POIDS).reduce((a,b)=>a+b,0), "(doit valoir 1)");
console.log("  scoreRisque(aucun risque) =", s.scoreRisque({ risquesNaturels:{}, risquesTechnologiques:{} }), "(doit valoir 100)");
console.log("\n✅ Tests terminés.\n");
