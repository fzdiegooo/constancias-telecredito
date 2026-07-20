const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CDP_URL = 'http://127.0.0.1:9222';
const URL_BANCO = 'https://www.tlcbcp.com';

function encontrarNavegador() {

    const candidatos = [];

    if (process.platform === 'win32') {

        const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const local = process.env['LOCALAPPDATA'] || '';

        candidatos.push(
            path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
            path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')
        );

    } else if (process.platform === 'darwin') {

        candidatos.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        );

    } else {

        candidatos.push(
            'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave', 'brave-browser', 'microsoft-edge'
        );
    }

    const commandExists = (cmd) => {
        if (path.isAbsolute(cmd)) {
            try { return fs.existsSync(cmd); } catch { return false; }
        }
        const pathDirs = (process.env.PATH || '').split(path.delimiter);
        for (const dir of pathDirs) {
            const fullPath = path.join(dir, cmd);
            try {
                if (fs.existsSync(fullPath)) {
                    return true;
                }
            } catch { }
        }
        return false;
    };

    return candidatos.find(commandExists) || candidatos[candidatos.length - 1];
}

async function intentarConectar() {

    try {
        return await chromium.connectOverCDP(CDP_URL);
    } catch {
        return null;
    }
}

// La automatización funciona vía CDP (clics, navegación, page.pdf(), etc.)
// sin importar si la ventana está minimizada o en primer plano — el
// protocolo habla directo con el renderer, no simula input a nivel del
// sistema operativo. Minimizamos la ventana para que el usuario pueda
// seguir usando su pantalla mientras el script corre en segundo plano.
async function minimizarVentana(context, page) {

    try {
        const session = await context.newCDPSession(page);
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch {
        // Si falla (navegador no soporta el comando, etc.) seguimos igual
        // sin minimizar; no es crítico para el funcionamiento del script.
    }
}

function lanzarNavegador() {

    const ejecutable = encontrarNavegador();
    const perfil = path.join(os.tmpdir(), 'constancias-telecredito-perfil');

    spawn(ejecutable, [
        '--remote-debugging-port=9222',
        `--user-data-dir=${perfil}`,
        '--no-first-run',
        '--no-default-browser-check',
        URL_BANCO
    ], { detached: true, stdio: 'ignore' }).unref();
}

// onEstado(mensaje) es opcional, para reportar progreso a una interfaz gráfica.
async function connect(onEstado) {

    let browser = await intentarConectar();

    if (!browser) {

        if (onEstado) onEstado('Abriendo el navegador...');

        lanzarNavegador();

        for (let intento = 0; intento < 40 && !browser; intento++) {
            await new Promise(r => setTimeout(r, 500));
            browser = await intentarConectar();
        }

        if (!browser) {
            throw new Error('No se pudo abrir el navegador. Verifica que Google Chrome o Microsoft Edge estén instalados.');
        }
    }

    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    if (!page.url().includes('tlcbcp.com')) {
        await page.goto(URL_BANCO);
    }

    return { browser, page };
}

module.exports = { connect, minimizarVentana };
