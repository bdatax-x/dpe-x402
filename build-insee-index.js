// ============================================================================
// build-insee-index.js — Préparation de l'index INSEE FILOSOFI pour DPE-X402
//
// Ce script convertit le fichier FILOSOFI 2021 commune-level de l'INSEE
// (format SDMX long, une ligne par mesure) en petits fichiers JSON par
// département, prêts à être servis par server.js.
//
// À lancer une seule fois sur ta machine (et à chaque nouvelle publication
// INSEE, en général tous les 12 à 18 mois).
//
// ----------------------------------------------------------------------------
// MODE D'EMPLOI
// ----------------------------------------------------------------------------
//
//   1. Télécharger le fichier FILOSOFI commune-level (~4 Mo compressé) :
//
//      Lien direct (géographie 2025, dernière version) :
//        https://www.insee.fr/fr/statistiques/fichier/7756729/base-cc-filosofi-2021-geo2025_csv.zip
//
//   2. Dézipper le ZIP pour obtenir le fichier CSV
//      (DS_FILOSOFI_CC_data.csv - ~200 Mo décompressé, format SDMX long).
//
//   3. Depuis ce dossier, lancer :
//        node build-insee-index.js "DS_FILOSOFI_CC_data.csv"
//
//   4. Le dossier data/insee/ sera créé avec un fichier .json par département.
//
// ----------------------------------------------------------------------------
// FORMAT D'ENTRÉE (SDMX long, une ligne par observation)
// ----------------------------------------------------------------------------
//
// Colonnes principales :
//   GEO              : identifiant géographique (ex: COM-75101)
//   GEO_OBJECT       : type de géographie (COM = commune, DEP = département, ...)
//   FILOSOFI_MEASURE : indicateur mesuré (MED, TP60, D1, D9, RD, PACT, PTSA...)
//   OBS_VALUE        : valeur numérique
//   TIME_PERIOD      : année de référence (on garde la plus récente)
//   OBS_STATUS       : statut (secret statistique, non disponible, etc.)
//
// ----------------------------------------------------------------------------
// FORMAT DE SORTIE
// ----------------------------------------------------------------------------
//
// data/insee/{dept}.json = objet { "codeInsee": {données}, ... } :
//   {
//     "75101": {
//       "rm":  38210,   // MED = médiane niveau de vie (€/an/UC)
//       "tp":  8.4,     // TP60 = taux de pauvreté 60% (%)
//       "d1":  17920,   // D1 = 1er décile (€)
//       "d9":  84300,   // D9 = 9e décile (€)
//       "rd":  4.7,     // RD = rapport interdécile
//       "pa":  59.2,    // PACT = part actifs (%)
//       "pr":  22.8     // PTSA = part pensions/retraites (%)
//     },
//     ...
//   }
// ============================================================================

import fs from "fs";
import path from "path";

const OUTPUT_DIR = "data/insee";

// Mapping des mesures INSEE FILOSOFI qu'on garde et vers quel champ court.
// Codes officiels du dispositif FILOSOFI (SDMX INSEE 2026) — voir metadata :
//   MED_SL       : Niveau de vie médian (€/an)
//   D1_SL / D9_SL: 1er et 9e décile du niveau de vie (€/an)
//   IR_D9_D1_SL  : Rapport interdécile D9/D1
//   PR_MD60      : Taux de pauvreté au seuil de 60% (%)
//   S_EI_DI_SAL  : Part des salaires dans le revenu disponible (%)
//   S_RET_PEN_DI : Part des pensions/retraites dans le revenu disponible (%)
//   NUM_HH / NUM_PER : Nombre de ménages / de personnes (indicatif)
const MESURES = {
  "MED_SL":       "rm",    // Médiane niveau de vie
  "D1_SL":        "d1",    // 1er décile
  "D9_SL":        "d9",    // 9e décile
  "IR_D9_D1_SL":  "rd",    // Rapport interdécile
  "PR_MD60":      "tp",    // Taux de pauvreté à 60%
  "S_EI_DI_SAL":  "pa",    // Part des salaires (proxy d'activité)
  "S_RET_PEN_DI": "pr",    // Part des pensions/retraites
  "NUM_HH":       "nm",    // Nombre de ménages
  "NUM_PER":      "np"     // Nombre de personnes
};

// Retourne le champ court si la mesure INSEE est reconnue, sinon null
function champCourt(mesureBrute) {
  if (!mesureBrute) return null;
  const m = String(mesureBrute).trim().toUpperCase();
  return MESURES[m] ?? null;
}

