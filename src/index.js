const readline = require("readline/promises");
const { stdin, stdout } = require("process");

const { connect } = require("./connect");
const { aplicarFiltro, irAPagina } = require("./filtro");
const { abrirOperacion, descargarPdfOperacion, volverALista } = require("./operaciones");
const { mantenerSesion } = require("./sesion");
const { guardar, guardarReporte } = require("./download");
const { limpiar, fechaArchivo, formatMonto } = require("./utils");

function hoyDDMMYYYY(offsetDias = 0) {

    const d = new Date();
    d.setDate(d.getDate() + offsetDias);

    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");

    return `${dia}-${mes}-${d.getFullYear()}`;
}

async function preguntarFechas() {

    const rl = readline.createInterface({ input: stdin, output: stdout });

    const porDefectoDesde = hoyDDMMYYYY(-7);
    const porDefectoHasta = hoyDDMMYYYY(0);

    const desde = (await rl.question(`Fecha Desde (DD-MM-YYYY) [${porDefectoDesde}]: `)).trim();
    const hasta = (await rl.question(`Fecha Hasta (DD-MM-YYYY) [${porDefectoHasta}]: `)).trim();

    rl.close();

    return {
        fechaDesde: desde || porDefectoDesde,
        fechaHasta: hasta || porDefectoHasta
    };
}

(async () => {

    const { fechaDesde, fechaHasta } = await preguntarFechas();

    const logs = [];
    const registrar = (...args) => {
        const msg = args.join(" ");
        console.log(msg);
        logs.push(msg);
    };

    const { page } = await connect(msg => registrar(msg));

    await page.goto("https://www.tlcbcp.com/#/h/bandeja-consulta");
    await page.waitForTimeout(1000);

    let paginaActual = 1;

    let { operations, totalPages } = await aplicarFiltro(page, fechaDesde, fechaHasta);

    registrar(`Filtro aplicado: ${totalPages} página(s) de resultados.`);

    while (true) {

        registrar(`--- Página ${paginaActual} (${operations.length} operaciones) ---`);

        for (let i = 0; i < operations.length; i++) {

            const op = operations[i];

            await mantenerSesion(page);

            const monto = formatMonto(op.amount);
            const nombre = `${fechaArchivo(op.sendingDate)} - ${limpiar(op.targetBeneficiary)} - S ${monto}.pdf`;

            if (op.targetBeneficiary === "Varios beneficiarios") {
                registrar(`⏭ Omitido (Varios beneficiarios): ${nombre}`);
                continue;
            }

            try {

                // El sitio no recuerda la página actual: al volver de una
                // operación (volverALista) la lista siempre se resetea a la
                // página 1. La primera operación del lote ya queda bien
                // posicionada (la trajo el irAPagina de la iteración
                // anterior), pero desde la segunda en adelante hay que
                // re-navegar antes de buscar la fila. Va dentro del
                // try/catch (con timeout corto) porque si el sitio no
                // dispara una petición nueva (p. ej. ya cree estar en esa
                // página), esto no debe colgar/tumbar todo el script.
                if (i > 0 && paginaActual > 1)
                    await irAPagina(page, paginaActual, 20000);

                await abrirOperacion(page, op.targetBeneficiary, monto);
                await mantenerSesion(page);

                const pdf = await descargarPdfOperacion(page);
                const nombreGuardado = guardar(nombre, pdf.data);

                registrar(`✓ ${nombreGuardado}`);

                await volverALista(page);

            } catch (err) {

                registrar(`✗ Error con ${nombre} - ${err.message}`);
                await volverALista(page).catch(() => {});

                // Último recurso: si ni el reintento de abrirOperacion ni
                // la re-navegación a la página bastaron, probamos con una
                // recarga completa de la página (page.goto) en vez de solo
                // clic en "Restablecer": si la sesión expiró o el sitio
                // redirigió solo (se vio un caso donde el buscador quedó
                // deshabilitado/sin registros y ya no reaccionaba a los
                // clics), una recarga completa desde cero es lo único que
                // lo destraba, igual que hacerlo manualmente.
                try {

                    registrar("↺ Reintentando con recarga completa + reaplicar filtro...");

                    await page.goto("https://www.tlcbcp.com/#/h/bandeja-consulta");
                    await page.waitForTimeout(1000);
                    await aplicarFiltro(page, fechaDesde, fechaHasta);

                    if (paginaActual > 1)
                        await irAPagina(page, paginaActual, 20000);

                    await abrirOperacion(page, op.targetBeneficiary, monto);
                    await mantenerSesion(page);

                    const pdf = await descargarPdfOperacion(page);
                    const nombreGuardado = guardar(nombre, pdf.data);

                    registrar(`✓ (recuperado) ${nombreGuardado}`);

                    await volverALista(page);

                } catch (err2) {

                    registrar(`✗ Falló también tras recarga completa: ${nombre} - ${err2.message}`);
                    await volverALista(page).catch(() => {});
                }
            }
        }

        if (paginaActual >= totalPages)
            break;

        paginaActual++;
        operations = await irAPagina(page, paginaActual);
    }

    registrar("Proceso terminado.");

    try {
        const nombreReporte = guardarReporte(logs);
        console.log(`Reporte guardado como: ${nombreReporte}`);
    } catch (errReporte) {
        console.error(`No se pudo guardar el archivo de reporte: ${errReporte.message}`);
    }

})();
