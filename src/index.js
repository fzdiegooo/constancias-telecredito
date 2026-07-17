const readline = require("readline/promises");
const { stdin, stdout } = require("process");

const { connect } = require("./connect");
const { aplicarFiltro, irAPagina } = require("./filtro");
const { abrirOperacion, descargarPdfOperacion, volverALista } = require("./operaciones");
const { mantenerSesion } = require("./sesion");
const { guardar } = require("./download");
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

    const { page } = await connect(msg => console.log(msg));

    await page.goto("https://www.tlcbcp.com/#/h/bandeja-consulta");
    await page.waitForTimeout(1000);

    let paginaActual = 1;

    let { operations, totalPages } = await aplicarFiltro(page, fechaDesde, fechaHasta);

    console.log(`Filtro aplicado: ${totalPages} página(s) de resultados.`);

    while (true) {

        console.log(`--- Página ${paginaActual} (${operations.length} operaciones) ---`);

        for (const op of operations) {

            await mantenerSesion(page);

            const monto = formatMonto(op.amount);
            const nombre = `${fechaArchivo(op.sendingDate)} - ${limpiar(op.targetBeneficiary)} - S ${monto}.pdf`;

            if (op.targetBeneficiary === "Varios beneficiarios") {
                console.log("⏭ Omitido (Varios beneficiarios):", nombre);
                continue;
            }

            try {

                await abrirOperacion(page, op.targetBeneficiary, monto);
                await mantenerSesion(page);

                const pdf = await descargarPdfOperacion(page);
                guardar(nombre, pdf.data);

                console.log("✓", nombre);

                await volverALista(page);

            } catch (err) {

                console.log("✗ Error con", nombre, "-", err.message);
                await volverALista(page).catch(() => {});
            }
        }

        if (paginaActual >= totalPages)
            break;

        paginaActual++;
        operations = await irAPagina(page, paginaActual);
    }

    console.log("Proceso terminado.");

})();