// ---------------------------------------------------------------------------
// Fichier d'entrée
// ---------------------------------------------------------------------------

function trouverFichierCSV() {
  if (process.argv[2]) return process.argv[2];
  const candidats = fs
    .readdirSync(".")
    .filter(f => {
      const bas = f.toLowerCase();
      return (bas.includes("filosofi") || bas.includes("base-cc")) &&
             bas.endsWith(".csv") &&
             !bas.includes("metadata");
    });
  if (candidats.length === 1) {
    console.log(`ℹ️  Fichier "${candidats[0]}" détecté automatiquement.\n`);
    return candidats[0];
  }
  if (candidats.length > 1) {
    console.error(`\n❌ Plusieurs CSV FILOSOFI trouvés — précise lequel :\n`);
    for (const c of candidats) console.error(`   node build-insee-index.js "${c}"`);
    process.exit(1);
  }
  return null;
}

const INPUT_FILE = trouverFichierCSV();

if (!INPUT_FILE || !fs.existsSync(INPUT_FILE)) {
  console.error(`\n❌ CSV FILOSOFI introuvable. Voir en-tête du script pour l'URL de téléchargement.\n`);
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Parseur CSV minimal
// ---------------------------------------------------------------------------

function parserLigneCSV(ligne) {
  // Format SDMX INSEE : séparateur point-virgule, valeurs possiblement entre guillemets
  const cellules = [];
  let courant = "";
  let dansGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') { courant += '"'; i++; }
        else dansGuillemets = false;
      } else courant += c;
    } else {
      if (c === '"') dansGuillemets = true;
      else if (c === ';') { cellules.push(courant); courant = ""; }
      else courant += c;
    }
  }
  cellules.push(courant);
  return cellules;
}

// ---------------------------------------------------------------------------
// Lecture streamée (le fichier peut faire 200+ Mo décompressé)
// ---------------------------------------------------------------------------

import readline from "readline";

console.log(`\n📥 Lecture streamée de ${INPUT_FILE}...\n`);

const rl = readline.createInterface({
  input: fs.createReadStream(INPUT_FILE, { encoding: "utf8" }),
  crlfDelay: Infinity
});

// ---------------------------------------------------------------------------
// Accumulation : Map<codeInsee, {mesures}>
// ---------------------------------------------------------------------------

const parCommune = new Map();

let entete = null;
const colonnes = {};

let idxGEO, idxGEO_OBJ, idxMESURE, idxVALUE, idxYEAR, idxSTATUS;

let lignesLues = 0;
let lignesGardees = 0;

function parseNombreINSEE(val) {
  if (val === undefined || val === null) return null;
  const trim = String(val).trim();
  if (trim === "" || trim === "s" || trim === "nd" || trim === "ns" || trim === "*") return null;
  const propre = trim.replace(/\s/g, "").replace(",", ".");
  const num = parseFloat(propre);
  return Number.isFinite(num) ? num : null;
}

const debut = Date.now();

