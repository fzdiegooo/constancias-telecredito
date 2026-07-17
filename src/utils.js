function limpiar(nombre) {

    return nombre
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();

}

function fechaArchivo(iso) {

    const d = new Date(iso);

    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    const anio = d.getFullYear();

    return `${anio}-${mes}-${dia}`;
}

function formatMonto(monto) {

    return Number(monto).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

module.exports = {
    limpiar,
    fechaArchivo,
    formatMonto
};