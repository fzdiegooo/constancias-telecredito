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

    fs.writeFileSync(
        path.join(carpetaConstancias(), nombre),
        Buffer.from(base64, "base64")
    );

}

module.exports = {
    guardar,
    carpetaConstancias
};