for await (const ligne of rl) {
  lignesLues++;

  if (!entete) {
    entete = parserLigneCSV(ligne).map(s => s.trim().replace(/^"|"$/g, ""));
    entete.forEach((nom, i) => { colonnes[nom] = i; });

    idxGEO      = colonnes["GEO"];
    idxGEO_OBJ  = colonnes["GEO_OBJECT"];
    idxMESURE   = colonnes["FILOSOFI_MEASURE"] ?? colonnes["MEASURE"] ?? colonnes["INDICATOR"];
    idxVALUE    = colonnes["OBS_VALUE"] ?? colonnes["VALUE"];
    idxYEAR     = colonnes["TIME_PERIOD"] ?? colonnes["TIME"];
    idxSTATUS   = colonnes["OBS_STATUS"];

    console.log(`Colonnes détectées :`);
    console.log(`  GEO              : col ${idxGEO}`);
    console.log(`  GEO_OBJECT       : col ${idxGEO_OBJ}`);
    console.log(`  FILOSOFI_MEASURE : col ${idxMESURE}`);
    console.log(`  OBS_VALUE        : col ${idxVALUE}`);
    console.log(`  TIME_PERIOD      : col ${idxYEAR}`);
    console.log(`  OBS_STATUS       : col ${idxSTATUS}`);

    if (idxGEO === undefined || idxMESURE === undefined || idxVALUE === undefined) {
      console.error(`\n❌ Colonnes essentielles manquantes.`);
      console.error(`   Toutes les colonnes trouvées : ${entete.join(", ")}`);
      process.exit(1);
    }
    console.log("");
    continue;
  }

  if (lignesLues % 100_000 === 0) {
    console.log(`  ${lignesLues.toLocaleString("fr-FR")} lignes lues, ${parCommune.size.toLocaleString("fr-FR")} communes accumulées…`);
  }

  const cellules = parserLigneCSV(ligne);

  // Filtre : uniquement communes (COM)
  const geoObj = String(cellules[idxGEO_OBJ] || "").trim().toUpperCase();
  if (geoObj !== "COM") continue;

  // Extraction du code INSEE depuis GEO (format "COM-75101" ou "75101")
  let geoBrut = String(cellules[idxGEO] || "").trim();
  let codeInsee = geoBrut;
  if (codeInsee.includes("-")) {
    const parts = codeInsee.split("-");
    codeInsee = parts[parts.length - 1];
  }
  if (!codeInsee) continue;

  // Statut : ignore les valeurs sous secret statistique
  const status = String(cellules[idxSTATUS] || "").trim().toUpperCase();
  if (status === "S" || status === "M" || status === "F") continue;

  // Mesure : on ne garde que celles qui nous intéressent
  const mesure = cellules[idxMESURE];
  const champ = champCourt(mesure);
  if (!champ) continue;

  // Valeur
  const val = parseNombreINSEE(cellules[idxVALUE]);
  if (val === null) continue;

  // Accumulation
  if (!parCommune.has(codeInsee)) parCommune.set(codeInsee, {});
  const obj = parCommune.get(codeInsee);

  // On garde la valeur la plus récente si TIME_PERIOD est là
  const annee = idxYEAR !== undefined ? parseInt(String(cellules[idxYEAR] || "").trim(), 10) : 0;
  const cleAnnee = `_year_${champ}`;
  if (!obj[cleAnnee] || annee >= obj[cleAnnee]) {
    obj[champ] = val;
    obj[cleAnnee] = annee || 0;
  }
  lignesGardees++;
}

// Nettoyage : retire les métadonnées _year_*
for (const [_, obj] of parCommune) {
  for (const k of Object.keys(obj)) if (k.startsWith("_year_")) delete obj[k];
}

console.log(`\n📊 ${lignesGardees.toLocaleString("fr-FR")} observations gardées sur ${lignesLues.toLocaleString("fr-FR")} lignes.`);
console.log(`   ${parCommune.size.toLocaleString("fr-FR")} communes avec au moins un indicateur.\n`);

// ---------------------------------------------------------------------------
// Regroupement par département et écriture
// ---------------------------------------------------------------------------

const parDept = new Map();

for (const [codeInsee, donnees] of parCommune) {
  let dept;
  if (codeInsee.startsWith("97") || codeInsee.startsWith("98")) {
    dept = codeInsee.slice(0, 3);
  } else if (codeInsee.startsWith("2A") || codeInsee.startsWith("2B")) {
    dept = codeInsee.slice(0, 2);
  } else {
    dept = codeInsee.slice(0, 2);
  }
  if (!parDept.has(dept)) parDept.set(dept, {});
  parDept.get(dept)[codeInsee] = donnees;
}

const depts = [...parDept.keys()].sort();
let poidsTotal = 0;

for (const dept of depts) {
  const dict = parDept.get(dept);
  const nbComm = Object.keys(dict).length;
  const chemin = path.join(OUTPUT_DIR, `${dept}.json`);
  const contenu = JSON.stringify(dict);
  fs.writeFileSync(chemin, contenu);
  poidsTotal += contenu.length;

  console.log(
    `  ${dept.padEnd(4)} ${nbComm.toString().padStart(5)} communes ` +
    `→ ${(contenu.length / 1024).toFixed(1).padStart(7)} KB`
  );
}

const duree = ((Date.now() - debut) / 1000).toFixed(0);
console.log(`\n✅ Terminé en ${duree}s. Poids total : ${(poidsTotal / 1024).toFixed(1)} KB dans ${OUTPUT_DIR}/`);
console.log(`\n💡 Étape suivante :`);
console.log(`   git add ${OUTPUT_DIR}/`);
console.log(`   git commit -m "chore(insee): index FILOSOFI 2021 (v0.7.2)"`);
console.log(`   git push\n`);
