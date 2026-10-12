// Shell de escritorio (Electron) para la GUI de Constancias TeleCrédito.
// La GUI real es una app web local servida por el node del sistema
// (src/server.js), porque usa node:sqlite, que el Node de Electron (v20) no
// trae. Electron solo lanza ese servidor y muestra su ventana de escritorio.

const { app, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PUERTO = Number(process.env.PORT) || 4599;
const URL_GUI = `http://localhost:${PUERTO}`;

let ventana;
let servidor;

function lanzarServidor() {
    // Node del sistema (v22.5+) para tener node:sqlite. Electron trae Node 20.
    servidor = spawn("node", ["--no-warnings", path.join(__dirname, "src", "server.js")], {
        cwd: __dirname,
        env: { ...process.env, NO_BROWSER: "1", PORT: String(PUERTO) },
        stdio: "inherit"
    });

    servidor.on("error", (err) => {
        const msg = err.code === "ENOENT"
            ? "No se encontró 'node' en el sistema. Instala Node.js (v22.5+) para usar la aplicación."
            : `No se pudo iniciar el servidor: ${err.message}`;
        mostrarError(msg);
    });
}

// Espera a que el servidor responda antes de cargar la ventana.
function esperarServidor(intentos = 60) {
    return new Promise((resolve, reject) => {
        const probar = (n) => {
            const req = http.get(URL_GUI, (res) => { res.destroy(); resolve(); });
            req.on("error", () => {
                if (n <= 0) return reject(new Error("El servidor no respondió a tiempo."));
                setTimeout(() => probar(n - 1), 300);
            });
        };
        probar(intentos);
    });
}

function crearVentana() {
    ventana = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        title: "Constancias TeleCrédito",
        webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    ventana.setMenuBarVisibility(false);
    ventana.loadURL(URL_GUI);
}

function mostrarError(mensaje) {
    if (!ventana || ventana.isDestroyed()) {
        ventana = new BrowserWindow({ width: 700, height: 300, title: "Error" });
        ventana.setMenuBarVisibility(false);
    }
    ventana.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
        `<body style="font-family:sans-serif;padding:30px;color:#b42727">
         <h2>No se pudo iniciar</h2><p>${mensaje}</p></body>`));
}

app.whenReady().then(async () => {
    lanzarServidor();
    try {
        await esperarServidor();
        crearVentana();
    } catch (err) {
        mostrarError(err.message);
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("quit", () => {
    if (servidor) servidor.kill();
});
