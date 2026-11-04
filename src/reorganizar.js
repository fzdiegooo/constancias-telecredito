// Reorganiza las constancias ya descargadas: mueve cada PDF que está suelto en
// la raíz a una subcarpeta por empresa (sourceCompany) y actualiza la ruta en
// la base. Es idempotente: las que ya están en una subcarpeta se saltan.
//
//   node src/reorganizar.js        (o botón "Ordenar por empresa" en la GUI)

const fs = require("fs");
const path = require("path");
const { abrir } = require("./db");
const { carpetaConstancias, carpetaSegura } = require("./download");

// Encuentra un nombre libre dentro de destDir (agrega " (2)", " (3)"… si choca).
function nombreLibre(destDir, nombre) {
    const ext = path.extname(nombre);
    const base = nombre.slice(0, nombre.length - ext.length);
    let final = nombre, n = 2;
    while (fs.existsSync(path.join(destDir, final))) { final = `${base} (${n})${ext}`; n++; }
    return final;
}

function reorganizar(log = console.log) {
    const db = abrir();
    const carpeta = carpetaConstancias();

    const rows = db.prepare(
        "SELECT requestId, sourceCompany, pdf_archivo FROM operaciones WHERE pdf_archivo IS NOT NULL AND pdf_archivo <> ''"
    ).all();

    let movidos = 0, yaOrdenados = 0, soloBase = 0, faltan = 0;

    for (const r of rows) {
        const rel = r.pdf_archivo;

        // Ya está dentro de una subcarpeta: nada que hacer.
        if (rel.includes("/") || rel.includes("\\")) { yaOrdenados++; continue; }

        const sub = carpetaSegura(r.sourceCompany);
        const destDir = path.join(carpeta, sub);
        const origen = path.join(carpeta, rel);

        if (!fs.existsSync(origen)) {
            // Quizá ya se movió antes pero la base quedó con la ruta vieja.
            const posible = path.join(destDir, rel);
            if (fs.existsSync(posible)) {
                db.prepare("UPDATE operaciones SET pdf_archivo=? WHERE requestId=?").run(path.join(sub, rel), r.requestId);
                soloBase++;
            } else {
                faltan++;
            }
            continue;
        }

        fs.mkdirSync(destDir, { recursive: true });
        const nombreFinal = nombreLibre(destDir, rel);
        fs.renameSync(origen, path.join(destDir, nombreFinal));
        db.prepare("UPDATE operaciones SET pdf_archivo=? WHERE requestId=?").run(path.join(sub, nombreFinal), r.requestId);
        movidos++;
    }

    db.close();
    log(`Reorganización: ${movidos} movidas a su empresa, ${yaOrdenados} ya ordenadas, ${soloBase} corregidas en base, ${faltan} sin archivo en disco.`);
    return { movidos, yaOrdenados, soloBase, faltan };
}

module.exports = { reorganizar };

if (require.main === module) {
    reorganizar();
}
