// ============================================================================
// build-dvf-index.js — Préparation de l'index DVF pour DPE-X402
//
// Ce script convertit le fichier officiel geo-DVF de data.gouv.fr en
// petits fichiers JSON par département, prêts à être servis par server.js.
//
// À lancer une seule fois sur ta machine (et à chaque mise à jour DVF,
// environ 2x par an : avril et octobre).
//
// ----------------------------------------------------------------------------
// MODE D'EMPLOI
// ----------------------------------------------------------------------------
//
//   1. Télécharger le fichier DVF géolocalisé (~499 MB compressé) :
//
//      Page officielle :
//        https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/
//
//      Lien direct latest (recommandé) :
//        https://files.data.gouv.fr/geo-dvf/latest/csv/full.csv.gz
//
//      → Sauvegarder à côté de ce script sous le nom "full.csv.gz"
//
//   2. Depuis ce dossier, lancer :
//        node build-dvf-index.js
//
//   3. Le dossier data/dvf/ sera créé avec un fichier .json par département.
//      Poids total attendu : ~150 MB, ~10 minutes de traitement.
//
//   4. Ajouter le dossier au git :
//        git add data/dvf/
//        git commit -m "chore(dvf): index DVF 2024-2025 (v0.7.0)"
//        git push
//
// ----------------------------------------------------------------------------
// CE QUI EST FILTRÉ / GARDÉ
// ----------------------------------------------------------------------------
//
//   ✔ Uniquement les années 2024 et 2025 (transactions récentes)
//   ✔ Uniquement type_local ∈ { Appartement, Maison }
//   ✔ Uniquement mutations "Vente" ou "Vente en l'état futur d'achèvement"
//   ✔ Uniquement transactions à un seul lot (évite les prix "package")
//   ✔ Uniquement lignes avec lat/lon valides
//   ✔ Uniquement prix ∈ [1 000 €, 50 M€] et prix/m² ∈ [500 €, 50 000 €]
//   ✔ Uniquement surface_reelle_bati ∈ [5 m², 5 000 m²]
//
// ----------------------------------------------------------------------------
// SCHÉMA DE SORTIE
// ----------------------------------------------------------------------------
//
// data/dvf/{dept}.json = tableau d'objets ultra-compacts :
//   {
//     la: 48.864968,   // latitude
//     lo: 2.331665,    // longitude
//     p:  520000,      // prix (valeur_fonciere)
//     s:  47.5,        // surface_reelle_bati
//     t:  "A",         // "A" = Appartement, "M" = Maison
//     d:  "2024-11-14" // date_mutation
//   }
//
// Noms de champs volontairement courts pour minimiser le poids JSON.
// ============================================================================

import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";

// Le fichier d'entrée peut être passé en argument :
//   node build-dvf-index.js mon-fichier.csv.gz
// Sinon on cherche par défaut "full.csv.gz", puis n'importe quel .csv.gz
// présent à la racine du projet.
const OUTPUT_DIR = "data/dvf";
const YEAR_MIN = 2024;
const YEAR_MAX = 2025;

function trouverFichierEntree() {
  if (process.argv[2]) return process.argv[2];
  if (fs.existsSync("full.csv.gz")) return "full.csv.gz";
  const candidats = fs
    .readdirSync(".")
    .filter(f => f.toLowerCase().endsWith(".csv.gz"));
  if (candidats.length === 1) {
    console.log(`ℹ️  Fichier "${candidats[0]}" détecté automatiquement.\n`);
    return candidats[0];
  }
  if (candidats.length > 1) {
    console.error(`\n❌ Plusieurs .csv.gz trouvés à la racine — précise lequel utiliser :\n`);
    for (const c of candidats) console.error(`   node build-dvf-index.js "${c}"`);
    console.error("");
    process.exit(1);
  }
  return null;
}

const INPUT_FILE = trouverFichierEntree();

// ---------------------------------------------------------------------------
// Vérifications préalables
// ---------------------------------------------------------------------------

if (!INPUT_FILE || !fs.existsSync(INPUT_FILE)) {
  console.error(`\n❌ Aucun fichier .csv.gz trouvé.\n`);
  console.error(`   Télécharge le fichier DVF géolocalisé (~499 MB) ici :`);
  console.error(`   https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/`);
  console.error(`   ou en direct :`);
  console.error(`   https://files.data.gouv.fr/geo-dvf/latest/csv/full.csv.gz\n`);
  console.error(`   Puis relance :  node build-dvf-index.js`);
  console.error(`   (ou avec un nom précis :  node build-dvf-index.js mon-fichier.csv.gz)\n`);
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Parsing CSV ligne par ligne (stream, pas de chargement en RAM)
// ---------------------------------------------------------------------------

const parDept = new Map();

let entete = null;
const colonnes = {};

let lignesLues = 0;
let lignesGardees = 0;

const debut = Date.now();

const tailleMB = (fs.statSync(INPUT_FILE).size / 1024 / 1024).toFixed(1);
console.log(`\n📥 Lecture de ${INPUT_FILE} (${tailleMB} MB compressé)...`);
console.log(`   Filtre : années ${YEAR_MIN}-${YEAR_MAX}, Appartement ou Maison, vente à 1 lot.\n`);

const stream = fs.createReadStream(INPUT_FILE).pipe(zlib.createGunzip());

const rl = readline.createInterface({
  input: stream,
  crlfDelay: Infinity,
});

// Parseur CSV minimal qui gère les champs entre guillemets contenant
// des virgules ou des guillemets échappés ("").
function parserLigneCSV(ligne) {
  const cellules = [];
  let courant = "";
  let dansGuillemets = false;

  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];

    if (dansGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') {
          courant += '"';
          i++;
        } else {
          dansGuillemets = false;
        }
      } else {
        courant += c;
      }
    } else {
      if (c === '"') {
        dansGuillemets = true;
      } else if (c === ",") {
        cellules.push(courant);
        courant = "";
      } else {
        courant += c;
      }
    }
  }
  cellules.push(courant);
  return cellules;
}

