const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {

    abrirNavegador: () => ipcRenderer.send("abrir-navegador"),
    buscarYDescargar: (fechaDesde, fechaHasta) =>
        ipcRenderer.send("buscar-y-descargar", { fechaDesde, fechaHasta }),
    abrirCarpeta: () => ipcRenderer.send("abrir-carpeta"),

    onEstado: (cb) => ipcRenderer.on("estado", (_e, msg) => cb(msg)),
    onNavegadorListo: (cb) => ipcRenderer.on("navegador-listo", () => cb()),
    onLog: (cb) => ipcRenderer.on("log", (_e, datos) => cb(datos)),
    onProgreso: (cb) => ipcRenderer.on("progreso", (_e, datos) => cb(datos)),
    onFinalizado: (cb) => ipcRenderer.on("finalizado", (_e, datos) => cb(datos)),
    onErrorFatal: (cb) => ipcRenderer.on("error-fatal", (_e, msg) => cb(msg))

});
