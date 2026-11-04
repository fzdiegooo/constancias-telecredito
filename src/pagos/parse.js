// Parser del "Cuadro de pagos" (PDF) a filas estructuradas.
//
// Usa `pdftotext -layout` (poppler) para conservar las columnas de la tabla y
// luego extrae, por cada fila de agricultor: guía de ingreso, nombre, cuenta
// BCP destino y el monto PAGO (lo que realmente se transfiere, ya descontado
// el adelanto). No ejecuta nada: solo lee el PDF.

const { execFileSync } = require("child_process");

// Un token de dinero del cuadro: "S/. 2,229.40", "-S/. 15.68" o "S/. -".
// Capturamos el signo (adelanto > total deja el PAGO en negativo) y el valor.
const MONTO = /(-)?\s*S\/\.\s+([\d.,]+|-)/g;
// Cuenta BCP en formato del cuadro: 401-92832274-0-56. Si la celda trae "0"
// (cuenta faltante) no coincide y la fila queda con cuenta = null.
const CUENTA = /(\d{3}-\d{8}-\d-\d{2})/;
// Inicio de fila: guía (001-004371) + fecha + GRR (EG07-...).
const INICIO = /^(\d{3}-\d{6})\s+(\d{2}\/\d{2}\/\d{4})\s+(\S+)\s+(.*)$/;

function aNumero(txt) {
    if (!txt || txt === "-") return 0;
    return Number(txt.replace(/,/g, ""));
}

// Cuenta "401-92832274-0-56" -> "40192832274056" (lo que pide la API).
function cuentaApi(cuentaCuadro) {
    return cuentaCuadro ? cuentaCuadro.replace(/-/g, "") : null;
}

// Referencia que el banco pone en la transferencia: "GI1 " + últimos 4 dígitos
// de la guía (001-004371 -> "GI1 4371"). Verificado contra transferencias reales.
function referencia(guia) {
    return `GI1 ${guia.slice(-4)}`;
}

function parsearLinea(linea) {
    const m = INICIO.exec(linea);
    if (!m) return null;

    const [, guia, fecha, grr, resto] = m;

    const cuentaM = CUENTA.exec(resto);
    const cuentaCuadro = cuentaM ? cuentaM[1] : null;

    // Nombre: todo lo que va entre el GRR y el producto/cuenta. El producto
    // (p.ej. "jengibre") es la última palabra antes de la cuenta o del dinero.
    const corte = cuentaM ? resto.indexOf(cuentaM[1]) : resto.search(/\s-?\s*S\/\./);
    const previo = (corte >= 0 ? resto.slice(0, corte) : resto).trim().split(/\s{2,}/);
    // previo = [NOMBRE, PRODUCTO] (separados por 2+ espacios en el -layout).
    const nombre = (previo[0] || "").trim();
    const producto = (previo[1] || "").trim() || null;

    const montos = [...resto.matchAll(MONTO)].map(x => ({ neg: x[1] === "-", val: aNumero(x[2]) }));
    // Orden de columnas de dinero: TOTAL, ADELANTO, PAGO.
    const total = montos[0] ? montos[0].val : 0;
    const adelanto = montos[1] ? montos[1].val : 0;
    const pagoTok = montos[2] || montos[montos.length - 1] || { neg: false, val: 0 };
    const pago = pagoTok.neg ? -pagoTok.val : pagoTok.val;

    return {
        guia,
        fecha,
        grr,
        nombre,
        producto,
        cuentaCuadro,
        cuenta: cuentaApi(cuentaCuadro),
        total,
        adelanto,
        pago,
        referencia: referencia(guia),
    };
}

// Devuelve { filas, saltadas } donde `filas` son transferibles (pago > 0 y
// cuenta presente) y `saltadas` traen el motivo por el que no se transfieren.
function parsearCuadro(pdfPath) {
    const texto = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });

    const filas = [];
    const saltadas = [];
    for (const linea of texto.split("\n")) {
        const fila = parsearLinea(linea);
        if (!fila) continue;

        let motivo = null;
        if (!fila.cuenta) motivo = "sin cuenta BCP en el cuadro";
        else if (fila.pago <= 0) motivo = `PAGO no positivo (${fila.pago.toFixed(2)})`;

        if (motivo) saltadas.push({ ...fila, motivo });
        else filas.push(fila);
    }
    return { filas, saltadas };
}

module.exports = { parsearCuadro, referencia, cuentaApi };

if (require.main === module) {
    const pdf = process.argv[2];
    if (!pdf) { console.error("uso: node src/pagos/parse.js <cuadro.pdf>"); process.exit(1); }
    const { filas, saltadas } = parsearCuadro(pdf);
    console.log(`\nTransferibles: ${filas.length}`);
    let suma = 0;
    for (const f of filas) {
        suma += f.pago;
        console.log(`  ${f.guia}  ${f.cuenta}  S/ ${f.pago.toFixed(2).padStart(10)}  ${f.referencia}  ${f.nombre}`);
    }
    console.log(`  TOTAL transferible: S/ ${suma.toFixed(2)}`);
    console.log(`\nSaltadas: ${saltadas.length}`);
    for (const s of saltadas)
        console.log(`  ${s.guia}  ${s.nombre}  — ${s.motivo}`);
}