for await (const ligne of rl) {
  lignesLues++;

  if (lignesLues % 500_000 === 0) {
    const ecoule = ((Date.now() - debut) / 1000).toFixed(0);
    console.log(
      `  ${lignesLues.toLocaleString("fr-FR").padStart(11)} lignes lues, ` +
      `${lignesGardees.toLocaleString("fr-FR").padStart(9)} gardées ` +
      `(${ecoule}s)`
    );
  }

  // En-tête (1ère ligne)
  if (!entete) {
    entete = parserLigneCSV(ligne);
    entete.forEach((nom, i) => { colonnes[nom] = i; });

    const colonnesRequises = [
      "date_mutation", "nature_mutation", "valeur_fonciere",
      "code_departement", "type_local", "surface_reelle_bati",
      "nombre_lots", "longitude", "latitude"
    ];
    for (const c of colonnesRequises) {
      if (colonnes[c] === undefined) {
        console.error(`\n❌ Colonne "${c}" absente du CSV.`);
        console.error(`   En-têtes lus : ${entete.join(", ")}\n`);
        process.exit(1);
      }
    }
    continue;
  }

  const cellules = parserLigneCSV(ligne);

  // Filtre : type de mutation
  const nature = cellules[colonnes.nature_mutation];
  if (nature !== "Vente" && nature !== "Vente en l'état futur d'achèvement") continue;

  // Filtre : type de bien
  const type = cellules[colonnes.type_local];
  if (type !== "Appartement" && type !== "Maison") continue;

  // Filtre : mutations mono-lot (les multi-lots ont un prix "package")
  const nbLots = parseInt(cellules[colonnes.nombre_lots], 10) || 0;
  if (nbLots > 1) continue;

  // Filtre : année
  const date = cellules[colonnes.date_mutation];
  const annee = parseInt(date.slice(0, 4), 10);
  if (annee < YEAR_MIN || annee > YEAR_MAX) continue;

  // Filtre : prix cohérent
  const prix = parseFloat(cellules[colonnes.valeur_fonciere]);
  if (!prix || prix < 1000 || prix > 50_000_000) continue;

  // Filtre : surface cohérente
  const surface = parseFloat(cellules[colonnes.surface_reelle_bati]);
  if (!surface || surface < 5 || surface > 5000) continue;

  // Filtre : prix/m² dans un ordre de grandeur crédible
  const prixM2 = prix / surface;
  if (prixM2 < 500 || prixM2 > 50_000) continue;

  // Filtre : coordonnées GPS présentes et valides
  const lat = parseFloat(cellules[colonnes.latitude]);
  const lon = parseFloat(cellules[colonnes.longitude]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

  // Département
  const dept = cellules[colonnes.code_departement];
  if (!dept) continue;

  if (!parDept.has(dept)) parDept.set(dept, []);
  parDept.get(dept).push({
    la: +lat.toFixed(6),
    lo: +lon.toFixed(6),
    p:  Math.round(prix),
    s:  +surface.toFixed(1),
    t:  type === "Appartement" ? "A" : "M",
    d:  date,
  });

  lignesGardees++;
}

// ---------------------------------------------------------------------------
// Écriture des fichiers par département
// ---------------------------------------------------------------------------

console.log(
  `\n📊 ${lignesGardees.toLocaleString("fr-FR")} transactions gardées ` +
  `sur ${lignesLues.toLocaleString("fr-FR")} lignes ` +
  `(${((lignesGardees / lignesLues) * 100).toFixed(1)}%)`
);
console.log(`   Répartis sur ${parDept.size} départements.\n`);

const depts = [...parDept.keys()].sort();
let poidsTotal = 0;

for (const dept of depts) {
  const transactions = parDept.get(dept);
  const chemin = path.join(OUTPUT_DIR, `${dept}.json`);
  const contenu = JSON.stringify(transactions);
  fs.writeFileSync(chemin, contenu);
  poidsTotal += contenu.length;

  console.log(
    `  ${dept.padEnd(4)} ${transactions.length.toLocaleString("fr-FR").padStart(9)} tx ` +
    `→ ${(contenu.length / 1024 / 1024).toFixed(2).padStart(6)} MB`
  );
}

const duree = ((Date.now() - debut) / 1000).toFixed(0);

console.log(
  `\n✅ Terminé en ${duree}s. ` +
  `Poids total : ${(poidsTotal / 1024 / 1024).toFixed(1)} MB ` +
  `dans ${OUTPUT_DIR}/`
);
console.log(`\n💡 Étape suivante :`);
console.log(`   git add ${OUTPUT_DIR}/`);
console.log(`   git commit -m "chore(dvf): index DVF ${YEAR_MIN}-${YEAR_MAX} (v0.7.0)"`);
console.log(`   git push\n`);
