// CLI del método directo por API (rápido, sin manejar la UI).
//   node src/apicli.js [dateFrom DD-MM-YYYY] [dateTo DD-MM-YYYY]
//
// 1) Se conecta al navegador del banco ya logueado (abrir antes con la app o
//    con `node src/abrir.js`).
// 2) Trae todas las operaciones del rango en pocas llamadas.
// 3) Guarda los datos de TODAS en SQLite.
// 4) Baja el PDF de las transferencias por API directa; las demás quedan
//    marcadas 'no_soportado' (PDF se arma en cliente; se cubre en Fase 2).

const { crearSesion, buscarTodas, descargarPdfTransferencia, descargarArchivoHaberes, obtenerDetalle, esTransferencia } = require("./apiclient");
const { abrir, guardarOperacion, guardarDetalle, marcarPdf, estadoPdf } = require("./db");
const { construirHtml } = require("./constancia");

// Estados de PDF que ya consideramos "listos" (no se re-descargan en un sync
// incremental salvo que se pida forzar).
const PDF_LISTO = new Set(["descargado", "generado"]);
const { guardar, carpetaConstancias } = require("./download");
const { limpiar, fechaArchivo, formatMonto } = require("./utils");

function hoyDDMMYYYY(offsetDias = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDias);
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    return `${dia}-${mes}-${d.getFullYear()}`;
}

async function correr(fechaDesde, fechaHasta, log = console.log, opciones = {}) {
    const forzar = !!opciones.forzar;
    const db = abrir();
    log(`Base de datos: ${require("./db").rutaBaseDatos()}`);

    log("Conectando al navegador y capturando token...");
    const sesion = await crearSesion(log);
    log(`Token OK (expira en ${sesion.expSegundos()}s).`);

    log(`Buscando operaciones ${fechaDesde} a ${fechaHasta}...`);
    const ops = await buscarTodas(sesion, fechaDesde, fechaHasta, log);
    log(`Encontradas ${ops.length} operaciones.`);

    // Guardar TODOS los datos primero (aunque luego falle algún PDF).
    for (const op of ops) guardarOperacion(db, op);
    log(`Datos de ${ops.length} operaciones guardados en SQLite.`);

    let exitosas = 0, fallidas = 0, clientePendiente = 0, noSoportadas = 0, yaExistentes = 0;

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const monto = formatMonto(op.amount);
        const etiqueta = limpiar(op.targetBeneficiary || op.reference || String(op.requestId));
        const nombre = `${fechaArchivo(op.sendingDate)} - ${etiqueta} - S ${monto}.pdf`;
        const pos = `[${i + 1}/${ops.length}]`;

        // Sync incremental: si el PDF ya estaba listo, no lo re-descargamos.
        if (!forzar) {
            const previo = estadoPdf(db, op.requestId);
            if (previo && PDF_LISTO.has(previo.pdf_estado)) {
                yaExistentes++;
                continue;
            }
        }

        try {

            if (esTransferencia(op.product)) {
                const base64 = await descargarPdfTransferencia(sesion, op.requestId, op.product);
                const archivo = guardar(nombre, base64);
                marcarPdf(db, op.requestId, "descargado", archivo);
                exitosas++;
                log(`✓ ${pos} ${archivo}`);

            } else if (op.product === "MP_SALARIES") {
                const { base64 } = await descargarArchivoHaberes(sesion, op.requestId, "P");
                const nombreHaberes = `${fechaArchivo(op.sendingDate)} - HABERES ${op.requestId} - S ${monto}.pdf`;
                const archivo = guardar(nombreHaberes, base64);
                marcarPdf(db, op.requestId, "descargado", archivo);
                exitosas++;
                log(`✓ ${pos} ${archivo}`);

            } else {
                // Tipos cuyo PDF el banco arma en cliente (servicios, documentos):
                // traemos el detalle rico, lo guardamos y generamos una
                // constancia propia con el estilo del banco (constancia.js).
                const detalle = await obtenerDetalle(sesion, op.product, op.requestId);
                if (detalle) guardarDetalle(db, op.requestId, detalle);

                const html = construirHtml(op, detalle);

                if (html) {
                    const base64 = await sesion.renderizarPdf(html);
                    const archivo = guardar(nombre, base64);
                    marcarPdf(db, op.requestId, "generado", archivo);
                    exitosas++;
                    log(`✓ ${pos} ${archivo} (constancia generada)`);
                } else {
                    // Tipos sin detalle/plantilla aún (PAGELE_*): solo datos.
                    marcarPdf(db, op.requestId, "cliente_pendiente");
                    clientePendiente++;
                    log(`◧ ${pos} ${op.product} (datos guardados, sin plantilla): ${nombre}`);
                }
            }

        } catch (err) {
            fallidas++;
            marcarPdf(db, op.requestId, "error", null, err.message);
            log(`✗ ${pos} ${nombre} — ${err.message}`);
        }
    }

    db.close();
    await sesion.cerrar();

    log(`\nListo. Nuevos PDF: ${exitosas}, ya existentes: ${yaExistentes}, con error: ${fallidas}, ` +
        `pendientes: ${clientePendiente}, no soportados: ${noSoportadas}. ` +
        `Carpeta: ${carpetaConstancias()}`);

    return { exitosas, fallidas, clientePendiente, noSoportadas, yaExistentes, total: ops.length };
}

if (require.main === module) {
    const fechaDesde = process.argv[2] || hoyDDMMYYYY(-7);
    const fechaHasta = process.argv[3] || hoyDDMMYYYY(0);

    correr(fechaDesde, fechaHasta)
        .catch(err => { console.error("ERROR FATAL:", err.message); process.exit(1); });
}

module.exports = { correr };
