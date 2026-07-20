const fs = require("fs");
const path = require("path");
const os = require("os");

function carpetaConstancias() {

    const carpeta = path.join(os.homedir(), "Documents", "Constancias TeleCredito");

    if (!fs.existsSync(carpeta))
        fs.mkdirSync(carpeta, { recursive: true });

    return carpeta;
}

function guardar(nombre, base64) {

    const carpeta = carpetaConstancias();

    // Dos operaciones distintas pueden generar exactamente el mismo nombre
    // de archivo (mismo beneficiario, misma fecha, mismo monto) — sin esta
    // desambiguación, la segunda pisa el PDF de la primera en disco. Si el
    // nombre ya existe, agregamos un sufijo " (2)", " (3)", etc. hasta
    // encontrar uno libre.
    const ext = path.extname(nombre);
    const base = nombre.slice(0, nombre.length - ext.length);

    let nombreFinal = nombre;
    let contador = 2;

    while (fs.existsSync(path.join(carpeta, nombreFinal))) {
        nombreFinal = `${base} (${contador})${ext}`;
        contador++;
    }

    fs.writeFileSync(
        path.join(carpeta, nombreFinal),
        Buffer.from(base64, "base64")
    );

    return nombreFinal;
}

module.exports = {
    guardar,
    carpetaConstancias
};