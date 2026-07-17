const btnAbrir = document.getElementById("btnAbrir");
const btnContinuar = document.getElementById("btnContinuar");
const btnBuscar = document.getElementById("btnBuscar");
const btnCarpeta = document.getElementById("btnCarpeta");

const estadoEl = document.getElementById("estado");
const progresoEl = document.getElementById("progreso");
const logEl = document.getElementById("log");

const fechaDesdeEl = document.getElementById("fechaDesde");
const fechaHastaEl = document.getElementById("fechaHasta");

// Valores por defecto: hoy y hace 7 días
const hoy = new Date();
const hace7 = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);

fechaHastaEl.value = hoy.toISOString().slice(0, 10);
fechaDesdeEl.value = hace7.toISOString().slice(0, 10);

function aDDMMYYYY(valorInputDate) {
    const [anio, mes, dia] = valorInputDate.split("-");
    return `${dia}-${mes}-${anio}`;
}

function agregarLog(tipo, texto) {
    const linea = document.createElement("div");
    linea.className = tipo;
    const prefijo = tipo === "ok" ? "✓ " : tipo === "omitido" ? "⏭ " : "✗ ";
    linea.textContent = prefijo + texto;
    logEl.appendChild(linea);
    logEl.scrollTop = logEl.scrollHeight;
}

btnAbrir.addEventListener("click", () => {
    btnAbrir.disabled = true;
    estadoEl.textContent = "Abriendo navegador...";
    window.api.abrirNavegador();
});

btnContinuar.addEventListener("click", () => {
    btnContinuar.disabled = true;
    btnBuscar.disabled = false;
    estadoEl.textContent = "Listo. Elige las fechas y presiona 'Buscar y descargar constancias'.";
});

btnBuscar.addEventListener("click", () => {

    if (!fechaDesdeEl.value || !fechaHastaEl.value) {
        estadoEl.textContent = "Selecciona ambas fechas antes de continuar.";
        return;
    }

    btnBuscar.disabled = true;
    logEl.innerHTML = "";
    progresoEl.textContent = "";

    window.api.buscarYDescargar(
        aDDMMYYYY(fechaDesdeEl.value),
        aDDMMYYYY(fechaHastaEl.value)
    );
});

btnCarpeta.addEventListener("click", () => {
    window.api.abrirCarpeta();
});

window.api.onEstado((msg) => {
    estadoEl.textContent = msg;
});

window.api.onNavegadorListo(() => {
    btnContinuar.disabled = false;
});

window.api.onLog((datos) => {
    agregarLog(datos.tipo, datos.texto);
});

window.api.onProgreso((datos) => {
    progresoEl.textContent = `Procesadas: ${datos.actual} — Página ${datos.pagina} de ${datos.totalPaginas}`;
});

window.api.onFinalizado((datos) => {
    estadoEl.textContent = `Terminado: ${datos.exitosas} descargadas, ${datos.fallidas} con error.`;
    progresoEl.textContent = `Carpeta: ${datos.carpeta}`;
    btnBuscar.disabled = false;
});

window.api.onErrorFatal((msg) => {
    estadoEl.textContent = "Error: " + msg;
    btnAbrir.disabled = false;
    btnBuscar.disabled = false;
});
