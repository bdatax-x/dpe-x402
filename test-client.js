// ============================================================================
// test-client.js
//
// Client x402 de test : appelle ton API DPE avec paiement automatique en USDC.
//
// Comment lancer :
//   node --env-file=client.env test-client.js
//
// Prérequis :
//   - client.env avec PRIVATE_KEY (clé MetaMask, jamais commit !)
//   - client.env avec API_URL (par défaut https://dpe.bdatax.com/dpe?cp=75001)
//   - Le wallet doit avoir de l'USDC sur Base Sepolia (faucet Circle)
// ============================================================================

import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

// ---------------------------------------------------------------------------
// Config depuis client.env
// ---------------------------------------------------------------------------

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const API_URL =
  process.env.API_URL ||
  "https://dpe.bdatax.com/dpe?cp=75001";

if (!PRIVATE_KEY) {
  console.error(
    "❌ PRIVATE_KEY manquante dans client.env"
  );
  process.exit(1);
}

// viem exige que la clé commence par 0x
const cleFormatee = PRIVATE_KEY.startsWith("0x")
  ? PRIVATE_KEY
  : `0x${PRIVATE_KEY}`;

// ---------------------------------------------------------------------------
// Création du wallet client
// ---------------------------------------------------------------------------

const account = privateKeyToAccount(cleFormatee);

console.log("========================================");
console.log("Client x402 DPE-X402");
console.log("========================================");
console.log(`Wallet payeur  : ${account.address}`);
console.log(`URL cible      : ${API_URL}`);
console.log("========================================\n");

// ---------------------------------------------------------------------------
// Wrapper fetch avec paiement automatique
// Le "10_000" est un plafond de sécurité : max 0,01 USDC par appel
// (pour éviter qu'un serveur mal configuré demande 1000 USDC par erreur)
// ---------------------------------------------------------------------------

const fetchWithPayment = wrapFetchWithPayment(
  fetch,
  account,
  BigInt(10_000)
);

// ---------------------------------------------------------------------------
// Appel avec paiement automatique
// ---------------------------------------------------------------------------

const debut = Date.now();

try {
  console.log("→ Requête envoyée. Le client va :");
  console.log("  1. Recevoir un HTTP 402");
  console.log("  2. Signer une autorisation de paiement USDC");
  console.log("  3. Refaire la requête avec le header X-PAYMENT");
  console.log("  4. Recevoir les données DPE\n");

  const response = await fetchWithPayment(API_URL);
  const duree = Date.now() - debut;

  console.log(`← Réponse reçue en ${duree} ms`);
  console.log(`  Status : HTTP ${response.status}`);

  // Le header X-PAYMENT-RESPONSE contient les infos du paiement effectué
  const paiementBase64 = response.headers.get(
    "x-payment-response"
  );

  if (paiementBase64) {
    try {
      const decode = JSON.parse(
        Buffer.from(paiementBase64, "base64").toString(
          "utf8"
        )
      );
      console.log("\n💰 Paiement effectué :");
      console.log(
        JSON.stringify(decode, null, 2)
      );
    } catch {
      console.log(
        "\n💰 Paiement (raw) :",
        paiementBase64
      );
    }
  }

  const data = await response.json();

  console.log(
    `\n📊 API a renvoyé ${data.nombreResultats} résultats DPE`
  );

  if (data.meilleurResultat) {
    const r = data.meilleurResultat;
    console.log(
      `   Meilleur : ${r.adresse}`
    );
    console.log(
      `   Étiquette DPE : ${r.etiquetteDPE} · Surface : ${r.surfaceM2} m² · Coût annuel : ${r.coutAnnuelTotal} €`
    );
  }

  // Sauvegarde la réponse complète pour inspection
  fs.writeFileSync(
    "dpe_paiement.json",
    JSON.stringify(data, null, 2)
  );

  console.log(
    "\n📁 Réponse complète sauvegardée dans dpe_paiement.json"
  );
  console.log(
    "\n🔍 Vérifie ta transaction USDC ici :"
  );
  console.log(
    `   https://sepolia.basescan.org/address/${account.address}`
  );
  console.log(
    "\n✅ Test paiement réussi. Ton premier revenu USDC est arrivé !"
  );

} catch (error) {
  console.error(
    "\n❌ Erreur pendant le paiement :",
    error.message
  );
  if (error.cause) {
    console.error("   Cause :", error.cause);
  }
  process.exit(1);
}
