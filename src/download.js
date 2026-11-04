const fs = require("fs");
const path = require("path");
const os = require("os");

function carpetaConstancias() {

    const carpeta = process.env.CONSTANCIAS_DIR
        || path.join(os.homedir(), "Documents", "Constancias TeleCredito");

    if (!fs.existsSync(carpeta))
        fs.mkdirSync(carpeta, { recursive: true });

    return carpeta;
}

// Nombre de carpeta seguro para el sistema de archivos (una por empresa).
function carpetaSegura(nombre) {
    const limpio = String(nombre || "")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return limpio || "Sin empresa";
}

// Guarda el PDF dentro de una subcarpeta por empresa. Devuelve la ruta
// RELATIVA a carpetaConstancias() (p. ej. "FRUTICOLA SELVA SAC/archivo.pdf"),
// que es lo que se guarda en la base y usa el servidor para servir el archivo.
function guardar(nombre, base64, empresa) {

    const sub = empresa !== undefined ? carpetaSegura(empresa) : null;
    const carpeta = sub ? path.join(carpetaConstancias(), sub) : carpetaConstancias();

    if (!fs.existsSync(carpeta))
        fs.mkdirSync(carpeta, { recursive: true });

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

    return sub ? path.join(sub, nombreFinal) : nombreFinal;
}

function guardarReporte(logs) {
    const carpeta = carpetaConstancias();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fechaHora = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const nombreReporte = `Reporte - ${fechaHora}.txt`;
    const rutaReporte = path.join(carpeta, nombreReporte);

    fs.writeFileSync(rutaReporte, logs.join("\n"), "utf8");
    return nombreReporte;
}

module.exports = {
    guardar,
    carpetaConstancias,
    carpetaSegura,
    guardarReporte
};