const url =
  "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=1&q=91000";

const response = await fetch(url);

console.log("Statut HTTP :", response.status);

const data = await response.json();

console.log(JSON.stringify(data, null, 2));