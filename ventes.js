// ============================================================================
// ventes.js — Journal des ventes DPE-X402 / BData X
//
// Enregistre chaque appel PAYANT (endpoint + requête + payeur + montant) dans
// data/ventes.log (une ligne JSON par vente), et fournit une agrégation pour
// l'endpoint /stats.
//
// Le payeur et le montant sont extraits du header X-PAYMENT (x402), qui contient
// une autorisation de transfert signée : payload.authorization.{from, value}.
//
// ⚠️ Sur Render (tier gratuit), le disque est ÉPHÉMÈRE : ce fichier est remis à
// zéro à chaque redéploiement. C'est un tableau de bord "temps réel", pas une
// archive. La trace permanente de tes revenus reste la blockchain (BaseScan) :
// chaque vente = un transfert USDC vers ton wallet. Pour un historique durable,
// prévoir plus tard un disque persistant Render ou une petite base.
// ============================================================================

import fs from "fs";
import path from "path";

const VENTES_DIR = "data";
const VENTES_FILE = path.join(VENTES_DIR, "ventes.log");

// Décode le header X-PAYMENT (base64 → JSON) pour en extraire le payeur et le montant.
function extrairePaiement(req) {
  const h = req.headers["x-payment"] || req.headers["X-PAYMENT"];
  if (!h) return { payeur: null, montantAtomique: null };
  try {
    const json = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    const auth = json?.payload?.authorization || {};
    return {
      payeur: auth.from ?? null,
      montantAtomique: auth.value ?? null,
    };
  } catch {
    return { payeur: null, montantAtomique: null };
  }
}

// Enregistre une vente. Ne fait rien si aucun paiement (X-PAYMENT absent) →
// pas de fausse vente en dev local.
export function enregistrerVente(req, endpoint) {
  try {
    const h = req.headers["x-payment"] || req.headers["X-PAYMENT"];
    if (!h) return;

    const { payeur, montantAtomique } = extrairePaiement(req);
    const ligne = {
      ts: new Date().toISOString(),
      endpoint,
      url: req.originalUrl || null,       // ce qui a été demandé (adresse, cp…)
      payeur,                              // adresse qui a payé
      montantUSDC: montantAtomique ? Number(montantAtomique) / 1e6 : null,
    };

    if (!fs.existsSync(VENTES_DIR)) fs.mkdirSync(VENTES_DIR, { recursive: true });
    fs.appendFileSync(VENTES_FILE, JSON.stringify(ligne) + "\n");
  } catch (e) {
    // Ne jamais casser une requête à cause du logging
    console.error("⚠️  enregistrerVente:", e.message);
  }
}

// Lit data/ventes.log et renvoie une synthèse pour /stats.
// `receiver` = ton adresse de réception (pour distinguer payeurs externes de tes tests).
export function calculerStats(receiver) {
  if (!fs.existsSync(VENTES_FILE)) {
    return { totalVentes: 0, message: "Aucune vente enregistrée depuis le dernier déploiement." };
  }

  const lignes = fs.readFileSync(VENTES_FILE, "utf8").split("\n").filter(Boolean);
  const ventes = [];
  for (const l of lignes) {
    try { ventes.push(JSON.parse(l)); } catch { /* ligne corrompue ignorée */ }
  }

  const recv = (receiver || "").toLowerCase();
  const parEndpoint = {};
  const parPayeur = {};
  let revenuTotal = 0;
  let revenuExterne = 0;
  let ventesExternes = 0;

  for (const v of ventes) {
    parEndpoint[v.endpoint] = (parEndpoint[v.endpoint] || 0) + 1;
    if (v.payeur) parPayeur[v.payeur] = (parPayeur[v.payeur] || 0) + 1;
    const m = Number.isFinite(v.montantUSDC) ? v.montantUSDC : 0;
    revenuTotal += m;
    // Externe = payeur différent de ton propre wallet de réception
    const estExterne = v.payeur && recv && v.payeur.toLowerCase() !== recv;
    if (estExterne) { revenuExterne += m; ventesExternes++; }
  }

  const arrondi = (x) => Math.round(x * 1e6) / 1e6;

  return {
    totalVentes: ventes.length,
    ventesExternes,                                   // hors tes propres tests
    revenuTotalUSDC: arrondi(revenuTotal),
    revenuExterneUSDC: arrondi(revenuExterne),        // le vrai chiffre d'affaires
    parEndpoint,                                      // { "/dpe": n, "/dpe/score": n }
    payeursUniques: Object.keys(parPayeur).length,
    topPayeurs: Object.entries(parPayeur)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([addr, n]) => ({ payeur: addr, appels: n, estToi: recv && addr.toLowerCase() === recv })),
    dernieresVentes: ventes.slice(-25).reverse(),     // 25 dernières, plus récentes d'abord
    note: "Disque Render éphémère : compteur remis à zéro à chaque déploiement. Trace permanente = BaseScan.",
  };
}
