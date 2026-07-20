// Script de consola: solo abre/conecta el navegador y deja la sesión lista
// para que el usuario inicie sesión manualmente. No aplica filtros ni descarga.
// Uso: node src/abrir.js

const { connect } = require("./connect");

(async () => {

    await connect(msg => console.log(msg));

    console.log("Navegador listo. Inicia sesión en el banco con tu tarjeta y clave.");

})();
