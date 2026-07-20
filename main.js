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

            for (let i = 0; i < operations.length; i++) {

                const op = operations[i];

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

                    // El sitio no recuerda la página actual: al volver de
                    // una operación (volverALista) la lista siempre se
                    // resetea a la página 1. La primera operación del lote
                    // ya queda bien posicionada (la trajo el irAPagina de
                    // la iteración anterior), pero desde la segunda en
                    // adelante hay que re-navegar antes de buscar la fila.
                    // Va dentro del try/catch (con timeout corto) porque si
                    // el sitio no dispara una petición nueva (p. ej. ya
                    // cree estar en esa página), esto no debe colgar/tumbar
                    // todo el proceso.
                    if (i > 0 && paginaActual > 1)
                        await irAPagina(page, paginaActual, 20000);

                    await abrirOperacion(page, op.targetBeneficiary, monto);
                    await mantenerSesion(page);

                    const pdf = await descargarPdfOperacion(page);
                    const nombreGuardado = guardar(nombre, pdf.data);

                    exitosas++;
                    enviar("log", { tipo: "ok", texto: nombreGuardado });

                    await volverALista(page);

                } catch (err) {

                    fallidas++;
                    enviar("log", { tipo: "error", texto: `${nombre} — ${err.message}` });
                    await volverALista(page).catch(() => {});

                    // Último recurso: si ni el reintento de abrirOperacion
                    // ni la re-navegación a la página bastaron, probamos
                    // con una recarga completa de la página (page.goto) en
                    // vez de solo clic en "Restablecer": si la sesión
                    // expiró o el sitio redirigió solo (se vio un caso
                    // donde el buscador quedó deshabilitado/sin registros y
                    // ya no reaccionaba a los clics), una recarga completa
                    // desde cero es lo único que lo destraba, igual que
                    // hacerlo manualmente.
                    try {

                        enviar("log", { tipo: "info", texto: `↺ Reintentando "${nombre}" con recarga completa + reaplicar filtro...` });

                        await page.goto("https://www.tlcbcp.com/#/h/bandeja-consulta");
                        await page.waitForTimeout(1000);
                        await aplicarFiltro(page, fechaDesde, fechaHasta);

                        if (paginaActual > 1)
                            await irAPagina(page, paginaActual, 20000);

                        await abrirOperacion(page, op.targetBeneficiary, monto);
                        await mantenerSesion(page);

                        const pdf = await descargarPdfOperacion(page);
                        const nombreGuardado = guardar(nombre, pdf.data);

                        exitosas++;
                        fallidas--;
                        enviar("log", { tipo: "ok", texto: `${nombreGuardado} (recuperado)` });

                        await volverALista(page);

                    } catch (err2) {

                        enviar("log", { tipo: "error", texto: `Falló también tras recarga completa: ${nombre} — ${err2.message}` });
                        await volverALista(page).catch(() => {});
                    }
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
