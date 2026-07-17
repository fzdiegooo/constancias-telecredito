const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");

const { connect } = require("./src/connect");
const { aplicarFiltro, irAPagina } = require("./src/filtro");
const { abrirOperacion, descargarPdfOperacion, volverALista } = require("./src/operaciones");
const { mantenerSesion } = require("./src/sesion");
const { guardar, carpetaConstancias } = require("./src/download");
const { limpiar, fechaArchivo, formatMonto } = require("./src/utils");

let ventana;
let sesion = null; // { browser, page } una vez que el navegador está abierto

function crearVentana() {

    ventana = new BrowserWindow({
        width: 720,
        height: 640,
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    ventana.setMenuBarVisibility(false);
    ventana.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(crearVentana);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

function enviar(canal, datos) {
    if (ventana && !ventana.isDestroyed()) {
        ventana.webContents.send(canal, datos);
    }
}

// Paso 1: abrir/conectar el navegador y dejarlo listo para que el usuario inicie sesión
ipcMain.on("abrir-navegador", async () => {

    try {

        const { page } = await connect(msg => enviar("estado", msg));

        sesion = { page };

        enviar("estado", "Inicia sesión en el banco con tu tarjeta y clave. Cuando veas el menú principal, presiona 'Continuar'.");
        enviar("navegador-listo");

    } catch (err) {

        enviar("error-fatal", err.message);
    }
});

// Paso 2: aplicar filtro y descargar constancias
ipcMain.on("buscar-y-descargar", async (event, { fechaDesde, fechaHasta }) => {

    if (!sesion) {
        enviar("error-fatal", "Primero abre el navegador e inicia sesión.");
        return;
    }

    const { page } = sesion;

    try {

        enviar("estado", "Abriendo Estado de operaciones...");

        await page.goto("https://www.tlcbcp.com/#/h/bandeja-consulta");
        await page.waitForTimeout(1000);

        enviar("estado", "Aplicando filtro (Procesada, fechas seleccionadas)...");

        let { operations, totalPages } = await aplicarFiltro(page, fechaDesde, fechaHasta);

        let exitosas = 0;
        let fallidas = 0;
        let procesadas = 0;

        let paginaActual = 1;

        while (true) {

            for (const op of operations) {

                await mantenerSesion(page);

                const monto = formatMonto(op.amount);
                const nombre = `${fechaArchivo(op.sendingDate)} - ${limpiar(op.targetBeneficiary)} - S ${monto}.pdf`;

                if (op.targetBeneficiary === "Varios beneficiarios") {
                    procesadas++;
                    enviar("log", { tipo: "omitido", texto: `Omitido (Varios beneficiarios): ${nombre}` });
                    enviar("progreso", { actual: procesadas, pagina: paginaActual, totalPaginas: totalPages });
                    continue;
                }

                procesadas++;

                try {

                    await abrirOperacion(page, op.targetBeneficiary, monto);
                    await mantenerSesion(page);

                    const pdf = await descargarPdfOperacion(page);
                    guardar(nombre, pdf.data);

                    exitosas++;
                    enviar("log", { tipo: "ok", texto: nombre });

                    await volverALista(page);

                } catch (err) {

                    fallidas++;
                    enviar("log", { tipo: "error", texto: `${nombre} — ${err.message}` });
                    await volverALista(page).catch(() => {});
                }

                enviar("progreso", { actual: procesadas, pagina: paginaActual, totalPaginas: totalPages });
            }

            if (paginaActual >= totalPages) break;

            paginaActual++;
            enviar("estado", `Cargando página ${paginaActual} de ${totalPages}...`);
            operations = await irAPagina(page, paginaActual);
        }

        enviar("finalizado", { exitosas, fallidas, carpeta: carpetaConstancias() });

    } catch (err) {

        enviar("error-fatal", err.message);
    }
});

ipcMain.on("abrir-carpeta", () => {
    shell.openPath(carpetaConstancias());
});
