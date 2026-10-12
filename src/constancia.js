// Genera una constancia en PDF con el estilo visual de TeleCrédito BCP para los
// tipos de operación cuyo PDF el banco arma en el cliente (no hay endpoint de
// archivo): Pago de servicios y Pago de letras/facturas (documentos). Se arma
// un HTML calcado del diseño del banco (logo, título azul, secciones con barra
// naranja, label gris + valor, dot verde en "Procesada") y se renderiza a PDF.
//
// Referencia de estilo: la constancia real de transferencias (misma plantilla
// del banco), ver scratchpad/ref_transfer. Los datos salen del detalle que
// expone la API (obtenerDetalle) + la fila del search.

// --- Helpers de formato ---

function escapar(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function simboloMoneda(code) {
    // "001"/"1"/"PEN" -> S/ ; "002"/"2"/"USD" -> $
    const c = String(code || "").toUpperCase();
    if (c === "002" || c === "2" || c === "USD") return "$";
    return "S/";
}

function formatMontoConSimbolo(monto, code) {
    const n = Number(monto).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${simboloMoneda(code)} ${n}`;
}

// ISO -> "DD/MM/YYYY - hh:mm a. m./p. m." (igual que muestra el banco).
function formatFechaHora(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const p = (n) => String(n).padStart(2, "0");
    let h = d.getHours();
    const ampm = h < 12 ? "a. m." : "p. m.";
    h = h % 12; if (h === 0) h = 12;
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} - ${p(h)}:${p(d.getMinutes())} ${ampm}`;
}

// --- Plantilla HTML (estilo BCP) ---

// Logo BCP aproximado (chevrons naranjas + "BCP" azul, bold itálico).
const LOGO_BCP = `
<svg width="120" height="42" viewBox="0 0 120 42" xmlns="http://www.w3.org/2000/svg">
  <g fill="#EC6707">
    <path d="M2 8 L14 8 L22 21 L14 34 L2 34 L10 21 Z"/>
    <path d="M100 8 L112 8 L120 21 L112 34 L100 34 L108 21 Z"/>
  </g>
  <text x="30" y="31" font-family="Arial, Helvetica, sans-serif" font-size="30"
        font-weight="bold" font-style="italic" fill="#003a7a">BCP</text>
</svg>`;

// seccion = { titulo, filas: [ [label, valor, opts?] ] }  opts: { dot:true }
function plantilla({ tituloEstado, subtitulo, secciones }) {
    const seccionHtml = (s) => `
      <div class="seccion">
        <h2><span class="barra"></span>${escapar(s.titulo)}</h2>
        <table>
          ${s.filas.filter(f => f[1] !== "" && f[1] != null).map(f => `
            <tr>
              <td class="label">${escapar(f[0])}</td>
              <td class="valor">${f[2] && f[2].dot ? '<span class="dot"></span>' : ""}${escapar(f[1])}</td>
            </tr>`).join("")}
        </table>
      </div>`;

    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #2b2b2b; margin: 0; padding: 36px 44px; font-size: 12px; }
  .logo { margin-bottom: 26px; }
  .titulo { color: #0a5ca8; font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .subtitulo { color: #2b2b2b; font-size: 15px; margin: 0 0 28px; }
  .seccion { margin-bottom: 22px; }
  .seccion h2 { color: #0a5ca8; font-size: 13px; font-weight: 600; margin: 0 0 10px; display: flex; align-items: center; }
  .barra { display: inline-block; width: 4px; height: 15px; background: #EC6707; margin-right: 9px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; vertical-align: top; }
  .label { color: #8a8f98; width: 38%; padding-left: 18px; }
  .valor { color: #2b2b2b; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #35b63a; margin-right: 7px; vertical-align: middle; }
</style></head>
<body>
  <div class="logo">${LOGO_BCP}</div>
  <div class="titulo">${escapar(tituloEstado)}</div>
  <div class="subtitulo">${escapar(subtitulo)}</div>
  ${secciones.map(seccionHtml).join("")}
</body></html>`;
}

function subtituloHoy() {
    const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    const d = new Date();
    let h = d.getHours(); const ampm = h < 12 ? "a. m." : "p. m."; h = h % 12 || 12;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getDate()} de ${meses[d.getMonth()]} ${d.getFullYear()} a las ${p(h)}:${p(d.getMinutes())} ${ampm}`;
}

// --- Construcción por tipo ---

function htmlPagoServicios(op, d) {
    const od = d.operationDetail || {};
    const moneda = op.currencyCode || od.currencyCode;

    return plantilla({
        tituloEstado: `Consulta de Operaciones -  ${od.status || "Procesada"}`,
        subtitulo: subtituloHoy(),
        secciones: [
            { titulo: "Datos de la operación", filas: [
                ["Tipo de operación", od.product || "Pago de servicios"],
                ["Estado", od.status || "Procesada", { dot: true }],
                ["Número de operación", d.operationNumber],
                ["Fecha de proceso", od.sendProductDate || od.sendingDate],
            ]},
            { titulo: "Datos de procesos de la operación", filas: [
                ["Código de solicitud", op.requestId],
                ["Preparada por", od.creator],
                ["Fecha de preparación", od.creationDate],
                ["Firmada por", od.firstSigner],
                ["Fecha de firma", od.firstSigningDate],
                ["Enviada por", od.sender],
                ["Fecha de envío", od.sendingDate],
            ]},
            { titulo: "Datos del servicio", filas: [
                ["Empresa", d.serviceProviderName],
                ["Servicio", d.providedServiceName],
                ["Código de suministro", d.consumerCode],
                ["Monto", formatMontoConSimbolo(d.totalAmount, moneda)],
            ]},
            { titulo: "Datos de la cuenta de origen", filas: [
                ["Titular", d.holderName],
                ["Cuenta", d.formattedAccountNumber],
                ["Tipo", d.accountType],
            ]},
        ]
    });
}

function htmlPagoDocumentos(op, d) {
    const ev = d.eventInfo || {};
    const cuenta = d.account || {};
    const adq = d.acquirer || {};
    const moneda = (d.currency && d.currency.value) || op.currencyCode;
    const docs = ((d.documentsInfo || {}).paidDocuments || {}).documents || [];

    const seccionesDocumentos = docs.map((doc, i) => ({
        titulo: docs.length > 1 ? `Documento ${i + 1}` : "Datos del documento",
        filas: [
            ["Proveedor", (doc.provider || {}).fullName],
            ["Número de documento", doc.prePrintedDocumentNumber],
            ["Número único", doc.uniqueDocumentNumber],
            ["Fecha de vencimiento", doc.dueDate],
            ["Importe", formatMontoConSimbolo(doc.amount, (doc.currency || {}).value || moneda)],
            ["Interés", formatMontoConSimbolo(doc.interestAmount, (doc.currency || {}).value || moneda)],
            ["Total", formatMontoConSimbolo(doc.totalAmount, (doc.currency || {}).value || moneda)],
        ]
    }));

    return plantilla({
        tituloEstado: `Consulta de Operaciones -  ${(d.approvalStatus || {}).description || "Procesada"}`,
        subtitulo: subtituloHoy(),
        secciones: [
            { titulo: "Datos de la operación", filas: [
                ["Tipo de operación", d.typeDescription || "Pago de letras y facturas"],
                ["Estado", (d.approvalStatus || {}).description || "Procesada", { dot: true }],
                ["Código de operación", d.paymentOperationCode],
                ["Fecha de proceso", formatFechaHora(d.paymentProcessDate)],
                ["Monto total", formatMontoConSimbolo(d.totalPaymentAmount, moneda)],
            ]},
            { titulo: "Datos de procesos de la operación", filas: [
                ["Código de solicitud", d.approvalOperationId || op.requestId],
                ["Preparada por", ev.creator],
                ["Fecha de preparación", formatFechaHora(ev.creationDate)],
                ["Firmada por", ev.firstSigner],
                ["Fecha de firma", formatFechaHora(ev.firstSigningDate)],
                ["Enviada por", ev.sender],
                ["Fecha de envío", formatFechaHora(ev.sendingDate)],
            ]},
            { titulo: "Datos de la cuenta de origen", filas: [
                ["Titular", adq.fullName],
                ["Documento", adq.documentType && adq.documentValue ? `${adq.documentType} ${adq.documentValue}` : ""],
                ["Cuenta", cuenta.formattedAccountNumber],
                ["Tipo", cuenta.description],
            ]},
            ...seccionesDocumentos,
        ]
    });
}

// Devuelve el HTML de la constancia según el tipo, o null si no está soportado.
function construirHtml(op, detalle) {
    if (!detalle) return null;
    if (op.product === "SERVICES_PAYMENT") return htmlPagoServicios(op, detalle);
    if (op.product === "PAYMENT_DOCUMENTS") return htmlPagoDocumentos(op, detalle);
    return null;
}

module.exports = { construirHtml };
